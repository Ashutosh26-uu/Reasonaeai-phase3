from pathlib import Path

from modules.m07_shared_state.retry_history import (
    InMemoryRetryHistoryRepository,
)
from modules.m09_qa.repair_handoff import (
    RepairHandoffRequest,
    RepairHandoffResult,
)

from modules.m09_qa.bug_classifier import BugReport
from modules.m09_qa.repair_task import RepairTask
from modules.m09_qa.reliability_coordinator import (
    ReliabilityCoordinator,
)
from modules.m09_qa.report import QAReport
from modules.m09_qa.retry_decision import (
    RetryDecisionEngine,
    RetryPolicy,
)


class FakeQARunner:
    def __init__(self, reports: list[QAReport]) -> None:
        self.reports = reports
        self.index = 0

    def run(
        self,
        project_path: str | Path,
        command: list[str],
        project_id: str,
        task_id: str,
    ) -> QAReport:
        report = self.reports[self.index]
        self.index += 1
        return report
    
class FakeRepairHandoff:
    def __init__(
        self,
        success: bool = True,
        modified_project_path: Path = Path("repaired_project"),
    ) -> None:
        self.success = success
        self.modified_project_path = modified_project_path
        self.requests: list[RepairHandoffRequest] = []

    def apply_repair(
        self,
        request: RepairHandoffRequest,
    ) -> RepairHandoffResult:
        self.requests.append(request)

        return RepairHandoffResult(
            repair_task_id=request.repair_task.repair_task_id,
            success=self.success,
            message="Repair applied" if self.success else "Repair failed",
            modified_project_path=self.modified_project_path,
        )

def make_report(
    status: str,
    bugs: list[BugReport] | None = None,
    execution_id: str = "exec_test",
) -> QAReport:
    return QAReport(
        report_id="report_test",
        project_id="project_test",
        task_id="task_test",
        status=status,
        execution_id=execution_id,
        issues_found=len(bugs or []),
        issues=[bug.message for bug in bugs or []],
        bugs=bugs or [],
        stdout="",
        stderr="",
        duration_ms=10,
    )


def test_success_without_retry() -> None:
    history = InMemoryRetryHistoryRepository()
    runner = FakeQARunner(
        [
            make_report("passed"),
        ]
    )

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=3)),
        history_repository=history,
    )

    result = coordinator.run(
        project_path=".",
        command=["python", "--version"],
    )

    assert result.status == "passed"
    assert result.attempts == 1
    assert result.retry_count == 0

    records = history.get_task_history("project_test", "task_test")
    assert len(records) == 1
    assert records[0].attempt_number == 1
    assert records[0].bug_type is None
    assert records[0].decision == "stop"
    assert records[0].execution_status == "passed"


def test_retry_then_success() -> None:
    history = InMemoryRetryHistoryRepository()
    bug = BugReport(
        bug_type="import_error",
        message="Missing dependency",
        retryable=True,
    )

    runner = FakeQARunner(
        [
            make_report("failed", [bug], execution_id="exec_attempt_1"),
            make_report("passed", execution_id="exec_attempt_2"),
        ]
    )

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=3)),
        history_repository=history,
    )

    result = coordinator.run(
        project_path=".",
        command=["python", "--version"],
    )

    assert result.status == "passed"
    assert result.attempts == 2
    assert result.retry_count == 1
    assert len(result.repair_tasks) == 1

    repair_task = result.repair_tasks[0]

    assert isinstance(repair_task, RepairTask)
    assert repair_task.repair_task_id == (
        "repair_project_test_task_test_attempt_2"
    )
    assert repair_task.parent_task_id == "task_test"
    assert repair_task.project_id == "project_test"
    assert repair_task.attempt_number == 2
    assert repair_task.bug_type == "import_error"
    assert repair_task.error_message == "Missing dependency"
    assert repair_task.priority == "high"
    assert repair_task.repair_instructions == (
        "Fix the missing or invalid import reported by QA, "
        "then rerun the task."
    )

    records = history.get_task_history("project_test", "task_test")
    assert len(records) == 2
    assert records[0].attempt_number == 1
    assert records[0].execution_id == "exec_attempt_1"
    assert records[0].bug_type == "import_error"
    assert records[0].decision == "retry"
    assert records[0].execution_status == "failed"
    assert records[1].attempt_number == 2
    assert records[1].execution_id == "exec_attempt_2"
    assert records[1].bug_type is None
    assert records[1].decision == "stop"
    assert records[1].execution_status == "passed"


def test_non_retryable_bug_escalates() -> None:
    history = InMemoryRetryHistoryRepository()
    bug = BugReport(
        bug_type="syntax_error",
        message="Invalid syntax",
        retryable=False,
    )

    runner = FakeQARunner(
        [
            make_report("failed", [bug]),
        ]
    )

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=3)),
        history_repository=history,
    )

    result = coordinator.run(
        project_path=".",
        command=["python", "--version"],
    )

    assert result.status == "escalated"
    assert result.attempts == 1
    assert result.retry_count == 0

    records = history.get_task_history("project_test", "task_test")
    assert len(records) == 1
    assert records[0].attempt_number == 1
    assert records[0].bug_type == "syntax_error"
    assert records[0].decision == "escalate"
    assert records[0].execution_status == "failed"


