from typing import Literal

from pydantic import BaseModel, Field

from modules.m09_qa.bug_classifier import BugReport


QAStatus = Literal["passed", "failed", "timeout", "error"]


class QAReport(BaseModel):
    report_id: str
    project_id: str
    task_id: str
    status: QAStatus
    execution_id: str | None = None
    issues_found: int = 0
    issues: list[str] = Field(default_factory=list)
    bugs: list[BugReport] = Field(default_factory=list)
    stdout: str = ""
    stderr: str = ""
    duration_ms: int | None = None