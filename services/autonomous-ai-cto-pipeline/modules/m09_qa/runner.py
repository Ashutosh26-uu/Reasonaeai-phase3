
"""MVP QA runner built on top of the Docker executor."""

from __future__ import annotations

import uuid
from pathlib import Path

from modules.m08_sandbox.executor import DockerExecutor
from modules.m08_sandbox.result import ExecutionResult
from modules.m09_qa.bug_classifier import classify_bug
from modules.m09_qa.report import QAReport


class QARunner:
    def __init__(self, executor: DockerExecutor | None = None) -> None:
        self.executor = executor or DockerExecutor()

    def run(
        self,
        project_path: str | Path,
        command: list[str],
        project_id: str = "local-project",
        task_id: str = "local-task",
    ) -> QAReport:
        execution_result = self.executor.execute(
            project_path=project_path,
            command=command,
            project_id=project_id,
            task_id=task_id,
        )

        return self._build_report(
            execution_result=execution_result,
            project_id=project_id,
            task_id=task_id,
        )

    @staticmethod
    def _build_report(
        execution_result: ExecutionResult,
        project_id: str,
        task_id: str,
    ) -> QAReport:
        report_id = f"report_{uuid.uuid4().hex[:12]}"

        bugs = []

        if execution_result.status == "passed":
            status = "passed"
            issues: list[str] = []

        elif execution_result.status == "timeout":
            status = "timeout"
            bug = classify_bug(
                execution_result.stderr,
                execution_result.error_type,
            )
            bugs = [bug]
            issues = [bug.message]

        elif execution_result.status == "failed":
            status = "failed"
            bug = classify_bug(
                execution_result.stderr,
                execution_result.error_type,
            )
            bugs = [bug]
            issues = [bug.message]

        else:
            status = "error"
            bug = classify_bug(
                execution_result.stderr,
                execution_result.error_type,
            )
            bugs = [bug]
            issues = [bug.message]

        return QAReport(
            report_id=report_id,
            project_id=project_id,
            task_id=task_id,
            status=status,
            execution_id=execution_result.execution_id,
            issues_found=len(issues),
            issues=issues,
            bugs=bugs,
            stdout=execution_result.stdout,
            stderr=execution_result.stderr,
            duration_ms=execution_result.duration_ms,
        )