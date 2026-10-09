"""M10 interaction and progress models."""

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


ProgressStatus = Literal[
    "started",
    "running",
    "passed",
    "failed",
    "timeout",
    "escalated",
]


class ProgressEvent(BaseModel):
    """Represents a timestamped execution progress event."""

    execution_id: str
    project_id: str = ""
    task_id: str = ""

    status: ProgressStatus
    message: str

    attempt_number: int = Field(default=1, ge=1)

    timestamp: datetime


def create_progress_event(
    execution_id: str,
    status: ProgressStatus,
    message: str,
    project_id: str = "",
    task_id: str = "",
    attempt_number: int = 1,
) -> ProgressEvent:
    """Create a timestamped progress event."""

    return ProgressEvent(
        execution_id=execution_id,
        project_id=project_id,
        task_id=task_id,
        status=status,
        message=message,
        attempt_number=attempt_number,
        timestamp=datetime.now(timezone.utc),
    )