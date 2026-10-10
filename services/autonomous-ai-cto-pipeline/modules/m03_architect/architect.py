"""M03 AI CTO / Architect / Orchestrator - Phase A: architecture generation.

Converts M02's structured requirements into architecture.json: the
exact schema backend_agent.py (M05/M06) reads to generate a FastAPI
backend. This is the highest-risk module in the pipeline, because a
mismatch here does not fail loudly at generation time - it produces a
backend that is syntactically valid but wrong (crashes at runtime, or
the frontend can never match it). The validator below therefore checks
not just the JSON shape, but the hardcoded assumptions baked into
backend_agent.py itself:

- An auth table MUST have a column named exactly "email" - the
  generated signup/login routes reference `.email` directly.
- An auth table MUST have a column named exactly "hashed_password" -
  same reason.
- Every table's columns MUST include an "id" entry - the generator
  always forces id to a string UUID regardless of the declared type,
  but the entry must exist so the rest of the field list is derived
  correctly.
- Every route's "table" MUST exactly match a declared table_name.
- A signup/login route's table MUST be the table marked is_auth_table.

Phase B (deriving frontend_api_spec.json from this architecture) is a
separate module, not implemented here.
"""

import os
import json
from datetime import datetime

import ollama

from modules.m07_shared_state.project_state import (
    ArchitectureRecord,
    ProjectStateRepository,
)

CODER_MODEL = os.environ.get("CTO_MODEL", "qwen2.5-coder:7b")  # e.g. set CTO_MODEL=qwen2.5-coder:3b for a faster run
MAX_ATTEMPTS = 3

VALID_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

EXAMPLE_OUTPUT = """
Here is a WORKING EXAMPLE of the exact JSON shape required, for
requirements describing an app with user accounts and a list of tasks
that can have file attachments:

{
  "project_name": "task_tracker",
  "db_tables": [
    {
      "table_name": "users",
      "columns": [
        {"name": "id", "type": "uuid"},
        {"name": "email", "type": "string"},
        {"name": "hashed_password", "type": "string"}
      ],
      "is_auth_table": true
    },
    {
      "table_name": "tasks",
      "columns": [
        {"name": "id", "type": "uuid"},
        {"name": "owner_id", "type": "string", "foreign_key": "users.id"},
        {"name": "title", "type": "string"},
        {"name": "completed", "type": "boolean"}
      ],
    }
  ],
  "api_routes": [
    {"method": "POST", "path": "/auth/signup", "table": "users", "is_signup_route": true, "description": "Creates a new user account with a hashed password"},
    {"method": "POST", "path": "/auth/login", "table": "users", "is_login_route": true, "description": "Logs in a user and returns a JWT access token"},
    {"method": "GET", "path": "/users/me", "table": "users", "requires_auth": true, "description": "Returns the currently logged-in user's information"},
    {"method": "POST", "path": "/tasks", "table": "tasks", "description": "Creates a new task"},
    {"method": "GET", "path": "/tasks", "table": "tasks", "query_params": {"completed": "boolean", "limit": "int", "offset": "int"}, "description": "Lists tasks with an optional completed filter and pagination"},
    {"method": "POST", "path": "/tasks/{id}/upload", "table": "tasks", "is_file_upload": true, "description": "Uploads an attachment file for a task"}
  ]
}

Adapt every table, column, and route to the actual requirements given
below - do not reuse "task_tracker", "users", or "tasks" unless the
requirements genuinely call for them. Include a users/auth table only
if the requirements actually describe user accounts or login.
"""

