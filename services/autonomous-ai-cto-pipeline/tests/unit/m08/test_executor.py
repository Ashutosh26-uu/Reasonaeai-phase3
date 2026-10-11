
from pathlib import Path

from modules.m08_sandbox.executor import DockerExecutor


PROJECT_PATH = Path("examples/simple_python_app")


def test_successful_docker_execution():
    executor = DockerExecutor(
        timeout_seconds=30,
    )

    result = executor.execute(
        project_path=PROJECT_PATH,
        command=["python", "main.py"],
        project_id="test-project",
        task_id="test-task",
    )

    assert result.status == "passed"
    assert result.exit_code == 0
    assert "Hello from Autonomous AI CTO!" in result.stdout
    assert result.duration_ms is not None

# -----------------------------------------broken python app-------------------------------------------------------------

def test_failed_docker_execution():
    executor = DockerExecutor(timeout_seconds=30)

    result = executor.execute(
        project_path="examples/broken_python_app",
        command=["python", "main.py"],
        project_id="test-project",
        task_id="failure-task",
    )

    assert result.status == "failed"
    assert result.exit_code != 0
    assert "ValueError" in result.stderr
    assert result.duration_ms is not None

#----------------------------------------------timeout app---------------------------------------------------------------------

def test_timeout_docker_execution():
    executor = DockerExecutor(timeout_seconds=3)

    result = executor.execute(
        project_path="examples/timeout_app",
        command=["python", "main.py"],
        project_id="test-project",
        task_id="timeout-task",
    )

    assert result.status == "timeout"
    assert result.error_type == "TIMEOUT"