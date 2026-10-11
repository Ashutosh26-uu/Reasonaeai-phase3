
from pathlib import Path

from modules.m08_sandbox.executor import DockerExecutor
from modules.m09_qa.runner import QARunner


def test_qa_runner_success():
    runner = QARunner(
        executor=DockerExecutor(timeout_seconds=30)
    )

    report = runner.run(
        project_path=Path("examples/simple_python_app"),
        command=["python", "main.py"],
        project_id="test-project",
        task_id="success-task",
    )

    assert report.status == "passed"
    assert report.issues_found == 0
    assert report.execution_id is not None


def test_qa_runner_failure():
    runner = QARunner(
        executor=DockerExecutor(timeout_seconds=30)
    )

    report = runner.run(
        project_path=Path("examples/broken_python_app"),
        command=["python", "main.py"],
        project_id="test-project",
        task_id="failure-task",
    )

    assert report.status == "failed"
    assert report.issues_found >= 1
    assert "ValueError" in report.stderr


def test_qa_runner_timeout():
    runner = QARunner(
        executor=DockerExecutor(timeout_seconds=3)
    )

    report = runner.run(
        project_path=Path("examples/timeout_app"),
        command=["python", "main.py"],
        project_id="test-project",
        task_id="timeout-task",
    )

    assert report.status == "timeout"
    assert report.issues_found == 1
    assert report.issues[0] == (
        "Execution exceeded the configured timeout"
    )