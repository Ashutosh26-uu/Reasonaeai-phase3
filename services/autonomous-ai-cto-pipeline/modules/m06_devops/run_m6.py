"""
M6 entry point.

Runs the Backend Agent and Frontend Agent for one project, then writes a
single m6_result.json describing what happened - this is the artifact
M7 (Shared State) reads to know whether M6 succeeded and what changed.

Usage:
    python run_m6.py --architecture sample_architecture_7.json --frontend-spec frontend_api_spec.json
"""

import argparse
import json
import os
from datetime import datetime, timezone

from backend_agent import generate_backend_code_chunked
from frontend_agent import generate_frontend_code


def _read_build_log(path: str) -> dict:
    if not os.path.exists(path):
        return {"success": False, "steps": [f"build log not found at {path}"]}
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def run_m6(architecture_file: str, frontend_spec_file: str) -> dict:
    started_at = datetime.now(timezone.utc).isoformat()
    errors = []
    changed_files = []

    backend_success = False
    try:
        backend_success = generate_backend_code_chunked(architecture_file=architecture_file)
    except Exception as exc:
        errors.append(f"backend generation raised: {exc}")

    backend_log = _read_build_log(os.path.join("generated_backend", "build_log.json"))
    if not backend_success:
        errors.append("backend build_log.json reports success=false")
    if backend_success:
        changed_files.append("generated_backend/main.py")
        changed_files.append("generated_backend/requirements.txt")

    frontend_success = False
    try:
        frontend_success = generate_frontend_code(spec_file=frontend_spec_file)
    except Exception as exc:
        errors.append(f"frontend generation raised: {exc}")

    frontend_log = _read_build_log(os.path.join("generated_frontend", "build_log.json"))
    if not frontend_success:
        errors.append("frontend build_log.json reports success=false")
    if frontend_success:
        with open(frontend_spec_file, "r", encoding="utf-8") as file:
            spec_data = json.load(file)
        for page in spec_data["pages"]:
            changed_files.append(f"generated_frontend/{page['name']}.jsx")

    overall_success = backend_success and frontend_success

    result = {
        "task_type": "m6_devops_integration",
        "status": "success" if overall_success else "failed",
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "changed_files": changed_files,
        "build_status": {
            "backend": "success" if backend_success else "failed",
            "frontend": "success" if frontend_success else "failed",
        },
        "errors": errors,
        "evidence": {
            "backend_build_log": backend_log,
            "frontend_build_log": frontend_log,
        },
    }

    with open("m6_result.json", "w", encoding="utf-8") as file:
        json.dump(result, file, indent=2)

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--architecture", default="sample_architecture_7.json")
    parser.add_argument("--frontend-spec", default="frontend_api_spec.json")
    args = parser.parse_args()

    outcome = run_m6(args.architecture, args.frontend_spec)
    print(f"\nM6 finished: status={outcome['status']}")
    if outcome["errors"]:
        print("Errors:")
        for err in outcome["errors"]:
            print(f"  - {err}")