"""
Chunked Orchestrator (v9 - Docker-ready output).

Breaks backend generation into small, focused AI requests (per-table
models, per-table schemas, per-route endpoints), then assembles them
in Python.

Changes in v9 (for M6 DevOps / Docker integration):
  - the generated main.py now has a /health route (used by the Docker
    Compose healthcheck)
  - DATABASE_URL and SECRET_KEY are read from environment variables
    (no hard-coded secrets)
  - the validator passes a dummy SECRET_KEY / in-memory DATABASE_URL to
    the subprocess, so validation does not fail just because the real
    environment variables are not set on the developer's machine
  - requirements.txt is written next to main.py, so the generated
    folder is a complete, buildable Docker context
  - extra forbidden patterns ("postgresql", "dialects") for model pieces

Everything else carries over from v1-v8: import stripping, consistent
class naming, explicit field lists, auto-generated Update schemas,
Field import, Float/Boolean/DateTime imports, Python-built decorators,
retry-on-forbidden-pattern for model generation, query-param based
search/filter/pagination, file upload support, and authentication
(password hashing, JWT tokens, protected routes, HTTPBearer).
"""

import ollama
import json
import os
import sys
import subprocess
import tempfile
from datetime import datetime

CODER_MODEL = "qwen2.5-coder:7b"

REQUIREMENTS_TXT = (
    "fastapi\n"
    "uvicorn\n"
    "sqlalchemy\n"
    "pydantic\n"
    "passlib[bcrypt]\n"
    "bcrypt==4.0.1\n"
    "PyJWT\n"
    "python-multipart\n"
)


