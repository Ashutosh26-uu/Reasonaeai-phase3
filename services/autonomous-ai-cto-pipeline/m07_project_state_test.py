from modules.m07_shared_state.project_state import InMemoryProjectStateRepository

repo = InMemoryProjectStateRepository()

repo.save_requirements(
    project_id="demo-project",
    raw_idea="an app where users sign up and manage products",
    requirements={"features": ["auth", "products"]},
)
req = repo.get_requirements("demo-project")
print("Requirements saved:", req is not None)

repo.save_architecture(
    project_id="demo-project",
    architecture={"db_tables": []},
    frontend_spec={"pages": []},
)
repo.save_architecture(
    project_id="demo-project",
    architecture={"db_tables": ["users"]},
    frontend_spec={"pages": ["Signup"]},
)
latest = repo.get_latest_architecture("demo-project")
history = repo.get_architecture_history("demo-project")
print("Latest architecture version:", latest.version)
print("Architecture history length:", len(history))

repo.record_task_result(
    project_id="demo-project",
    task_id="m06-task",
    module="M06",
    status="success",
    result={"changed_files": ["main.py"]},
)
task = repo.get_latest_task_result("demo-project", "m06-task")
print("Task result status:", task.status)