RULES = """
Rules:
- Output ONLY a single valid JSON object. No markdown, no code fences,
  no explanation before or after it.
- The JSON object MUST have exactly these top-level keys:
  "project_name", "db_tables", "api_routes".
- "project_name" is a short lowercase_with_underscores string.
- Each item in "db_tables" is an object with:
  - "table_name": lowercase, plural, snake_case (e.g. "products").
  - "columns": a non-empty list of {"name": ..., "type": ...}. This
    list MUST include a column named exactly "id" (its declared type
    does not matter - the generator always makes it a string UUID).
  - "is_auth_table": true ONLY on the one table that represents user
    accounts used for login. Omit this field entirely on every other
    table.
  - A column that references another table's row (e.g. "the user who
    owns this record") MUST include "foreign_key": "<table>.id"
    pointing at that table's id column (e.g.
    {"name": "owner_id", "type": "string", "foreign_key": "users.id"}).
  - If "is_auth_table" is true, the "columns" list MUST also include
    a column named exactly "email" and a column named exactly
    "hashed_password" - these exact names are required by the code
    generator and cannot be changed.
- Each item in "api_routes" is an object with:
  - "method": one of "GET", "POST", "PUT", "PATCH", "DELETE".
  - "path": starts with "/"; use "{id}" for a path parameter
    (e.g. "/products/{id}").
  - "table": MUST exactly match a "table_name" declared in
    "db_tables".
  - "description": one plain-English sentence.
  - "is_signup_route": true on exactly the one route that creates a
    new user account. Its "table" MUST be the table with
    "is_auth_table": true.
  - "is_login_route": true on exactly the one route that checks
    credentials and returns an access token. Same table as signup.
  - "requires_auth": true on any route that should only work for a
    logged-in user (do not set this on the signup or login route
    itself).
  - "query_params": an object of {param_name: type} on EVERY GET route
    that returns a list of multiple records (plural resource, no
    "{id}" in the path) - this is required even if there is nothing to
    filter by. At minimum always include "limit": "int" and
    "offset": "int" for pagination. Add specific filter fields (like
    "completed": "boolean") only when the requirements actually call
    for filtering. A GET route that returns a list MUST have
    "query_params" present - this is how other modules tell a list
    apart from a single record. Never omit it on a list route, even
    when there are no real filters.
  - "is_file_upload": true on any route that uploads a file.
  - Do not set more than one of is_signup_route / is_login_route /
    query_params / is_file_upload on the same route.
- Do not invent a table, column, or route that is not implied by the
  requirements below. Do not choose a frontend framework, CSS
  framework, or any detail that belongs to a different module.
"""


