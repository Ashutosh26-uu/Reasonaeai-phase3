from pathlib import Path

from pathlib import Path
from modules.m08_sandbox.executor import DockerExecutor
from modules.m09_qa.runner import QARunner


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
        'import os; os.environ["SECRET_KEY"]="integration-test-key"; os.environ["DATABASE_URL"]="sqlite:////tmp/test.db"; import main; print("M06_TO_M09_QA_OK")',
    ],
    project_id="m06-m09-integration",
    task_id="generated-backend-qa",
)

print(report.model_dump_json(indent=2))