def _log(build_log: list, message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    entry = f"[{timestamp}] {message}"
    build_log.append(entry)
    print(entry)


def _clean_code(raw_text: str) -> str:
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text.replace("python", "", 1).strip()
    if "```" in text:
        text = text.split("```")[0].strip()
    return text


def _strip_import_lines(code: str) -> str:
    lines = code.split("\n")
    kept = [line for line in lines if not line.strip().startswith(("import ", "from "))]
    return "\n".join(kept).strip()


def _class_name_for(table_name: str) -> str:
    singular = table_name[:-1] if table_name.endswith("s") else table_name
    return "".join(word.capitalize() for word in singular.split("_"))


def _ask_ai(prompt: str) -> str:
    response = ollama.chat(model=CODER_MODEL, messages=[{"role": "user", "content": prompt}])
    raw = response["message"]["content"]
    return _strip_import_lines(_clean_code(raw))


def _ask_ai_with_retry(prompt: str, forbidden_patterns: list, build_log: list, piece_name: str, max_attempts: int = 2) -> str:
    code = ""
    for attempt in range(1, max_attempts + 1):
        code = _ask_ai(prompt)
        found_issue = None
        for pattern in forbidden_patterns:
            if pattern in code:
                found_issue = pattern
                break
        if not found_issue:
            return code
        _log(build_log, f"Backend Agent: '{piece_name}' used forbidden pattern '{found_issue}', retrying...")
        prompt = prompt + f"\n\nIMPORTANT: Your previous answer incorrectly used \"{found_issue}\". Do not use that - follow the rules above exactly. Use Column(String, ...) for the id, never UUID() or func.uuid4(). Do not use any database-specific dialect imports or names."
    return code


def _extract_function_body_only(code: str) -> str:
    if "def " in code:
        idx = code.index("def ")
        return code[idx:].strip()
    return code.strip()


def _generate_model_piece(table: dict, build_log: list) -> str:
    table_name = table["table_name"]
    class_name = _class_name_for(table_name)
    _log(build_log, f"Backend Agent: generating database model '{class_name}' for table '{table_name}'...")

    columns_desc = json.dumps(table["columns"], indent=2)
    prompt = f"""
Generate ONLY a single SQLAlchemy model class named exactly "{class_name}"
(parent class "Base", already defined elsewhere - do not redefine Base).

__tablename__ = "{table_name}"
Columns: {columns_desc}

Rules:
- The class MUST be named "{class_name}" exactly.
- The "id" column MUST be: id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
- If a column has a "foreign_key" field, use Column(String, ForeignKey("table.column")).
- Do NOT add any column that is not in the list above.
- Output ONLY the class definition. No imports, no explanation, no other classes.
"""
    return _ask_ai_with_retry(
        prompt,
        forbidden_patterns=["UUID(", "uuid.UUID", "func.uuid4", "postgresql", "dialects"],
        build_log=build_log,
        piece_name=f"model for {class_name}",
    )


def _generate_pydantic_piece(table: dict, needs_update_schema: bool, build_log: list) -> str:
    table_name = table["table_name"]
    class_name = _class_name_for(table_name)
    _log(build_log, f"Backend Agent: generating request/response schemas for '{class_name}'...")

    columns_desc = json.dumps(table["columns"], indent=2)
    is_auth_table = table.get("is_auth_table", False)

    if is_auth_table:
        create_fields = [c["name"] for c in table["columns"] if c["name"] not in ("id", "hashed_password")]
        response_fields = [c["name"] for c in table["columns"] if c["name"] not in ("id", "hashed_password")]
        prompt = f"""
Generate ONLY these Pydantic classes (parent class "BaseModel").

This is an AUTH table. The client sends a plain "password" field (never
the hashed one), and the server hashes it before storing.

Generate:
1. "{class_name}Create" with fields: {create_fields} PLUS a "password: str" field
   (NOT "hashed_password" - that name is reserved for internal storage only).
2. "{class_name}Response" with fields: "id: str" plus {response_fields}.
   Do NOT include "password" or "hashed_password" in the Response class -
   passwords must never be returned to the client. Must include
   "class Config: from_attributes = True".

Rules:
- All classes must inherit from BaseModel, never from Base.
- Output ONLY these class definitions. No imports, no explanation.
"""
        return _ask_ai(prompt)

    field_names = [c["name"] for c in table["columns"] if c["name"] != "id"]
    update_instruction = ""
    if needs_update_schema:
        update_instruction = f"""
3. "{class_name}Update" - the SAME fields as {class_name}Create, but every
   field must be Optional with a default of None (for partial updates).
"""

    prompt = f"""
Generate ONLY these Pydantic classes (parent class "BaseModel" - this is
Pydantic, NOT SQLAlchemy, do not use Column or Base).

CRITICAL: The "id" field must always be typed as "id: str" - never
"UUID4", never "uuid.UUID". Do NOT import or use UUID4 anywhere.

Table: {table_name}
All columns: {columns_desc}
Fields allowed (excluding id, which the server generates): {field_names}

Generate:
1. "{class_name}Create" - includes ONLY these fields: {field_names}. Do NOT
   add any field that is not in this exact list (no "password", no extra
   fields of any kind).
2. "{class_name}Response" - includes "id" plus these fields: {field_names}.
   Must include "class Config: from_attributes = True" inside it.
{update_instruction}
Rules:
- All classes must inherit from BaseModel, never from Base.
- Output ONLY these class definitions. No imports, no explanation.
"""
    return _ask_ai(prompt)


def _generate_route_piece(route: dict, table_name_to_class: dict, table_name_to_fields: dict, build_log: list) -> str:
    method = route["method"].lower()
    path = route["path"]
    _log(build_log, f"Backend Agent: generating route '{method.upper()} {path}'...")

    matched_table = route.get("table")
    if not matched_table:
        for table_name in table_name_to_class:
            if table_name in path or table_name.rstrip("s") in path:
                matched_table = table_name
                break

    class_hint = ""
    response_class = None
    if matched_table:
        class_name = table_name_to_class[matched_table]
        fields = table_name_to_fields[matched_table]
        response_class = f"{class_name}Response"
        class_hint = f"""
This route acts on the "{matched_table}" table.
- SQLAlchemy model class name: {class_name}
- Pydantic request class name: {class_name}Create
- Pydantic response class name: {class_name}Response
- Pydantic update class name (if this is an update route): {class_name}Update
Use EXACTLY these class names - do not invent different ones. Do NOT
redefine any of these classes - they already exist elsewhere.
"""

    is_list_route = bool(route.get("query_params"))
    is_file_upload = bool(route.get("is_file_upload"))
    is_signup_route = bool(route.get("is_signup_route"))
    is_login_route = bool(route.get("is_login_route"))
    requires_auth = bool(route.get("requires_auth"))
    is_update_route = method in ("put", "patch") and not is_list_route and not is_file_upload

    query_params_hint = ""
    if is_list_route:
        params_desc = json.dumps(route["query_params"], indent=2)
        model_class = table_name_to_class.get(matched_table, "Thing") if matched_table else "Thing"
        query_params_hint = f"""
This route accepts these QUERY parameters:
{params_desc}

def list_things(min_price: float = None, max_price: float = None, limit: int = 10, offset: int = 0, db: Session = Depends(get_db)):
    query = db.query({model_class})
    if min_price is not None:
        query = query.filter({model_class}.price >= min_price)
    if max_price is not None:
        query = query.filter({model_class}.price <= max_price)
    return query.offset(offset).limit(limit).all()

- Every query parameter must be a plain function parameter with a default,
  never Query(...). Only filter on parameters actually listed above.
"""

    file_upload_hint = ""
    if is_file_upload:
        model_class = table_name_to_class.get(matched_table, "Thing") if matched_table else "Thing"
        file_upload_hint = f"""
This is a FILE UPLOAD route:

def upload_thing_image(id: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    thing = db.query({model_class}).filter({model_class}.id == id).first()
    if not thing:
        raise HTTPException(status_code=404, detail="Not found")
    os.makedirs("uploads", exist_ok=True)
    file_path = os.path.join("uploads", file.filename)
    with open(file_path, "wb") as f:
        f.write(file.file.read())
    thing.image_filename = file.filename
    db.commit()
    db.refresh(thing)
    return {{"filename": file.filename, "message": "Upload successful"}}

- Do NOT use a Pydantic response_model for this route.
"""

    auth_hint = ""
    if is_signup_route:
        class_name = table_name_to_class[matched_table]
        auth_hint = f"""
This is a SIGNUP route. Here is the EXACT pattern to follow:

def signup(user: {class_name}Create, db: Session = Depends(get_db)):
    existing = db.query({class_name}).filter({class_name}.email == user.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    hashed = hash_password(user.password)
    new_user = {class_name}(email=user.email, hashed_password=hashed)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

Rules:
- Use "hash_password(user.password)" to hash the password - this function
  already exists elsewhere, do not redefine it.
- Never store user.password directly - only store the hashed version in
  the "hashed_password" column.
- Check for an existing user with the same email BEFORE inserting, and
  raise HTTPException(400) if found (do not rely only on IntegrityError).
"""
    elif is_login_route:
        class_name = table_name_to_class[matched_table]
        auth_hint = f"""
This is a LOGIN route. Here is the EXACT pattern to follow:

def login(credentials: {class_name}Create, db: Session = Depends(get_db)):
    user = db.query({class_name}).filter({class_name}.email == credentials.email).first()
    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user.id)
    return {{"access_token": token, "token_type": "bearer"}}

Rules:
- Use "verify_password(credentials.password, user.hashed_password)" to check
  the password - this function already exists elsewhere.
- Use "create_access_token(user.id)" to generate the token - this function
  already exists elsewhere.
- Do NOT use a Pydantic response_model for this route - return the plain dict.
- Reuse "{class_name}Create" as the request body type (it already has
  "email" and "password" fields).
"""

    elif is_update_route:
        class_name = table_name_to_class[matched_table]
        auth_hint = f"""
This is an UPDATE route (partial update of an existing row). Here is
the EXACT pattern to follow:

def update_thing(id: str, item: {class_name}Update, db: Session = Depends(get_db)):
    existing = db.query({class_name}).filter({class_name}.id == id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")
    update_data = item.dict(exclude_unset=True)
    for field_name, value in update_data.items():
        setattr(existing, field_name, value)
    db.commit()
    db.refresh(existing)
    return existing

Rules:
- Use "{class_name}Update" as the request body type - this Pydantic
  class already exists elsewhere (every field on it is Optional).
- Use "item.dict(exclude_unset=True)" so a field the caller did not
  send is left unchanged, instead of being overwritten with None.
- Raise HTTPException(status_code=404) if no row with that id exists.
- Do NOT add "db: Session = Depends(get_db)" twice, and do NOT
  redefine "{class_name}Update" - it already exists elsewhere.
"""
        
    elif requires_auth:
        class_name = table_name_to_class[matched_table] if matched_table else "User"
        auth_hint = f"""
This is a PROTECTED route requiring authentication. Here is the EXACT
pattern to follow:

def get_current_user_info(current_user: {class_name} = Depends(get_current_user)):
    return current_user

Rules:
- Use "current_user: {class_name} = Depends(get_current_user)" as a parameter -
  this dependency already exists elsewhere and handles token verification.
- Do NOT add "db: Session = Depends(get_db)" unless you actually need
  additional database queries beyond what get_current_user already provides.
"""

    prompt = f"""
Generate ONLY the body of a single Python function (no decorator, no
"@app..." line - just the function itself) that will handle this route.

Method: {method.upper()}
Path: {path}
Description: {route.get('description', '')}
{class_hint}
{query_params_hint}
{file_upload_hint}
{auth_hint}

Here is the EXACT parameter pattern to follow for a route WITHOUT any of
the special cases above (copy this style precisely):

def create_thing(thing: ThingCreate, db: Session = Depends(get_db)):
    ...

def get_thing(id: str, db: Session = Depends(get_db)):
    ...

Rules:
- Follow whichever specific pattern above applies to this route.
- Define the function with "def", NEVER "async def" - no "await" anywhere.
- If the path contains "{{id}}", type it as "id: str", NEVER "id: int".
- Do NOT use Path(...), Body(...), or Query(...) anywhere.
- Wrap database commits in try/except catching IntegrityError where relevant.
- Do NOT redefine any class, function, or dependency mentioned as
  "already exists elsewhere" above.
- Output ONLY the function definition, nothing else - no decorator, no
  imports, no explanation.
"""
    raw_code = _ask_ai(prompt)
    function_only = _extract_function_body_only(raw_code)

    if is_file_upload or is_login_route:
        response_model_part = ""
    elif is_list_route and response_class:
        response_model_part = f", response_model=list[{response_class}]"
    elif response_class:
        response_model_part = f", response_model={response_class}"
    else:
        response_model_part = ""
    decorator = f'@app.{method}("{path}"{response_model_part})'

    return f"{decorator}\n{function_only}"


def _build_auth_helpers(auth_table_class: str) -> str:
    """
    These auth helper functions (password hashing, JWT creation/verification)
    follow a fixed, well-known pattern - there's no benefit to asking the AI
    to write them (they're security-sensitive and easy to get subtly wrong),
    so we write them directly in Python instead.

    The secret key is read from the SECRET_KEY environment variable - it is
    never hard-coded in the generated source.

    Uses HTTPBearer (not OAuth2PasswordBearer) so that Swagger UI's
    "Authorize" button shows a simple paste-your-token box, matching how
    our JSON-based /auth/login actually returns tokens - OAuth2PasswordBearer
    would instead show a username/password form that POSTs as form-data,
    which does not match our JSON login route.
    """
    return f'''
# --- Authentication helpers ---
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {{"sub": user_id, "exp": expire}}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

security_scheme = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security_scheme), db: Session = Depends(get_db)):
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=401, detail="Could not validate credentials",
        headers={{"WWW-Authenticate": "Bearer"}},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except jwt.PyJWTError:
        raise credentials_exception
    user = db.query({auth_table_class}).filter({auth_table_class}.id == user_id).first()
    if user is None:
        raise credentials_exception
    return user
'''


def _assemble_full_file(setup_code, model_pieces, pydantic_pieces, route_pieces, auth_helpers_code) -> str:
    parts = [setup_code, ""]
    parts.extend(model_pieces)
    parts.append("Base.metadata.create_all(bind=engine)")
    parts.append("")
    parts.extend(pydantic_pieces)
    parts.append("""
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
""")
    if auth_helpers_code:
        parts.append(auth_helpers_code)
    parts.extend(route_pieces)
    return "\n\n".join(parts)


def _is_valid_python(code: str):
    """
    Imports the assembled file in a separate process to check that it loads.

    The generated code requires SECRET_KEY (and reads DATABASE_URL) from the
    environment, so we pass harmless dummy values to the subprocess - otherwise
    validation would fail on any machine where those variables are not set.
    The dummy values are used only for this check and are never written to
    the generated file. The in-memory database keeps the check from creating
    or touching any real database file.
    """
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as tmp:
        tmp.write(code)
        tmp_path = tmp.name
    try:
        result = subprocess.run(
            [sys.executable, "-c",
             f"import importlib.util; spec = importlib.util.spec_from_file_location('m', r'{tmp_path}'); "
             f"m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)"],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "SECRET_KEY": "validation-only-key", "DATABASE_URL": "sqlite:///:memory:"},
        )
        if result.returncode == 0:
            return True, ""
        return False, result.stderr
    except subprocess.TimeoutExpired:
        return False, "Timed out"
    finally:
        os.remove(tmp_path)


