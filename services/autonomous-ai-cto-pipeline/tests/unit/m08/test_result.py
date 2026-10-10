
from modules.m08_sandbox.result import ExecutionResult


def test_successful_execution_result():
    result = ExecutionResult(
        execution_id="exec_001",
        project_id="proj_001",
        task_id="task_001",
        status="passed",
        exit_code=0,
        stdout="Hello AI CTO",
    )

    assert result.status == "passed"
    assert result.exit_code == 0
    assert result.stdout == "Hello AI CTO"


def test_failed_execution_result():
    result = ExecutionResult(
        execution_id="exec_002",
        project_id="proj_001",
        task_id="task_002",
        status="failed",
        exit_code=1,
        stderr="Something went wrong",
        error_type="RUNTIME_ERROR",
    )

    assert result.status == "failed"
    assert result.exit_code == 1
    assert result.error_type == "RUNTIME_ERROR"