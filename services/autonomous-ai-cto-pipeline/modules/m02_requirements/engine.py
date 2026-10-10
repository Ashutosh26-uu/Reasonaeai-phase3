"""M02 Requirement Engineering Engine.

Converts a raw user idea (plain text) into a structured, versioned
project specification: project name, actors, features, constraints,
and acceptance criteria. This is the Architect's (M03) input - M02
does not make any implementation decisions (no table names, no API
routes, no tech stack).

Same pattern as the other generation agents in this project
(backend_agent.py, frontend_agent.py): ask the model for a concrete
JSON example in the exact shape wanted, validate the result, and
retry with the error fed back to the model on failure.
"""

import os
import json
from datetime import datetime

import ollama

from modules.m07_shared_state.project_state import (
    ProjectSpecificationRecord,
    ProjectStateRepository,
)

CODER_MODEL = os.environ.get("CTO_MODEL", "qwen2.5-coder:7b")  # e.g. set CTO_MODEL=qwen2.5-coder:3b for a faster run
MAX_ATTEMPTS = 3

REQUIRED_KEYS = {
    "project_name",
    "actors",
    "features",
    "constraints",
    "acceptance_criteria",
}

EXAMPLE_OUTPUT = """
Here is a WORKING EXAMPLE of the exact JSON shape required, for an idea
about "an app where users can sign up, log in, and manage a list of
products with prices":

{
  "project_name": "product_manager",
  "actors": ["user"],
  "features": [
    {
      "name": "User authentication",
      "description": "Users can sign up with an email and password, then log in to receive an access token.",
      "priority": "must-have"
    },
    {
      "name": "Product management",
      "description": "A logged-in user can create products with a name and price, and view a list of their products.",
      "priority": "must-have"
    }
  ],
  "constraints": [
    "No paid third-party APIs may be used.",
    "Passwords must be stored hashed, never in plain text."
  ],
  "acceptance_criteria": [
    "A new user can sign up and then log in with the same credentials.",
    "A logged-in user can create a product and see it appear in their product list."
  ]
}

Adapt every field to the actual idea given below - do not reuse this
example's project name, actors, features, constraints, or acceptance
criteria unless they genuinely apply.
"""

RULES = """
Rules:
- Output ONLY a single valid JSON object. No markdown, no code fences,
  no explanation before or after it.
- The JSON object MUST have exactly these top-level keys:
  "project_name", "actors", "features", "constraints",
  "acceptance_criteria".
- "project_name" is a short lowercase_with_underscores string.
- "actors" is a list of short strings (e.g. "user", "admin").
- "features" is a list of objects, each with "name", "description",
  and "priority" ("must-have" or "nice-to-have").
- "constraints" is a list of plain-English constraint strings.
- "acceptance_criteria" is a list of plain-English, testable
  statements describing when a feature is considered done.
- Do NOT invent a technology stack, database table names, or API
  routes - that is a different team's job. Describe only WHAT the
  product must do, not HOW it will be built.
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


def _validate_requirements(data: dict) -> tuple[bool, str]:
    if not isinstance(data, dict):
        return False, "Top-level JSON value must be an object."

    missing = REQUIRED_KEYS - set(data.keys())
    if missing:
        return False, f"Missing required keys: {sorted(missing)}"

    if not isinstance(data["actors"], list) or not data["actors"]:
        return False, "'actors' must be a non-empty list of strings."

    if not isinstance(data["features"], list) or not data["features"]:
        return False, "'features' must be a non-empty list."

    for feature in data["features"]:
        if not isinstance(feature, dict):
            return False, "Each feature must be an object."
        if not {"name", "description", "priority"} <= set(feature.keys()):
            return False, "Each feature needs name, description, priority."
        if feature["priority"] not in ("must-have", "nice-to-have"):
            return False, "feature priority must be must-have or nice-to-have."

    if not isinstance(data["constraints"], list):
        return False, "'constraints' must be a list."

    if not isinstance(data["acceptance_criteria"], list) or not data["acceptance_criteria"]:
        return False, "'acceptance_criteria' must be a non-empty list."

    return True, ""


def generate_requirements(
    raw_idea: str,
    project_id: str,
    repo: ProjectStateRepository,
) -> tuple[ProjectSpecificationRecord, dict]:
    """
    Turn a raw idea into structured requirements, validate the result,
    save it into the shared project state (M07), and return both the
    saved record and the parsed requirements dict.

    Raises RuntimeError if a valid requirements JSON could not be
    produced after MAX_ATTEMPTS tries.
    """
    build_log: list = []

    base_prompt = f"""
You are a requirements analyst, not a software engineer. Read the idea
below and turn it into a structured requirements specification.

Idea: {raw_idea}

{RULES}
{EXAMPLE_OUTPUT}
"""

    conversation = [{"role": "user", "content": base_prompt}]
    requirements: dict | None = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt == 1:
            _log(build_log, "Requirement Engine: generating requirements...")
        else:
            _log(build_log, f"Requirement Engine: fixing requirements (attempt {attempt}/{MAX_ATTEMPTS})...")

        # Hard limits so a slow CPU can never loop for an hour: JSON-only output, capped length, 15 min timeout.
        response = ollama.Client(timeout=900).chat(
            model=CODER_MODEL, messages=conversation, format="json",
            options={"num_predict": 1800, "temperature": 0.2},
        )
        raw_output = response["message"]["content"]
        cleaned = _clean_json_text(raw_output)

        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            error_message = f"Output was not valid JSON: {exc}"
            _log(build_log, f"Requirement Engine: {error_message}")
            conversation.append({"role": "assistant", "content": raw_output})
            conversation.append({
                "role": "user",
                "content": f"{error_message}\n\nOutput ONLY the corrected, complete JSON object - nothing else."
            })
            continue

        is_valid, error_message = _validate_requirements(parsed)
        if is_valid:
            _log(build_log, "Requirement Engine: requirements are valid. \u2705")
            requirements = parsed
            break

        _log(build_log, f"Requirement Engine: found a problem \u2014 {error_message}")
        conversation.append({"role": "assistant", "content": raw_output})
        conversation.append({
            "role": "user",
            "content": f"That JSON has a problem: {error_message}\n\nOutput ONLY the corrected, complete JSON object - nothing else."
        })

    if requirements is None:
        raise RuntimeError(
            f"Requirement Engine: could not produce valid requirements after {MAX_ATTEMPTS} attempts."
        )

    record = repo.save_requirements(
        project_id=project_id,
        raw_idea=raw_idea,
        requirements=requirements,
    )

    return record, requirements