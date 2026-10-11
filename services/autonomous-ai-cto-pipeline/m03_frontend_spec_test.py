import json
from modules.m07_shared_state.project_state import InMemoryProjectStateRepository
from modules.m02_requirements.engine import generate_requirements
from modules.m03_architect.architect import generate_architecture
from modules.m03_architect.frontend_spec import generate_frontend_spec

repo = InMemoryProjectStateRepository()

_, requirements = generate_requirements(
    raw_idea="An app where users can sign up, log in, and keep a list of books they want to read, marking each as read or unread.",
    project_id="m03b-test-project",
    repo=repo,
)

_, architecture = generate_architecture(
    requirements=requirements,
    project_id="m03b-test-project",
    repo=repo,
)

frontend_spec = generate_frontend_spec(architecture)

print("\n--- FRONTEND SPEC ---")
print(json.dumps(frontend_spec, indent=2))

print("\nPage names:", [p["name"] for p in frontend_spec["pages"]])