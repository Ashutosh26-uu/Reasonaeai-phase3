from modules.m07_shared_state.project_state import InMemoryProjectStateRepository
from modules.m02_requirements.engine import generate_requirements
from modules.m03_architect.architect import generate_architecture

repo = InMemoryProjectStateRepository()

# Step 1: M02 generates requirements (reusing the earlier test idea)
_, requirements = generate_requirements(
    raw_idea="An app where users can sign up, log in, and keep a list of books they want to read, marking each as read or unread.",
    project_id="m03-test-project",
    repo=repo,
)

print("\n--- REQUIREMENTS (from M02) ---")
print("project_name:", requirements["project_name"])

# Step 2: M03 generates architecture from those requirements
_, architecture = generate_architecture(
    requirements=requirements,
    project_id="m03-test-project",
    repo=repo,
)

print("\n--- ARCHITECTURE (from M03) ---")
print("project_name:", architecture["project_name"])
print("\nTables:")
for table in architecture["db_tables"]:
    print(f"  - {table['table_name']} (auth: {table.get('is_auth_table', False)})")
    for col in table["columns"]:
        print(f"      {col['name']}: {col['type']}")

print("\nRoutes:")
for route in architecture["api_routes"]:
    flags = []
    if route.get("is_signup_route"): flags.append("signup")
    if route.get("is_login_route"): flags.append("login")
    if route.get("requires_auth"): flags.append("auth")
    if "query_params" in route: flags.append("list")
    if route.get("is_file_upload"): flags.append("upload")
    print(f"  - {route['method']} {route['path']} -> {route['table']} {flags}")

latest = repo.get_latest_architecture("m03-test-project")
print("\nSaved in M07, version:", latest.version)
import json
print("\n--- FULL ARCHITECTURE JSON ---")
print(json.dumps(architecture, indent=2))