def generate_backend_code_chunked(architecture_file: str = "sample_architecture.json") -> bool:
    build_log = []

    with open(architecture_file, "r") as file:
        architecture_data = json.load(file)

    _log(build_log, f"Backend Agent (chunked): starting. Reading {architecture_file}")

    has_auth = any(t.get("is_auth_table") for t in architecture_data["db_tables"])

    setup_code = """from fastapi import FastAPI, HTTPException, Depends, UploadFile, File
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, Column, String, Integer, Float, Boolean, ForeignKey, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.exc import IntegrityError
from passlib.context import CryptContext
from datetime import datetime, timedelta
import jwt
import uuid
import os

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./test.db")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()"""

    tables = architecture_data["db_tables"]
    routes = architecture_data["api_routes"]

    table_name_to_class = {t["table_name"]: _class_name_for(t["table_name"]) for t in tables}
    table_name_to_fields = {t["table_name"]: [c["name"] for c in t["columns"] if c["name"] != "id"] for t in tables}

    tables_needing_update = set()
    for route in routes:
        if route["method"] in ("PUT", "PATCH"):
            for table_name in table_name_to_class:
                if table_name in route["path"] or table_name.rstrip("s") in route["path"]:
                    tables_needing_update.add(table_name)

    model_pieces = [_generate_model_piece(t, build_log) for t in tables]
    pydantic_pieces = [
        _generate_pydantic_piece(t, t["table_name"] in tables_needing_update, build_log)
        for t in tables
    ]
    route_pieces = [
        _generate_route_piece(r, table_name_to_class, table_name_to_fields, build_log)
        for r in routes
    ]

    auth_helpers_code = ""
    if has_auth:
        auth_table = next(t for t in tables if t.get("is_auth_table"))
        auth_class = table_name_to_class[auth_table["table_name"]]
        _log(build_log, f"Backend Agent: adding authentication helpers (hashing, JWT) for '{auth_class}'...")
        auth_helpers_code = _build_auth_helpers(auth_class)

    _log(build_log, "Backend Agent: assembling all pieces into one file...")
    full_code = _assemble_full_file(setup_code, model_pieces, pydantic_pieces, route_pieces, auth_helpers_code)

    _log(build_log, "Backend Agent: validating the assembled file...")
    is_valid, error_message = _is_valid_python(full_code)

    output_folder = "generated_backend"
    os.makedirs(output_folder, exist_ok=True)

    if is_valid:
        _log(build_log, "Backend Agent: assembled file is valid. ✅")
        success = True
    else:
        last_line = error_message.strip().splitlines()[-1] if error_message.strip() else "unknown error"
        _log(build_log, f"Backend Agent: assembled file has an error — {last_line}")
        success = False

    output_path = os.path.join(output_folder, "main.py")
    with open(output_path, "w", encoding="utf-8") as file:
        file.write(full_code)
    _log(build_log, f"Backend Agent: saved to {output_path} (valid={success})")

    requirements_path = os.path.join(output_folder, "requirements.txt")
    with open(requirements_path, "w", encoding="utf-8") as file:
        file.write(REQUIREMENTS_TXT)
    _log(build_log, f"Backend Agent: saved to {requirements_path}")

    log_path = os.path.join(output_folder, "build_log.json")
    with open(log_path, "w", encoding="utf-8") as file:
        json.dump({"success": success, "steps": build_log}, file, indent=2)

    return success


if __name__ == "__main__":
    generate_backend_code_chunked(architecture_file="sample_architecture_7.json")