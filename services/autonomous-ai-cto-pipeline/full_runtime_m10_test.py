from pathlib import Path

from pathlib import Path
from modules.m08_sandbox.executor import DockerExecutor
from modules.m09_qa.runner import QARunner
from modules.m10_interaction.progress import create_progress_event


executor = DockerExecutor(
    image="ai-cto-generated-backend:test",
    timeout_seconds=30,
)

qa_runner = QARunner(executor=executor)

report = qa_runner.run(
    project_path=Path(
    str(Path(__file__).resolve().parent / "modules/m06_devops/generated_backend")
    ),
    command=[
        "python",
        "-c",
        'import os; os.environ["SECRET_KEY"]="integration-test-key"; os.environ["DATABASE_URL"]="sqlite:////tmp/test.db"; import main; print("FULL_RUNTIME_M10_OK")',
    ],
    project_id="full-runtime-integration",
    task_id="m06-m08-m09-m10",
)

event = create_progress_event(
    execution_id=report.execution_id,
    project_id=report.project_id,
    task_id=report.task_id,
    status=report.status,
    message=f"Generated application QA completed: {report.status}",
    attempt_number=1,
)

print("QA REPORT:")
print(report.model_dump_json(indent=2))

print("\nPROGRESS EVENT:")
print(event.model_dump_json(indent=2))
