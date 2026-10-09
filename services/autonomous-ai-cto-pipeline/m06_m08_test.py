from pathlib import Path
from pathlib import Path
from modules.m08_sandbox.executor import DockerExecutor

executor = DockerExecutor(
    image="ai-cto-generated-backend:test",
    timeout_seconds=30,
)

result = executor.execute(
    project_path=Path(
    str(Path(__file__).resolve().parent / "modules/m06_devops/generated_backend")
    ),
    command=[
        "python",
        "-c",
        'import os; os.environ["SECRET_KEY"]="integration-test-key"; os.environ["DATABASE_URL"]="sqlite:////tmp/test.db"; import main; print("M06_ARTIFACT_IMPORT_OK")',
    ],
    project_id="m06-integration",
    task_id="m06-to-m08",
)

print(result.model_dump_json(indent=2))
