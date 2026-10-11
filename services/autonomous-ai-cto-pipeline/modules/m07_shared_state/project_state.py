"""M07 shared-state project storage.

Provides storage abstractions for the project specification (M02
output), versioned architecture (M03 output), and per-task execution
results (M04/M05/M06 output), following the same pattern as
retry_history.py: an immutable record, a repository interface, and a
thread-safe in-memory implementation intended for the MVP and tests.
A persistent M07 backend can implement the same repository
interfaces later.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Literal


TaskStatus = Literal["success", "failed", "in_progress"]


@dataclass(frozen=True)
class ProjectSpecificationRecord:
    """Immutable record of one M02 requirements-generation result."""

    project_id: str
    raw_idea: str
    requirements: dict[str, Any]
    timestamp: datetime


@dataclass(frozen=True)
class ArchitectureRecord:
    """Immutable record of one M03 architecture-generation result.

    `version` starts at 1 for a project's first saved architecture and
    increases by 1 each time a new architecture is saved for the same
    project, so earlier versions remain in history rather than being
    overwritten.
    """

    project_id: str
    version: int
    architecture: dict[str, Any]
    frontend_spec: dict[str, Any]
    timestamp: datetime


@dataclass(frozen=True)
class TaskResultRecord:
    """Immutable record of one task's execution result.

    `module` identifies which module produced the result (for example
    "M06"). `result` holds that module's own result payload as-is
    (for M06 this is the same shape as m06_result.json), so this
    repository does not need to know each module's internal fields.
    """

    project_id: str
    task_id: str
    module: str
    status: TaskStatus
    result: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


class ProjectStateRepository:
    """Repository interface for project requirements, architecture,
    and task results."""

    def save_requirements(
        self,
        project_id: str,
        raw_idea: str,
        requirements: dict[str, Any],
    ) -> ProjectSpecificationRecord:
        """Persist the latest M02 requirements for a project."""
        raise NotImplementedError

    def get_requirements(
        self,
        project_id: str,
    ) -> ProjectSpecificationRecord | None:
        """Return the latest saved requirements for a project."""
        raise NotImplementedError

    def save_architecture(
        self,
        project_id: str,
        architecture: dict[str, Any],
        frontend_spec: dict[str, Any],
    ) -> ArchitectureRecord:
        """Persist a new, versioned M03 architecture for a project."""
        raise NotImplementedError

    def get_latest_architecture(
        self,
        project_id: str,
    ) -> ArchitectureRecord | None:
        """Return the newest saved architecture for a project."""
        raise NotImplementedError

    def get_architecture_history(
        self,
        project_id: str,
    ) -> list[ArchitectureRecord]:
        """Return every saved architecture version for a project,
        oldest first."""
        raise NotImplementedError

    def record_task_result(
        self,
        project_id: str,
        task_id: str,
        module: str,
        status: TaskStatus,
        result: dict[str, Any],
    ) -> TaskResultRecord:
        """Persist one task's execution result."""
        raise NotImplementedError

    def get_latest_task_result(
        self,
        project_id: str,
        task_id: str,
    ) -> TaskResultRecord | None:
        """Return the most recent result recorded for a task."""
        raise NotImplementedError

    def get_task_results_for_project(
        self,
        project_id: str,
    ) -> list[TaskResultRecord]:
        """Return every task result recorded for a project, oldest
        first."""
        raise NotImplementedError


class InMemoryProjectStateRepository(ProjectStateRepository):
    """Thread-safe in-memory project-state implementation.

    This implementation is intended for the MVP and tests. A
    persistent M07 backend can implement ProjectStateRepository
    later without changing callers.
    """

    def __init__(self) -> None:
        self._requirements: dict[str, ProjectSpecificationRecord] = {}
        self._architectures: dict[str, list[ArchitectureRecord]] = {}
        self._task_results: list[TaskResultRecord] = []
        self._lock = Lock()

    def save_requirements(
        self,
        project_id: str,
        raw_idea: str,
        requirements: dict[str, Any],
    ) -> ProjectSpecificationRecord:
        record = ProjectSpecificationRecord(
            project_id=project_id,
            raw_idea=raw_idea,
            requirements=requirements,
            timestamp=datetime.now(timezone.utc),
        )

        with self._lock:
            self._requirements[project_id] = record

        return record

    def get_requirements(
        self,
        project_id: str,
    ) -> ProjectSpecificationRecord | None:
        with self._lock:
            return self._requirements.get(project_id)

    def save_architecture(
        self,
        project_id: str,
        architecture: dict[str, Any],
        frontend_spec: dict[str, Any],
    ) -> ArchitectureRecord:
        with self._lock:
            existing = self._architectures.setdefault(project_id, [])
            next_version = len(existing) + 1

            record = ArchitectureRecord(
                project_id=project_id,
                version=next_version,
                architecture=architecture,
                frontend_spec=frontend_spec,
                timestamp=datetime.now(timezone.utc),
            )

            existing.append(record)

        return record

    def get_latest_architecture(
        self,
        project_id: str,
    ) -> ArchitectureRecord | None:
        history = self.get_architecture_history(project_id)
        if not history:
            return None
        return history[-1]

    def get_architecture_history(
        self,
        project_id: str,
    ) -> list[ArchitectureRecord]:
        with self._lock:
            return list(self._architectures.get(project_id, []))

    def record_task_result(
        self,
        project_id: str,
        task_id: str,
        module: str,
        status: TaskStatus,
        result: dict[str, Any],
    ) -> TaskResultRecord:
        record = TaskResultRecord(
            project_id=project_id,
            task_id=task_id,
            module=module,
            status=status,
            result=result,
            timestamp=datetime.now(timezone.utc),
        )

        with self._lock:
            self._task_results.append(record)

        return record

    def get_latest_task_result(
        self,
        project_id: str,
        task_id: str,
    ) -> TaskResultRecord | None:
        history = [
            record
            for record in self.get_task_results_for_project(project_id)
            if record.task_id == task_id
        ]

        if not history:
            return None

        return history[-1]

    def get_task_results_for_project(
        self,
        project_id: str,
    ) -> list[TaskResultRecord]:
        with self._lock:
            records = [
                record
                for record in self._task_results
                if record.project_id == project_id
            ]

        return sorted(records, key=lambda record: record.timestamp)