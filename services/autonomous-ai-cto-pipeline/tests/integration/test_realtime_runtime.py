from pathlib import Path

from modules.m08_sandbox.executor import DockerExecutor
from modules.m09_qa.runner import QARunner
from modules.m10_interaction.progress import create_progress_event


def test_realtime_runtime_pipeline():
    executor = DockerExecutor(timeout_seconds=30)
    qa_runner = QARunner(executor=executor)

    report = qa_runner.run(
        project_path=Path("examples/realtime_python_app"),
        command=["python", "main.py"],
        project_id="realtime-project",
        task_id="realtime-task",
    )

    progress_event = create_progress_event(
        execution_id=report.execution_id,
        status=report.status,
        message=f"Real-time execution completed: {report.status}",
    )

    assert report.status == "passed"
    assert report.issues_found == 0
    assert "REAL-TIME EXECUTION VERIFIED" in report.stdout
    assert "Execution time:" in report.stdout
    assert "Runtime ID:" in report.stdout
    assert "Python version:" in report.stdout

    assert progress_event.execution_id == report.execution_id
    assert progress_event.status == "passed"