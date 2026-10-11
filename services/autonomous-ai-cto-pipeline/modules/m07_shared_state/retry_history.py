"""M07 shared-state retry history.

Provides a storage abstraction for recording and retrieving
execution retry history.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Literal


RetryDecision = Literal["retry", "escalate", "stop"]

ExecutionStatus = Literal[
    "queued",
    "running",
    "passed",
    "failed",
    "timeout",
    "error",
    "cancelled",
]


@dataclass(frozen=True)
class RetryHistoryRecord:
    """Immutable record describing one execution attempt."""

    project_id: str
    task_id: str
    execution_id: str
    attempt_number: int

    bug_type: str | None
    decision: RetryDecision
    execution_status: ExecutionStatus

    timestamp: datetime


class RetryHistoryRepository:
    """Repository interface for retry history."""

    def record(self, record: RetryHistoryRecord) -> None:
        """Persist one retry-history record."""
        raise NotImplementedError

    def get_task_history(
        self,
        project_id: str,
        task_id: str,
    ) -> list[RetryHistoryRecord]:
        """Return retry history for a task."""
        raise NotImplementedError

    def get_latest_attempt(
        self,
        project_id: str,
        task_id: str,
    ) -> RetryHistoryRecord | None:
        """Return the latest recorded attempt for a task."""
        raise NotImplementedError


class InMemoryRetryHistoryRepository(RetryHistoryRepository):
    """Thread-safe in-memory retry history implementation.

    This implementation is intended for the MVP and tests.
    A persistent M07 backend can implement the same repository
    interface later.
    """

    def __init__(self) -> None:
        self._records: list[RetryHistoryRecord] = []
        self._lock = Lock()

    def record(self, record: RetryHistoryRecord) -> None:
        """Store a retry-history record."""

        if record.attempt_number < 1:
            raise ValueError("attempt_number must be >= 1")

        with self._lock:
            self._records.append(record)

    def get_task_history(
        self,
        project_id: str,
        task_id: str,
    ) -> list[RetryHistoryRecord]:
        """Return records for a project/task pair."""

        with self._lock:
            records = [
                record
                for record in self._records
                if record.project_id == project_id
                and record.task_id == task_id
            ]

        return sorted(
            records,
            key=lambda record: record.attempt_number,
        )

    def get_latest_attempt(
        self,
        project_id: str,
        task_id: str,
    ) -> RetryHistoryRecord | None:
        """Return the most recent attempt."""

        history = self.get_task_history(
            project_id=project_id,
            task_id=task_id,
        )

        if not history:
            return None

        return history[-1]


def create_retry_history_record(
    *,
    project_id: str,
    task_id: str,
    execution_id: str,
    attempt_number: int,
    bug_type: str | None,
    decision: RetryDecision,
    execution_status: ExecutionStatus,
) -> RetryHistoryRecord:
    """Create a timestamped retry-history record."""

    if attempt_number < 1:
        raise ValueError("attempt_number must be >= 1")

    return RetryHistoryRecord(
        project_id=project_id,
        task_id=task_id,
        execution_id=execution_id,
        attempt_number=attempt_number,
        bug_type=bug_type,
        decision=decision,
        execution_status=execution_status,
        timestamp=datetime.now(timezone.utc),
    )

