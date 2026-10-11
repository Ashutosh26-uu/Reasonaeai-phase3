"""M03 AI CTO / Architect / Orchestrator - Phase B: frontend spec derivation.

Converts an already-generated architecture.json into
frontend_api_spec.json - the exact schema frontend_agent.py (M04)
reads to generate React pages.

This phase is deliberately NOT an LLM call. The architecture already
carries every flag needed (is_signup_route, is_login_route,
requires_auth, query_params, is_file_upload) because M03 Phase A put
them there, and frontend_agent.py's own page-type detection reads
those same flags. Re-deriving this with a second model call would
only add a new chance of mismatch for information that is already
exact - so this is plain, deterministic Python instead.

Page names reuse backend_agent.py's own table_name -> class_name
logic (_class_name_for), so a page name always matches the backend's
own model/schema naming.

Known limitation: an Update page's request_body lists every
non-id column, but the generated form does not yet express "leave a
field blank to keep it unchanged" - the backend route supports true
partial updates (verified: PATCH with only one field leaves the
others untouched), but the frontend form generated from this spec
will currently send every field each time. This is a frontend_agent
template gap, not a Phase B defect, and is noted here rather than
silently left unexplained.
"""

from modules.m06_devops.backend_agent import _class_name_for

DEFAULT_BASE_URL = "http://127.0.0.1:8000"


def _column_types(columns: list[dict], exclude: set[str]) -> dict[str, str]:
    return {
        column["name"]: column.get("type", "string")
        for column in columns
        if column["name"] not in exclude
    }


def _path_suffix(path: str) -> str:
    """'/services/{id}/opening_hours' -> 'OpeningHours' (extra path words after the resource).

    This is what makes sibling pages get real, different names instead of
    ServiceListPage / ServiceListPage2 / ServiceListPage3.
    """
    words = [seg for seg in path.strip("/").split("/") if seg and not seg.startswith("{")]
    extra = words[1:]  # first word is the resource itself (e.g. 'services')
    return "".join(part.capitalize() for seg in extra for part in seg.split("_") if part)


def _unique_name(base_name: str, used_names: set[str]) -> str:
    if base_name not in used_names:
        used_names.add(base_name)
        return base_name

    suffix = 2
    while f"{base_name}{suffix}" in used_names:
        suffix += 1
    unique = f"{base_name}{suffix}"
    used_names.add(unique)
    return unique


def _build_page_for_route(
    route: dict,
    class_name: str,
    columns: list[dict],
    base_url: str,
    used_names: set[str],
) -> dict:
    method = route["method"]
    path = route["path"]
    description = route["description"]

    if route.get("is_signup_route"):
        create_fields = _column_types(columns, exclude={"id", "hashed_password"})
        request_body = {**create_fields, "password": "string"}
        response_body = {"id": "string", **create_fields}
        name = _unique_name(f"{class_name}SignupPage", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "request_body": request_body, "response_body": response_body,
        }

    elif route.get("is_login_route"):
        create_fields = _column_types(columns, exclude={"id", "hashed_password"})
        request_body = {**create_fields, "password": "string"}
        response_body = {"access_token": "string", "token_type": "string"}
        name = _unique_name(f"{class_name}LoginPage", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "request_body": request_body, "response_body": response_body,
        }

    elif "query_params" in route and not path.rstrip("/").endswith("}"):
        # A path ending in {id} fetches ONE record, so limit/offset make no sense there
        # (it falls through to the Detail page below).
        response_fields = _column_types(columns, exclude=set())
        suffix = _path_suffix(path)
        name = _unique_name(f"{class_name}{suffix}Page" if suffix else f"{class_name}ListPage", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "query_params": route["query_params"],
            "response_body": f"array of {{{', '.join(response_fields)}}}",
        }

    elif route.get("is_file_upload"):
        name = _unique_name(f"{class_name}UploadPage", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "file_field_name": "file",
        }
        if "{id}" in path:
            description = f"{description} The target id is part of the URL path."

    elif method in ("PUT", "PATCH"):
        update_fields = _column_types(columns, exclude={"id"})
        response_fields = _column_types(columns, exclude=set())
        name = _unique_name(f"Update{class_name}Page", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "request_body": update_fields,
            "response_body": {"id": "string", **response_fields},
        }
        description = (
            f"{description} Only changed fields need to be sent - "
            f"fields left unchanged on the backend are preserved."
        )

    elif method == "POST":
        create_fields = _column_types(columns, exclude={"id"})
        response_fields = _column_types(columns, exclude=set())
        name = _unique_name(f"Create{class_name}Page", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "request_body": create_fields,
            "response_body": {"id": "string", **response_fields},
        }

    elif method == "GET" and route.get("requires_auth") and "{id}" not in path:
        response_fields = _column_types(columns, exclude={"hashed_password"})
        name = _unique_name(f"{class_name}ProfilePage", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "response_body": response_fields,
        }

    elif method == "GET":
        response_fields = _column_types(columns, exclude=set())
        suffix = _path_suffix(path)
        name = _unique_name(f"{class_name}{suffix}Page" if suffix else f"{class_name}DetailPage", used_names)
        calls_api = {
            "method": method, "path": path, "base_url": base_url,
            "response_body": response_fields,
        }

    else:
        name = _unique_name(f"{class_name}{method.title()}Page", used_names)
        calls_api = {"method": method, "path": path, "base_url": base_url}

    return {"name": name, "description": description, "calls_api": calls_api}


def generate_frontend_spec(
    architecture: dict,
    base_url: str = DEFAULT_BASE_URL,
) -> dict:
    """
    Deterministically derive frontend_api_spec.json from an already
    validated architecture.json (no model call, no M07 save - this
    is a pure function of its input).
    """
    table_name_to_class = {
        table["table_name"]: _class_name_for(table["table_name"])
        for table in architecture["db_tables"]
    }
    table_name_to_columns = {
        table["table_name"]: table["columns"]
        for table in architecture["db_tables"]
    }

    used_names: set[str] = set()
    pages = []

    for route in architecture["api_routes"]:
        class_name = table_name_to_class[route["table"]]
        columns = table_name_to_columns[route["table"]]
        pages.append(
            _build_page_for_route(route, class_name, columns, base_url, used_names)
        )

    return {
        "project_name": architecture["project_name"],
        "pages": pages,
    }