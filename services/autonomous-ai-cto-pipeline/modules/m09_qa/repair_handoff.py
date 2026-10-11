"""M09 repair-task handoff contract.

This module defines the interface between M09 QA and the
agent responsible for applying repairs.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from modules.m09_qa.repair_task import RepairTask


@dataclass(frozen=True)
class RepairHandoffRequest:
    """Request sent from M09 to the repair worker."""

    repair_task: RepairTask
    project_path: Path


@dataclass(frozen=True)
class RepairHandoffResult:
    """Result returned by the repair worker."""

    repair_task_id: str
    success: bool
    message: str
    modified_project_path: Path


class RepairHandoff(Protocol):
    """Contract implemented by the future repair worker."""

    def apply_repair(
        self,
        request: RepairHandoffRequest,
    ) -> RepairHandoffResult:
        """Apply the requested repair to the project."""
        ...


class DeterministicImportRepairHandoff:
    """Repair the single import-error fixture used by the integration test.

    This intentionally supports no general source rewriting. A request must
    describe an import error and the temporary project's ``main.py`` must
    exactly match the known broken fixture before it is changed.
    """

    _FILENAME = "main.py"
    _BROKEN_SOURCE = "import self_healing_missing_module\n"
    _REPAIRED_SOURCE = 'print("SELF_HEALING_IMPORT_REPAIRED")\n'

    def apply_repair(
        self,
        request: RepairHandoffRequest,
    ) -> RepairHandoffResult:
        repair_task = request.repair_task
        project_path = request.project_path.resolve()

        if repair_task.bug_type != "import_error":
            return self._failure(
                repair_task,
                project_path,
                f"Unsupported repair bug type: {repair_task.bug_type}",
            )

        source_path = project_path / self._FILENAME
        if not source_path.is_file():
            return self._failure(
                repair_task,
                project_path,
                f"Expected repair target not found: {self._FILENAME}",
            )

        source = source_path.read_text(encoding="utf-8")
        if source != self._BROKEN_SOURCE:
            return self._failure(
                repair_task,
                project_path,
                "Project source does not match the deterministic import fixture",
            )

        source_path.write_text(self._REPAIRED_SOURCE, encoding="utf-8")
        return RepairHandoffResult(
            repair_task_id=repair_task.repair_task_id,
            success=True,
            message="Deterministic import fixture repaired",
            modified_project_path=project_path,
        )

    @staticmethod
    def _failure(
        repair_task: RepairTask,
        project_path: Path,
        message: str,
    ) -> RepairHandoffResult:
        return RepairHandoffResult(
            repair_task_id=repair_task.repair_task_id,
            success=False,
            message=message,
            modified_project_path=project_path,
        )
