"""
End-to-end pipeline orchestrator.

Takes a raw idea - either spoken (an audio file, transcribed by M01) or
typed text - and runs it through the full chain:

    M01 (voice -> text, optional)
    M02 (text -> structured requirements)
    M03 Phase A (requirements -> architecture.json)
    M03 Phase B (architecture.json -> frontend_api_spec.json)
    M06 (architecture + spec -> generated backend + frontend code)
    Docker Compose (build + run both services)

...and ends with the live URLs to open in a browser.

The core logic lives in run_pipeline_core() so it can be called
directly (e.g. from a web control panel), not just from the CLI.

Usage:
    python run_pipeline.py --idea "An app where users sign up, log in, and keep a list of books."
    python run_pipeline.py --audio tests/fixtures/m01_voice_test.wav
"""

import argparse
import json
import shutil
import subprocess
import os
import sys
import re
from pathlib import Path

from modules.m07_shared_state.project_state import InMemoryProjectStateRepository
from modules.m02_requirements.engine import generate_requirements
from modules.m03_architect.architect import generate_architecture
from modules.m03_architect.frontend_spec import generate_frontend_spec
from site_builder import should_use_site, write_site

ROOT = Path(__file__).resolve().parent
M06_DIR = ROOT / "modules" / "m06_devops"
FRONTEND_TEMPLATE = M06_DIR / "frontend_template"

# Human-readable pipeline stages. Shown live in the web control panel.
PIPELINE_STEPS = [
    "Understanding your idea",
    "Designing the architecture",
    "Planning the screens",
    "Writing the backend",
    "Writing the frontend",
    "Assembling the project",
    "Building and starting Docker",
]


def _print_step(message: str) -> None:
    print(f"\n{'=' * 60}\n{message}\n{'=' * 60}")


def run_backend_agent(project_dir: Path) -> bool:
    sys.path.insert(0, str(M06_DIR))
    try:
        from backend_agent import generate_backend_code_chunked
    finally:
        sys.path.pop(0)

    import os
    original_cwd = Path.cwd()
    try:
        os.chdir(project_dir)
        return generate_backend_code_chunked(architecture_file="architecture.json")
    finally:
        os.chdir(original_cwd)


def repair_saved_backend(project_dir: Path) -> bool:
    """Re-validate and repair generated_backend/main.py left by an earlier run."""
    sys.path.insert(0, str(M06_DIR))
    try:
        from backend_agent import repair_existing_backend
    finally:
        sys.path.pop(0)

    import os
    original_cwd = Path.cwd()
    try:
        os.chdir(project_dir)
        return repair_existing_backend()
    finally:
        os.chdir(original_cwd)


def run_frontend_agent(project_dir: Path) -> bool:
    sys.path.insert(0, str(M06_DIR))
    try:
        from frontend_agent import generate_frontend_code
    finally:
        sys.path.pop(0)

    import os
    original_cwd = Path.cwd()
    try:
        os.chdir(project_dir)
        return generate_frontend_code(spec_file="frontend_api_spec.json")
    finally:
        os.chdir(original_cwd)


def assemble_project(project_dir: Path) -> None:
    """Copy the frontend scaffold and generated pages into a runnable project folder."""
    frontend_dir = project_dir / "frontend"
    if frontend_dir.exists():
        shutil.rmtree(frontend_dir)
    shutil.copytree(FRONTEND_TEMPLATE, frontend_dir)

    generated_pages = project_dir / "generated_frontend"
    pages_dir = frontend_dir / "src" / "pages"
    spec_path = project_dir / "frontend_api_spec.json"
    wanted = None
    if spec_path.exists():
        wanted = {f"{pg['name']}.jsx" for pg in json.loads(spec_path.read_text(encoding="utf-8"))["pages"]}
    for jsx_file in generated_pages.glob("*.jsx"):
        if wanted is None or jsx_file.name in wanted:
            shutil.copy(jsx_file, pages_dir / jsx_file.name)

    backend_src = project_dir / "generated_backend"
    backend_dir = project_dir / "backend"
    if backend_dir.exists():
        shutil.rmtree(backend_dir)
    shutil.copytree(backend_src, backend_dir)

    backend_dockerfile = backend_dir / "Dockerfile"
    if not backend_dockerfile.exists():
        template_dockerfile = M06_DIR / "generated_backend" / "Dockerfile"
        shutil.copy(template_dockerfile, backend_dockerfile)


