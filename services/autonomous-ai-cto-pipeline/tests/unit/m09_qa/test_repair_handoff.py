from pathlib import Path

from modules.m09_qa.repair_handoff import (
    DeterministicImportRepairHandoff,
    RepairHandoffRequest,
    RepairHandoffResult,
)
from modules.m09_qa.bug_classifier import BugReport
from modules.m09_qa.repair_task import RepairTaskGenerator
from modules.m09_qa.repair_task import RepairTask


def make_repair_task() -> RepairTask:
    return RepairTask(
        repair_task_id="repair_project_test_task_test_attempt_2",
        parent_task_id="task_test",
        project_id="project_test",
        attempt_number=2,
        bug_type="import_error",
        error_message="Missing dependency",
        traceback="ModuleNotFoundError: missing_package",
        repair_instructions=(
            "Fix the missing or invalid import reported by QA, "
            "then rerun the task."
        ),
        priority="high",
    )


def test_repair_handoff_request() -> None:
    task = make_repair_task()

    request = RepairHandoffRequest(
        repair_task=task,
        project_path=Path("."),
    )

    assert request.repair_task.repair_task_id == (
        "repair_project_test_task_test_attempt_2"
    )
    assert request.repair_task.project_id == "project_test"
    assert request.project_path == Path(".")


def test_repair_handoff_result_success() -> None:
    result = RepairHandoffResult(
        repair_task_id="repair_project_test_task_test_attempt_2",
        success=True,
        message="Repair applied successfully",
        modified_project_path=Path("."),
    )

    assert result.success is True
    assert result.repair_task_id == (
        "repair_project_test_task_test_attempt_2"
    )
    assert result.message == "Repair applied successfully"


def test_repair_handoff_result_failure() -> None:
    result = RepairHandoffResult(
        repair_task_id="repair_project_test_task_test_attempt_2",
        success=False,
        message="Repair could not be applied",
        modified_project_path=Path("."),
    )

    assert result.success is False
    assert result.message == "Repair could not be applied"


def test_deterministic_import_handoff_repairs_only_fixture(tmp_path: Path) -> None:
    source_path = tmp_path / "main.py"
    source_path.write_text("import self_healing_missing_module\n", encoding="utf-8")
    task = RepairTaskGenerator().generate(
        bug=BugReport(
            bug_type="import_error",
            message="No module named 'self_healing_missing_module'",
            traceback="ModuleNotFoundError: self_healing_missing_module",
            retryable=True,
        ),
        project_id="project_test",
        parent_task_id="task_test",
        attempt_number=2,
    )

    result = DeterministicImportRepairHandoff().apply_repair(
        RepairHandoffRequest(repair_task=task, project_path=tmp_path)
    )

    assert result.success is True
    assert result.modified_project_path == tmp_path.resolve()
    assert source_path.read_text(encoding="utf-8") == (
        'print("SELF_HEALING_IMPORT_REPAIRED")\n'
    )


def test_deterministic_import_handoff_rejects_unsupported_bug(tmp_path: Path) -> None:
    source_path = tmp_path / "main.py"
    source_path.write_text("import self_healing_missing_module\n", encoding="utf-8")
    task = RepairTaskGenerator().generate(
        bug=BugReport(
            bug_type="syntax_error",
            message="invalid syntax",
            traceback="SyntaxError: invalid syntax",
            retryable=False,
        ),
        project_id="project_test",
        parent_task_id="task_test",
        attempt_number=2,
    )

    result = DeterministicImportRepairHandoff().apply_repair(
        RepairHandoffRequest(repair_task=task, project_path=tmp_path)
    )

    assert result.success is False
    assert result.message == "Unsupported repair bug type: syntax_error"
    assert source_path.read_text(encoding="utf-8") == (
        "import self_healing_missing_module\n"
    )
