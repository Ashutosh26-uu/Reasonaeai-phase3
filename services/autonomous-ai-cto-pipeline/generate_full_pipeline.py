import json
from pathlib import Path

from modules.m07_shared_state.project_state import InMemoryProjectStateRepository
from modules.m02_requirements.engine import generate_requirements
from modules.m03_architect.architect import generate_architecture
from modules.m03_architect.frontend_spec import generate_frontend_spec

OUTPUT_DIR = Path("pipeline_test")
OUTPUT_DIR.mkdir(exist_ok=True)

repo = InMemoryProjectStateRepository()

_, requirements = generate_requirements(
    raw_idea="An app where users can sign up, log in, and manage a personal list of movies they want to watch, with each movie having a title and a watched status.",
    project_id="full-pipeline-test",
    repo=repo,
)

_, architecture = generate_architecture(
    requirements=requirements,
    project_id="full-pipeline-test",
    repo=repo,
)

frontend_spec = generate_frontend_spec(architecture)

(OUTPUT_DIR / "architecture.json").write_text(json.dumps(architecture, indent=2), encoding="utf-8")
(OUTPUT_DIR / "frontend_api_spec.json").write_text(json.dumps(frontend_spec, indent=2), encoding="utf-8")

print("\nSaved to", OUTPUT_DIR.resolve())
print("Tables:", [t["table_name"] for t in architecture["db_tables"]])
print("Routes:", [(r["method"], r["path"]) for r in architecture["api_routes"]])
print("Pages:", [p["name"] for p in frontend_spec["pages"]])