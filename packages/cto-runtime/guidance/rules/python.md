---
name: python
description: "Python 3.11 conventions: typing, FastAPI and pydantic boundaries, async correctness, testing, tooling."
always: false
globs: ["**/*.py", "**/pyproject.toml", "**/requirements*.txt"]
---

# Python
The sandbox provides Python 3.11 with FastAPI, pydantic, uvicorn, httpx, pytest, ruff, pandas, numpy, matplotlib, seaborn, plotly, openpyxl, Pillow, and PyYAML preinstalled.

## Language
- Use 3.11 syntax: `list[str]`, `dict[str, Any]`, `str | None`, `match` for closed variants. Do not import `Optional`/`List`/`Dict` from `typing` for new code.
- Annotate every public function's parameters and return. Use `-> None` explicitly.
- Dataclasses for internal value objects (`@dataclass(frozen=True, slots=True)`); pydantic models for anything crossing a boundary (request, response, config, file).
- Never use a mutable default argument. Use `None` and construct inside.
- Manage resources with `with`/`async with`; `pathlib.Path` for paths instead of `os.path` string surgery.
- Comprehensions for simple transforms; a generator when the result is consumed once; an explicit loop when there is control flow.
- No bare `except:`. Catch the specific exception, or `except Exception` only at a top-level boundary where you log and re-raise or map it. `except ...: pass` is never acceptable.
- Prefer structured errors: define a small exception hierarchy for domain failures and let the boundary map it to a response.

## FastAPI
- Declare dependencies with `Annotated[T, Depends(...)]`; keep dependency functions small and side-effect free.
- Every route declares `response_model` (or returns a typed pydantic model) and a status code; never return a raw dict or ORM object.
- Request bodies and query parameters are pydantic models. Validate query constraints with `Query(...)`/`Path(...)` bounds rather than manual checks.
- Use the `lifespan` async context manager for startup and shutdown. Do not use the deprecated `@app.on_event`.
- Raise `HTTPException(status_code=..., detail=...)` for expected failures, with a detail that is safe to expose. Map unexpected exceptions in one handler that logs the cause and returns a generic 500.
- Never return the ORM entity or its `__dict__`; serialize through the response model.

## Async
- An `async def` route must not block the event loop. No `requests`, `time.sleep`, `open()` on large files, or a synchronous database driver inside it — use `httpx`, `asyncio.sleep`, and an async driver, or move the work to a thread with `anyio.to_thread.run_sync`.
- Set explicit timeouts on every outbound HTTP call and database query.
- Bound concurrency with a semaphore or `asyncio.TaskGroup`; never create unbounded background tasks.
- Use `asyncio.TaskGroup` for structured concurrency so one failure cancels its siblings; handle cancellation instead of swallowing it.
- Never share a mutable global across requests. Keep per-request state in dependencies or the request scope.

## Configuration and secrets
- Read configuration from the environment once, validated by a pydantic settings model, and fail fast with a clear message when a required value is missing.
- Never hardcode a credential, token, or connection string. Never print one, including in a traceback or debug log.

## Tests
- `pytest` with fixtures for setup and teardown; no state carried between tests.
- Assert observable behavior and error types (`pytest.raises(ValueError, match=...)`), not implementation details or log text.
- Use `httpx.AsyncClient` with the ASGI transport for route tests; never require a live server bind.
- No `sleep` for synchronization. Inject the clock or await the actual condition.

## Tooling
- `ruff check .` and `ruff format .` before declaring work done; fix the reported issues instead of ignoring them.
- Dependencies belong in `pyproject.toml` (or a pinned `requirements.txt`); pin versions for reproducible installs. Create a project environment with `python -m venv --system-site-packages .venv` so the preinstalled libraries stay available; do not reinstall them.
- Type-check a library-shaped project with `mypy` only if the project already uses it; otherwise keep annotations accurate by hand.