def _label_for_page(page_name: str) -> str:
    """Turn 'UserSignupPage' into 'User Signup'."""
    name = page_name.removesuffix("Page")
    return re.sub(r"(?<!^)(?=[A-Z])", " ", name)


def _pretty_project_name(name: str) -> str:
    """'cafe_dogwalker_repair_service' -> 'Cafe Dogwalker Repair Service'."""
    return " ".join(w.capitalize() for w in re.split(r"[_\-\s]+", name) if w) or name


# name -> (accent, accent-2, accent rgb, accent-2 rgb, background glow). Purple/pink is the default.
UI_THEMES = {
    "green": ("#10b981", "#34d399", "16,185,129", "52,211,153", "#0b2a22"),
    "blue": ("#3b82f6", "#06b6d4", "59,130,246", "6,182,212", "#0b1f3d"),
    "red": ("#ef4444", "#f97316", "239,68,68", "249,115,22", "#2e1014"),
    "orange": ("#f97316", "#facc15", "249,115,22", "250,204,21", "#2e1d0b"),
    "pink": ("#ec4899", "#a855f7", "236,72,153", "168,85,247", "#2c1030"),
    "teal": ("#14b8a6", "#22d3ee", "20,184,166", "34,211,238", "#0a2a2c"),
}


def apply_dashboard_theme(project_dir: Path, idea_text: str) -> str | None:
    """If the idea names a colour ("green gradient", "blue theme"), recolour the dashboard."""
    text = (idea_text or "").lower()
    for name, (a1, a2, rgb1, rgb2, glow) in UI_THEMES.items():
        if re.search(rf"\b{name}\b", text):
            css = project_dir / "frontend" / "src" / "App.css"
            css.write_text(
                css.read_text(encoding="utf-8")
                + f"\n/* theme: {name} */\n:root {{ --accent: {a1}; --accent-2: {a2}; "
                  f"--accent-rgb: {rgb1}; --accent2-rgb: {rgb2}; --bg-glow: {glow}; }}\n",
                encoding="utf-8",
            )
            return name
    return None


def write_app_jsx(project_dir: Path, frontend_spec: dict) -> None:
    pages = frontend_spec["pages"]
    pretty = _pretty_project_name(frontend_spec["project_name"])
    index_html = project_dir / "frontend" / "index.html"
    if index_html.exists():
        index_html.write_text(
            index_html.read_text(encoding="utf-8").replace("__PROJECT_TITLE__", pretty),
            encoding="utf-8",
        )
    imports = "\n".join(f"import {p['name']} from './pages/{p['name']}';" for p in pages)

    nav_items = "\n".join(
        f'''        <button
          className={{"nav-item" + (active === "{p['name']}" ? " active" : "")}}
          onClick={{() => setActive("{p['name']}")}}
        >
          <span className="nav-dot"></span>
          {_label_for_page(p['name'])}
        </button>'''
        for p in pages
    )

    page_switch = "\n".join(
        f'        {{active === "{p["name"]}" && <{p["name"]} />}}'
        for p in pages
    )

    labels = {p["name"]: _label_for_page(p["name"]) for p in pages}
    labels_js = ", ".join(f'"{name}": "{label}"' for name, label in labels.items())

    first_page = pages[0]["name"] if pages else ""

    content = f"""import {{ useState }} from 'react';
{imports}
import './App.css';

const PAGE_LABELS = {{{labels_js}}};

function App() {{
  const [active, setActive] = useState("{first_page}");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="dot"></span>
          {pretty}
        </div>
        <div className="sidebar-section-label">Pages</div>
{nav_items}
      </aside>

      <main className="content">
        <div className="topbar">
          <h1>{{PAGE_LABELS[active]}}</h1>
          <span className="crumb">{pretty}</span>
        </div>
        <div className="page-body">
{page_switch}
        </div>
      </main>
    </div>
  );
}}

export default App;
"""
    (project_dir / "frontend" / "src" / "App.jsx").write_text(content, encoding="utf-8")


