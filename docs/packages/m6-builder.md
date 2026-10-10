# M6 Builder Agents (Backend, Frontend, Docker)

**Status:** 🟡
**Owns:** agents/m6-builder/ (backend_agent.py, frontend_agent.py, docker-compose.yml)
**Owner role:** Disha (Frontend + Backend + DevOps)

## Purpose
Takes an architecture JSON (tables + API routes) and generates a working
FastAPI backend and React frontend using a local LLM (qwen2.5-coder:7b via
Ollama, no paid APIs). Output runs in Docker with one command.

## Public surface
| Name | Kind | Purpose |
|---|---|---|
| generate_backend_code_chunked(architecture_file) | function | JSON -> generated_backend/main.py + requirements.txt, returns bool |
| generate_frontend_code(spec_file) | function | frontend spec JSON -> .jsx pages, returns bool |
| docker-compose.yml | config | backend + frontend, healthcheck, persistent volume |

Input JSON: db_tables[] (optional is_auth_table), api_routes[] (optional
query_params, is_file_upload, is_signup_route, is_login_route, requires_auth).

## Key invariants
| Invariant | Defended by |
|---|---|
| IDs are string UUIDs, never a UUID column type | forbidden-pattern retry in model generation; manual check |
| Passwords stored hashed, never returned in responses | auth schema generation; manual check |
| Route decorators are built by Python, not by the LLM | _generate_route_piece |
| SECRET_KEY / DATABASE_URL come from environment | generated main.py; manual check |
| Generated file must import without error | _is_valid_python |

No automated test defends these yet (see limitations).

## How it works
The backend is generated in small pieces (one model per table, one schema
set per table, one function per route), then assembled by Python and
validated by importing it. Failures are retried, errors are logged to
build_log.json.

## Extending it
Add a new route type by adding a flag in the JSON, a concrete code example
in _generate_route_piece, and a verification run.

## Testing
Verified manually through Swagger: 1-3 table CRUD, filter/pagination,
file upload, signup/login/protected route, Docker restart persistence.
No automated test suite.

## Current limitations
- No automated tests.
- Not supported: many-to-many, roles, ownership rules, payments.
- Frontend generates form-style pages; list and upload page templates
  are not yet verified.
- Tested only with qwen2.5-coder:7b on an 8GB machine.
- Python stack inside a TypeScript repo; integration point to be agreed.