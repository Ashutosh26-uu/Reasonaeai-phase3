from modules.m09_qa.bug_classifier import BugReport
from modules.m09_qa.repair_task import RepairTaskGenerator


def make_bug(
    bug_type: str,
    message: str = "test failure",
    traceback: str = "Traceback: test",
) -> BugReport:
    return BugReport(
        bug_type=bug_type,
        message=message,
        traceback=traceback,
        retryable=True,
    )


def test_name_error_generates_repair_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "name_error",
            "name 'x' is not defined",
        ),
        project_id="project_001",
        parent_task_id="task_001",
        attempt_number=2,
    )

    assert task.repair_task_id == "repair_project_001_task_001_attempt_2"
    assert task.project_id == "project_001"
    assert task.parent_task_id == "task_001"
    assert task.attempt_number == 2
    assert task.bug_type == "name_error"
    assert task.error_message == "name 'x' is not defined"
    assert task.traceback == "Traceback: test"
    assert task.priority == "high"
    assert "undefined name" in task.repair_instructions


def test_import_error_generates_high_priority_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "import_error",
            "No module named 'requests'",
        ),
        project_id="project_001",
        parent_task_id="task_002",
        attempt_number=2,
    )

    assert task.bug_type == "import_error"
    assert task.priority == "high"
    assert "import" in task.repair_instructions.lower()


def test_timeout_generates_high_priority_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "timeout",
            "Execution exceeded timeout",
        ),
        project_id="project_001",
        parent_task_id="task_003",
        attempt_number=2,
    )

    assert task.bug_type == "timeout"
    assert task.priority == "high"
    assert "timeout" in task.repair_instructions.lower()


def test_syntax_error_generates_high_priority_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "syntax_error",
            "invalid syntax",
        ),
        project_id="project_001",
        parent_task_id="task_004",
        attempt_number=2,
    )

    assert task.priority == "high"
    assert task.bug_type == "syntax_error"


def test_type_error_generates_high_priority_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "type_error",
            "unsupported operand type",
        ),
        project_id="project_001",
        parent_task_id="task_005",
        attempt_number=2,
    )

    assert task.priority == "high"
    assert task.bug_type == "type_error"


def test_runtime_error_generates_high_priority_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "runtime_error",
            "runtime failure",
        ),
        project_id="project_001",
        parent_task_id="task_006",
        attempt_number=2,
    )

    assert task.priority == "high"
    assert task.bug_type == "runtime_error"


def test_unknown_bug_generates_medium_priority_task():
    generator = RepairTaskGenerator()

    task = generator.generate(
        bug=make_bug(
            "unknown",
            "unexpected failure",
        ),
        project_id="project_001",
        parent_task_id="task_007",
        attempt_number=2,
    )

    assert task.priority == "medium"
    assert task.bug_type == "unknown"


def test_repair_task_is_deterministic():
    generator = RepairTaskGenerator()

    bug = make_bug(
        "name_error",
        "name 'x' is not defined",
    )

    task1 = generator.generate(
        bug=bug,
        project_id="project_001",
        parent_task_id="task_001",
        attempt_number=2,
    )

    task2 = generator.generate(
        bug=bug,
        project_id="project_001",
        parent_task_id="task_001",
        attempt_number=2,
    )

    assert task1 == task2


def test_invalid_attempt_number_is_rejected():
    generator = RepairTaskGenerator()

    bug = make_bug("name_error")

    try:
        generator.generate(
            bug=bug,
            project_id="project_001",
            parent_task_id="task_001",
            attempt_number=0,
        )
        assert False, "Expected ValueError"
    except ValueError as exc:
        assert "attempt_number" in str(exc)


def test_empty_project_id_is_rejected():
    generator = RepairTaskGenerator()

    bug = make_bug("name_error")

    try:
        generator.generate(
            bug=bug,
            project_id="",
            parent_task_id="task_001",
            attempt_number=2,
        )
        assert False, "Expected ValueError"
    except ValueError as exc:
        assert "project_id" in str(exc)


def test_empty_parent_task_id_is_rejected():
    generator = RepairTaskGenerator()

    bug = make_bug("name_error")

    try:
        generator.generate(
            bug=bug,
            project_id="project_001",
            parent_task_id="",
            attempt_number=2,
        )
        assert False, "Expected ValueError"
    except ValueError as exc:
        assert "parent_task_id" in str(exc)