def write_docker_compose(project_dir: Path, backend_port: int, frontend_port: int) -> None:
    content = f"""services:
  backend:
    build: ./backend
    ports:
      - "{backend_port}:8000"
    container_name: pipeline_backend
    environment:
      - SECRET_KEY=${{SECRET_KEY}}
      - DATABASE_URL=sqlite:////data/app.db
    volumes:
      - backend_data:/data
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 5s
      timeout: 3s
      retries: 10

  frontend:
    build: ./frontend
    ports:
      - "{frontend_port}:5173"
    container_name: pipeline_frontend
    depends_on:
      backend:
        condition: service_healthy

volumes:
  backend_data:
"""
    (project_dir / "docker-compose.yml").write_text(content, encoding="utf-8")
    (project_dir / ".env").write_text("SECRET_KEY=pipeline-demo-secret-key\n", encoding="utf-8")


def run_pipeline_core(
    idea_text: str | None = None,
    audio_path: str | None = None,
    project_name: str = "pipeline_demo",
    backend_port: int = 8010,
    frontend_port: int = 5180,
    on_step=None,
    resume_project: str | None = None,
) -> dict:
    """
    Core pipeline logic, callable directly (used by both the CLI and
    a future web control panel). Returns a dict describing the
    outcome - never raises for a generation failure (M02/M03/M06
    returning invalid=False is reported in the result instead), but
    does propagate unexpected exceptions (missing files, Docker not
    running, etc.) so the caller can decide how to show those.
    """
    if not idea_text and not audio_path and not resume_project:
        raise ValueError("Provide either idea_text or audio_path.")

    def _step(index: int) -> None:
        """Tell the caller (e.g. the web panel) which stage just started."""
        if on_step is not None:
            on_step(index, PIPELINE_STEPS[index])

    if resume_project:
        project_name = resume_project

    repo = InMemoryProjectStateRepository()
    project_dir = ROOT / "pipeline_runs" / project_name
    project_dir.mkdir(parents=True, exist_ok=True)

    arch_file = project_dir / "architecture.json"
    spec_file = project_dir / "frontend_api_spec.json"
    req_file = project_dir / "requirements.json"
    # Resume only if an earlier run already saved the architecture and spec.
    resuming = bool(resume_project) and arch_file.exists() and spec_file.exists()

    if resuming:
        _print_step("RESUMING: reusing the saved requirements, architecture and frontend spec")
        resolved_idea_text = idea_text or ""
        architecture = json.loads(arch_file.read_text(encoding="utf-8"))
        frontend_spec = json.loads(spec_file.read_text(encoding="utf-8"))
        if req_file.exists():
            requirements = json.loads(req_file.read_text(encoding="utf-8"))
        else:
            requirements = {
                "project_name": frontend_spec.get("project_name", project_name),
                "features": [],
            }
        for index in (0, 1, 2):
            _step(index)
    else:
        if idea_text:
            resolved_idea_text = idea_text
        else:
            _print_step("STEP 1: M01 - Transcribing audio")
            from modules.m01_sensory.service import normalize_audio
            result = normalize_audio(audio_path)
            print(f"Transcribed: \"{result.text}\"")
            resolved_idea_text = result.text

        _step(0)
        _print_step("STEP 2: M02 - Generating requirements")
        _, requirements = generate_requirements(
            raw_idea=resolved_idea_text, project_id=project_name, repo=repo,
        )
        req_file.write_text(json.dumps(requirements, indent=2), encoding="utf-8")
        print(f"project_name: {requirements['project_name']}")
        print(f"features: {[f['name'] for f in requirements['features']]}")

        _step(1)
        _print_step("STEP 3: M03 Phase A - Generating architecture")
        _, architecture = generate_architecture(
            requirements=requirements, project_id=project_name, repo=repo,
        )
        print(f"tables: {[t['table_name'] for t in architecture['db_tables']]}")
        print(f"routes: {[(r['method'], r['path']) for r in architecture['api_routes']]}")

        _step(2)
        _print_step("STEP 4: M03 Phase B - Deriving frontend spec")
        frontend_spec = generate_frontend_spec(
            architecture, base_url=f"http://127.0.0.1:{backend_port}"
        )
        print(f"pages: {[p['name'] for p in frontend_spec['pages']]}")

        (project_dir / "architecture.json").write_text(
            json.dumps(architecture, indent=2), encoding="utf-8"
        )
        (project_dir / "frontend_api_spec.json").write_text(
            json.dumps(frontend_spec, indent=2), encoding="utf-8"
        )

    _step(3)
    _print_step("STEP 5: M06 - Generating backend code")
    backend_ok = False
    if resuming and (project_dir / "generated_backend" / "main.py").exists():
        # Salvage the backend from the earlier run instead of regenerating it.
        backend_ok = repair_saved_backend(project_dir)
    if not backend_ok:
        backend_ok = run_backend_agent(project_dir)
    if not backend_ok:
        return {"success": False, "error": "Backend generation failed.", "idea_text": resolved_idea_text}

    _step(4)
    _print_step("STEP 6: M06 - Generating frontend code")
    frontend_ok = run_frontend_agent(project_dir)
    if not frontend_ok:
        return {"success": False, "error": "Frontend generation failed.", "idea_text": resolved_idea_text}

    _step(5)
    _print_step("STEP 7: Assembling runnable project")
    assemble_project(project_dir)
    # UI style: "auto" (default) builds a real website when the idea is a site
    # (hours / gallery / contact ...), otherwise the generic dashboard.
    # Force with CTO_UI_STYLE=site or CTO_UI_STYLE=app.
    idea_file = project_dir / "idea.txt"          # remember the idea so a later --resume keeps the colour/style
    if resolved_idea_text:
        idea_file.write_text(resolved_idea_text, encoding="utf-8")
    elif idea_file.exists():
        resolved_idea_text = idea_file.read_text(encoding="utf-8")
    ui_style = os.environ.get("CTO_UI_STYLE", "auto").lower()
    if ui_style == "site" or (ui_style == "auto" and should_use_site(resolved_idea_text, requirements)):
        site_info = write_site(project_dir, resolved_idea_text, requirements, frontend_spec)
        print(f"UI style: website '{site_info['name']}' (AI design: {site_info['ai']}; {site_info['look']}; sections: {site_info['sections']})")
    else:
        write_app_jsx(project_dir, frontend_spec)
        theme = apply_dashboard_theme(project_dir, resolved_idea_text)
        print(f"UI style: app dashboard (colour theme: {theme or 'default purple'})")
    write_docker_compose(project_dir, backend_port, frontend_port)
    print(f"Project assembled at: {project_dir}")

    _step(6)
    _print_step("STEP 8: Building and starting Docker containers")
    # The containers use fixed names, so remove leftovers from an earlier run
    # first; otherwise Docker refuses with "container name already in use".
    subprocess.run(
        ["docker", "rm", "-f", "pipeline_backend", "pipeline_frontend"],
        cwd=project_dir, check=False, capture_output=True,
    )
    subprocess.run(
        ["docker", "compose", "up", "--build", "-d"],
        cwd=project_dir, check=True,
    )

    _print_step("DONE")
    backend_url = f"http://localhost:{backend_port}/docs"
    frontend_url = f"http://localhost:{frontend_port}"
    print(f"Backend:  {backend_url}")
    print(f"Frontend: {frontend_url}")

    return {
        "success": True,
        "idea_text": resolved_idea_text,
        "project_name": requirements["project_name"],
        "features": [f["name"] for f in requirements["features"]],
        "tables": [t["table_name"] for t in architecture["db_tables"]],
        "pages": [p["name"] for p in frontend_spec["pages"]],
        "backend_url": backend_url,
        "frontend_url": frontend_url,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--idea", help="Type the idea directly instead of using audio.")
    parser.add_argument("--audio", help="Path to an audio file to transcribe with M01.")
    parser.add_argument("--project-name", default="pipeline_demo")
    parser.add_argument("--resume", help="Folder name inside pipeline_runs to continue from (reuses saved architecture and backend).")
    parser.add_argument("--backend-port", type=int, default=8010)
    parser.add_argument("--frontend-port", type=int, default=5180)
    args = parser.parse_args()

    if not args.idea and not args.audio and not args.resume:
        parser.error("Provide either --idea \"text\" or --audio path/to/file.wav")

    result = run_pipeline_core(
        idea_text=args.idea,
        audio_path=args.audio,
        project_name=args.project_name,
        backend_port=args.backend_port,
        frontend_port=args.frontend_port,
        resume_project=args.resume,
    )

    if result["success"]:
        print(f"\nTo stop: cd {ROOT / 'pipeline_runs' / (args.resume or args.project_name)} && docker compose down")
    else:
        print(f"\nFailed: {result['error']}")


if __name__ == "__main__":
    main()