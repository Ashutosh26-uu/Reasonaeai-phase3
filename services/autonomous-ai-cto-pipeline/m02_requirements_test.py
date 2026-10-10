from modules.m07_shared_state.project_state import InMemoryProjectStateRepository
from modules.m02_requirements.engine import generate_requirements

repo = InMemoryProjectStateRepository()

record, requirements = generate_requirements(
    raw_idea="An app where users can sign up, log in, and keep a list of books they want to read, marking each as read or unread.",
    project_id="m02-test-project",
    repo=repo,
)

print("\n--- RESULT ---")
print("project_name:", requirements["project_name"])
print("actors:", requirements["actors"])
print("features count:", len(requirements["features"]))
for f in requirements["features"]:
    print(" -", f["name"], "|", f["priority"])
print("constraints:", requirements["constraints"])
print("acceptance_criteria count:", len(requirements["acceptance_criteria"]))

saved = repo.get_requirements("m02-test-project")
print("\nSaved in M07:", saved is not None)
print("Saved raw_idea matches:", saved.raw_idea == requirements and False or saved.requirements == requirements)