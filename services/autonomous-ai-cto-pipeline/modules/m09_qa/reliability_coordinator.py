"""M09 reliability coordinator."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from modules.m07_shared_state.retry_history import (
    ExecutionStatus,
    RetryDecision as HistoryDecision,
    RetryHistoryRepository,
    create_retry_history_record,
)
from modules.m09_qa.bug_classifier import BugReport
from modules.m09_qa.repair_handoff import (
    RepairHandoff,
    RepairHandoffRequest,
    RepairHandoffResult,
)
from modules.m09_qa.repair_task import RepairTask, RepairTaskGenerator
from modules.m09_qa.retry_decision import RetryDecisionEngine
from modules.m09_qa.runner import QARunner
from modules.m10_interaction.progress import create_progress_event


ProgressCallback = Callable[[object], None]


@dataclass
class ReliabilityResult:
    """Final result of the reliability loop."""

    status: str
    attempts: int
    retry_count: int
    final_report: object
    repair_tasks: list[RepairTask] = field(default_factory=list)
    handoff_results: list[RepairHandoffResult] = field(default_factory=list)


class ReliabilityCoordinator:
    """Coordinates QA, retries, repair handoff, history, and progress."""

    def __init__(
        self,
        qa_runner: QARunner,
        retry_engine: RetryDecisionEngine,
        history_repository: RetryHistoryRepository,
        progress_callback: ProgressCallback | None = None,
        repair_task_generator: RepairTaskGenerator | None = None,
        repair_handoff: RepairHandoff | None = None,
    ) -> None:
        self.qa_runner = qa_runner
        self.retry_engine = retry_engine
        self.history_repository = history_repository
        self.progress_callback = progress_callback
        self.repair_task_generator = (
            repair_task_generator or RepairTaskGenerator()
        )
        self.repair_handoff = repair_handoff

    def _emit(
        self,
        execution_id: str,
        project_id: str,
        task_id: str,
        status: str,
        message: str,
        attempt_number: int,
    ) -> None:
        """Emit a progress event when a callback is configured."""

        if self.progress_callback is None:
            return

        event = create_progress_event(
            execution_id=execution_id,
            project_id=project_id,
            task_id=task_id,
            status=status,
            message=message,
            attempt_number=attempt_number,
        )
        self.progress_callback(event)

    def _record_history(
        self,
        *,
        project_id: str,
        task_id: str,
        execution_id: str,
        attempt_number: int,
        bug_type: str | None,
        decision: HistoryDecision,
        execution_status: ExecutionStatus,
    ) -> None:
        """Persist one execution attempt in M07."""

        record = create_retry_history_record(
            project_id=project_id,
            task_id=task_id,
            execution_id=execution_id,
            attempt_number=attempt_number,
            bug_type=bug_type,
            decision=decision,
            execution_status=execution_status,
        )
        self.history_repository.record(record)

    def run(
        self,
        project_path: str | Path,
        command: list[str],
        project_id: str = "local-project",
        task_id: str = "local-task",
    ) -> ReliabilityResult:
        """Run QA until success, retry limit, or escalation."""

        coordination_execution_id = f"coord_{project_id}_{task_id}"
        current_project_path = Path(project_path)

        attempt_number = 1
        repair_tasks: list[RepairTask] = []
        handoff_results: list[RepairHandoffResult] = []

        self._emit(
            execution_id=coordination_execution_id,
            project_id=project_id,
            task_id=task_id,
            status="started",
            message="Reliability workflow started",
            attempt_number=attempt_number,
        )

        while True:
            self._emit(
                execution_id=coordination_execution_id,
                project_id=project_id,
                task_id=task_id,
                status="running",
                message=f"Running QA attempt {attempt_number}",
                attempt_number=attempt_number,
            )

            report = self.qa_runner.run(
                project_path=current_project_path,
                command=command,
                project_id=project_id,
                task_id=task_id,
            )

            report_project_id = report.project_id
            report_task_id = report.task_id
            execution_id = report.execution_id or coordination_execution_id

            if report.status == "passed":
                self._record_history(
                    project_id=report_project_id,
                    task_id=report_task_id,
                    execution_id=execution_id,
                    attempt_number=attempt_number,
                    bug_type=None,
                    decision="stop",
                    execution_status="passed",
                )

                self._emit(
                    execution_id=execution_id,
                    project_id=report_project_id,
                    task_id=report_task_id,
                    status="passed",
                    message=f"QA passed on attempt {attempt_number}",
                    attempt_number=attempt_number,
                )

                return ReliabilityResult(
                    status="passed",
                    attempts=attempt_number,
                    retry_count=attempt_number - 1,
                    final_report=report,
                    repair_tasks=repair_tasks,
                    handoff_results=handoff_results,
                )

            bug: BugReport | None = None

            if getattr(report, "bugs", None):
                bug = report.bugs[0]

            if bug is None:
                self._record_history(
                    project_id=report_project_id,
                    task_id=report_task_id,
                    execution_id=execution_id,
                    attempt_number=attempt_number,
                    bug_type=None,
                    decision="escalate",
                    execution_status=report.status,
                )

                self._emit(
                    execution_id=execution_id,
                    project_id=report_project_id,
                    task_id=report_task_id,
                    status="escalated",
                    message="QA failed without a classified bug; escalating",
                    attempt_number=attempt_number,
                )

                return ReliabilityResult(
                    status="escalated",
                    attempts=attempt_number,
                    retry_count=attempt_number - 1,
                    final_report=report,
                    repair_tasks=repair_tasks,
                    handoff_results=handoff_results,
                )

            decision = self.retry_engine.decide(
                bug=bug,
                retry_count=attempt_number - 1,
            )

            if decision.decision != "retry":
                self._record_history(
                    project_id=report_project_id,
                    task_id=report_task_id,
                    execution_id=execution_id,
                    attempt_number=attempt_number,
                    bug_type=bug.bug_type,
                    decision="escalate",
                    execution_status=report.status,
                )

                self._emit(
                    execution_id=execution_id,
                    project_id=report_project_id,
                    task_id=report_task_id,
                    status="escalated",
                    message=(
                        f"Attempt {attempt_number} failed with "
                        f"{bug.bug_type}; escalating"
                    ),
                    attempt_number=attempt_number,
                )

                return ReliabilityResult(
                    status="escalated",
                    attempts=attempt_number,
                    retry_count=attempt_number - 1,
                    final_report=report,
                    repair_tasks=repair_tasks,
                    handoff_results=handoff_results,
                )

            next_attempt_number = attempt_number + 1

            repair_task = self.repair_task_generator.generate(
                bug=bug,
                project_id=report_project_id,
                parent_task_id=report_task_id,
                attempt_number=next_attempt_number,
            )
            repair_tasks.append(repair_task)

            # If a repair worker is configured, apply the repair
            # before starting the next QA attempt.
            if self.repair_handoff is not None:
                self._emit(
                    execution_id=execution_id,
                    project_id=report_project_id,
                    task_id=report_task_id,
                    status="running",
                    message=f"Handing off repair task {repair_task.repair_task_id}",
                    attempt_number=attempt_number,
                )

                try:
                    handoff_result = self.repair_handoff.apply_repair(
                        RepairHandoffRequest(
                            repair_task=repair_task,
                            project_path=current_project_path,
                        )
                    )
                    handoff_results.append(handoff_result)

                    if (
                        handoff_result.repair_task_id
                        != repair_task.repair_task_id
                        or not handoff_result.success
                    ):
                        raise RuntimeError("Repair handoff was unsuccessful")

                    current_project_path = handoff_result.modified_project_path

                except Exception:
                    self._record_history(
                        project_id=report_project_id,
                        task_id=report_task_id,
                        execution_id=execution_id,
                        attempt_number=attempt_number,
                        bug_type=bug.bug_type,
                        decision="escalate",
                        execution_status=report.status,
                    )

                    self._emit(
                        execution_id=execution_id,
                        project_id=report_project_id,
                        task_id=report_task_id,
                        status="escalated",
                        message=(
                            f"Repair handoff failed for "
                            f"{repair_task.repair_task_id}; escalating"
                        ),
                        attempt_number=attempt_number,
                    )

                    return ReliabilityResult(
                        status="escalated",
                        attempts=attempt_number,
                        retry_count=attempt_number - 1,
                        final_report=report,
                        repair_tasks=repair_tasks,
                        handoff_results=handoff_results,
                    )

            self._record_history(
                project_id=report_project_id,
                task_id=report_task_id,
                execution_id=execution_id,
                attempt_number=attempt_number,
                bug_type=bug.bug_type,
                decision="retry",
                execution_status=report.status,
            )

            self._emit(
                execution_id=execution_id,
                project_id=report_project_id,
                task_id=report_task_id,
                status="failed",
                message=(
                    f"Attempt {attempt_number} failed with "
                    f"{bug.bug_type}; repair task "
                    f"{repair_task.repair_task_id} created; retrying"
                ),
                attempt_number=attempt_number,
            )

            attempt_number = next_attempt_number