def _log(build_log: list, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    entry = f"[{timestamp}] {message}"
    build_log.append(entry)
    print(entry)


def _clean_json_text(raw_text: str) -> str:
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text.replace("json", "", 1).strip()
    if "```" in text:
        text = text.split("```")[0].strip()
    return text


def _validate_architecture(data: dict) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "Top-level JSON value must be an object."

    required_keys = {"project_name", "db_tables", "api_routes"}
    missing = required_keys - set(data.keys())
    if missing:
        return False, f"Missing required keys: {sorted(missing)}"

    db_tables = data["db_tables"]
    if not isinstance(db_tables, list) or not db_tables:
        return False, "'db_tables' must be a non-empty list."

    table_names = set()
    auth_table_names = set()

    for table in db_tables:
        if not isinstance(table, dict):
            return False, "Each db_tables entry must be an object."
        if "table_name" not in table or not isinstance(table["table_name"], str):
            return False, "Each table needs a string 'table_name'."

        table_name = table["table_name"]
        if table_name in table_names:
            return False, f"Duplicate table_name: {table_name}"
        table_names.add(table_name)

        columns = table.get("columns")
        if not isinstance(columns, list) or not columns:
            return False, f"Table '{table_name}' needs a non-empty 'columns' list."

        column_names = set()
        for column in columns:
            if not isinstance(column, dict) or "name" not in column:
                return False, f"Table '{table_name}' has a column with no 'name'."
            column_names.add(column["name"])

        if "id" not in column_names:
            return False, f"Table '{table_name}' columns must include an 'id' entry."

        if table.get("is_auth_table"):
            auth_table_names.add(table_name)
            if "email" not in column_names:
                return False, f"Auth table '{table_name}' must have an 'email' column."
            if "hashed_password" not in column_names:
                return False, f"Auth table '{table_name}' must have a 'hashed_password' column."

    api_routes = data["api_routes"]
    if not isinstance(api_routes, list) or not api_routes:
        return False, "'api_routes' must be a non-empty list."

    for route in api_routes:
        if not isinstance(route, dict):
            return False, "Each api_routes entry must be an object."

        for key in ("method", "path", "table", "description"):
            if key not in route:
                return False, f"Route is missing required key '{key}': {route}"

        if route["method"] not in VALID_METHODS:
            return False, f"Invalid method '{route['method']}' (must be one of {sorted(VALID_METHODS)})."

        if not isinstance(route["path"], str) or not route["path"].startswith("/"):
            return False, f"Route path must start with '/': {route['path']}"

        if route["table"] not in table_names:
            return False, f"Route table '{route['table']}' does not match any declared table_name."

        if route.get("is_signup_route") or route.get("is_login_route"):
            if route["table"] not in auth_table_names:
                return False, (
                    f"Route at '{route['path']}' sets is_signup_route/is_login_route "
                    f"but table '{route['table']}' is not marked is_auth_table."
                )

        if "query_params" in route and not isinstance(route["query_params"], dict):
            return False, f"'query_params' must be an object on route '{route['path']}'."

    return True, ""


def generate_architecture(
    requirements: dict,
    project_id: str,
    repo: ProjectStateRepository,
) -> tuple[ArchitectureRecord, dict]:
    """
    Turn M02's structured requirements into a validated architecture.json,
    save it (versioned) into the shared project state (M07), and return
    both the saved record and the parsed architecture dict.

    Raises RuntimeError if a valid architecture could not be produced
    after MAX_ATTEMPTS tries.
    """
    build_log: list = []

    base_prompt = f"""
You are the Architect. Read the structured requirements below and
design the database tables and API routes needed to satisfy them.

Requirements: {json.dumps(requirements, indent=2)}

{RULES}
{EXAMPLE_OUTPUT}
"""

    conversation = [{"role": "user", "content": base_prompt}]
    architecture: dict | None = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt == 1:
            _log(build_log, "Architect: generating architecture...")
        else:
            _log(build_log, f"Architect: fixing architecture (attempt {attempt}/{MAX_ATTEMPTS})...")

        # Hard limits so a slow CPU can never loop for an hour: JSON-only output, capped length, 20 min timeout.
        response = ollama.Client(timeout=1200).chat(
            model=CODER_MODEL, messages=conversation, format="json",
            options={"num_predict": 3500, "temperature": 0.2},
        )
        raw_output = response["message"]["content"]
        cleaned = _clean_json_text(raw_output)

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            error_message = f"Output was not valid JSON: {exc}"
            _log(build_log, f"Architect: {error_message}")
            conversation.append({"role": "assistant", "content": raw_output})
            conversation.append({
                "role": "user",
                "content": f"{error_message}\n\nOutput ONLY the corrected, complete JSON object - nothing else."
            })
            continue

        is_valid, error_message = _validate_architecture(parsed)
        if is_valid:
            _log(build_log, "Architect: architecture is valid. \u2705")
            architecture = parsed
            break

        _log(build_log, f"Architect: found a problem \u2014 {error_message}")
        conversation.append({"role": "assistant", "content": raw_output})
        conversation.append({
            "role": "user",
            "content": f"That JSON has a problem: {error_message}\n\nOutput ONLY the corrected, complete JSON object - nothing else."
        })

    if architecture is None:
        raise RuntimeError(
            f"Architect: could not produce a valid architecture after {MAX_ATTEMPTS} attempts."
        )

    record = repo.save_architecture(
        project_id=project_id,
        architecture=architecture,
        frontend_spec={},
    )

    return record, architecture