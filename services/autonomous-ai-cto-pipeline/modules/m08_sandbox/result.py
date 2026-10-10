
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


ExecutionStatus = Literal[
    "queued",
    "running",
    "passed",
    "failed",
    "timeout",
    "cancelled",
]


class ExecutionResult(BaseModel):
    execution_id: str
    project_id: str
    task_id: str

    status: ExecutionStatus

    exit_code: int | None = None

    stdout: str = ""
    stderr: str = ""

    duration_ms: int | None = None
    error_type: str | None = None

    started_at: datetime | None = None
    finished_at: datetime | None = None

    metadata: dict[str, Any] = Field(default_factory=dict)