def test_retry_limit_escalates() -> None:
    history = InMemoryRetryHistoryRepository()
    bug = BugReport(
        bug_type="import_error",
        message="Missing dependency",
        retryable=True,
    )

    runner = FakeQARunner(
        [
            make_report("failed", [bug], execution_id="exec_attempt_1"),
            make_report("failed", [bug], execution_id="exec_attempt_2"),
            make_report("failed", [bug], execution_id="exec_attempt_3"),
        ]
    )

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=2)),
        history_repository=history,
    )

    result = coordinator.run(
        project_path=".",
        command=["python", "--version"],
    )

    assert result.status == "escalated"
    assert result.attempts == 3
    assert result.retry_count == 2

    records = history.get_task_history("project_test", "task_test")
    assert len(records) == 3
    assert [record.attempt_number for record in records] == [1, 2, 3]
    assert [record.execution_id for record in records] == [
        "exec_attempt_1",
        "exec_attempt_2",
        "exec_attempt_3",
    ]
    assert [record.decision for record in records] == [
        "retry",
        "retry",
        "escalate",
    ]


def test_multiple_retries_generate_separate_repair_tasks() -> None:
    history = InMemoryRetryHistoryRepository()

    bug = BugReport(
        bug_type="import_error",
        message="Missing dependency",
        retryable=True,
    )

    runner = FakeQARunner(
        [
            make_report("failed", [bug], execution_id="exec_attempt_1"),
            make_report("failed", [bug], execution_id="exec_attempt_2"),
            make_report("passed", execution_id="exec_attempt_3"),
        ]
    )

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=3)),
        history_repository=history,
    )

    result = coordinator.run(
        project_path=".",
        command=["python", "--version"],
    )

    assert result.status == "passed"
    assert result.attempts == 3
    assert result.retry_count == 2

    assert len(result.repair_tasks) == 2

    first, second = result.repair_tasks

    assert first.repair_task_id == (
        "repair_project_test_task_test_attempt_2"
    )
    assert first.attempt_number == 2
    assert first.parent_task_id == "task_test"

    assert second.repair_task_id == (
        "repair_project_test_task_test_attempt_3"
    )
    assert second.attempt_number == 3
    assert second.parent_task_id == "task_test"

    assert first.repair_task_id != second.repair_task_id

    records = history.get_task_history("project_test", "task_test")

    assert [record.decision for record in records] == [
        "retry",
        "retry",
        "stop",
    ]

def test_successful_repair_handoff_then_qa_passes() -> None:
    history = InMemoryRetryHistoryRepository()
    bug = BugReport(
        bug_type="import_error",
        message="Missing dependency",
        retryable=True,
    )

    repaired_path = Path("repaired_project")
    runner = FakeQARunner(
        [
            make_report("failed", [bug], execution_id="exec_attempt_1"),
            make_report("passed", execution_id="exec_attempt_2"),
        ]
    )
    handoff = FakeRepairHandoff(
        success=True,
        modified_project_path=repaired_path,
    )

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=3)),
        history_repository=history,
        repair_handoff=handoff,
    )

    result = coordinator.run(
        project_path="original_project",
        command=["python", "--version"],
    )

    assert result.status == "passed"
    assert result.attempts == 2
    assert len(result.repair_tasks) == 1
    assert len(handoff.requests) == 1
    assert len(result.handoff_results) == 1

    request = handoff.requests[0]
    assert request.repair_task == result.repair_tasks[0]
    assert request.project_path == Path("original_project")

    assert result.handoff_results[0].success is True

    # Verify QA was called again using the repaired project.
    assert runner.index == 2

def test_failed_repair_handoff_escalates() -> None:
    history = InMemoryRetryHistoryRepository()
    bug = BugReport(
        bug_type="import_error",
        message="Missing dependency",
        retryable=True,
    )

    runner = FakeQARunner(
        [
            make_report("failed", [bug], execution_id="exec_attempt_1"),
        ]
    )
    handoff = FakeRepairHandoff(success=False)

    coordinator = ReliabilityCoordinator(
        qa_runner=runner,
        retry_engine=RetryDecisionEngine(RetryPolicy(max_retries=3)),
        history_repository=history,
        repair_handoff=handoff,
    )

    result = coordinator.run(
        project_path="original_project",
        command=["python", "--version"],
    )

    assert result.status == "escalated"
    assert result.attempts == 1
    assert result.retry_count == 0
    assert len(result.repair_tasks) == 1
    assert len(handoff.requests) == 1
    assert len(result.handoff_results) == 1
    assert result.handoff_results[0].success is False

    # QA must not rerun after a failed repair.
    assert runner.index == 1

    records = history.get_task_history("project_test", "task_test")
    assert len(records) == 1
    assert records[0].decision == "escalate"