from pathlib import Path

from modules.m08_sandbox.executor import DockerExecutor
from modules.m09_qa.runner import QARunner
from modules.m10_interaction.progress import create_progress_event


def test_live_api_runtime_pipeline():
    executor = DockerExecutor(timeout_seconds=30)
    qa_runner = QARunner(executor=executor)

    report = qa_runner.run(
        project_path=Path("examples/live_api_app"),
        command=["python", "main.py"],
        project_id="live-api-project",
        task_id="live-api-task",
    )

    progress_event = create_progress_event(
        execution_id=report.execution_id,
        status=report.status,
        message=f"Live API execution completed: {report.status}",
    )

    print("\n--- LIVE API OUTPUT ---")
    print(report.stdout)

    assert report.status == "passed"
    assert report.issues_found == 0
    assert "LIVE API SNAPSHOT VERIFIED" in report.stdout
    assert "Records received: 100" in report.stdout
    assert "First record ID: 1" in report.stdout
    assert progress_event.execution_id == report.execution_id
    assert progress_event.status == "passed"