
from pathlib import Path

from modules.m08_sandbox.executor import DockerExecutor
from modules.m10_interaction.progress import create_progress_event
from modules.m09_qa.runner import QARunner


def test_runtime_pipeline_success():
    # 1. Create the executor.
    executor = DockerExecutor(timeout_seconds=30)

    # 2. Create the QA runner using M08.
    qa_runner = QARunner(executor=executor)

    # 3. Run the generated project.
    report = qa_runner.run(
        project_path=Path("examples/simple_python_app"),
        command=["python", "main.py"],
        project_id="integration-project",
        task_id="integration-task",
    )

    # 4. Convert the QA result into a progress event.
    progress_event = create_progress_event(
        execution_id=report.execution_id,
        status=report.status,
        message=f"QA execution completed with status: {report.status}",
    )

    # 5. Verify the complete pipeline.
    assert report.status == "passed"
    assert report.issues_found == 0
    assert report.execution_id is not None

    assert progress_event.execution_id == report.execution_id
    assert progress_event.status == "passed"
    assert "passed" in progress_event.message
    assert progress_event.timestamp is not None