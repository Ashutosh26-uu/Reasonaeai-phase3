# Autonomous AI CTO

**An AI system that turns a spoken or typed idea into a running web application.**

You tell it what you want to build. It writes the requirements, designs the architecture, generates the backend and frontend code, and starts the finished app in Docker. Everything runs on our own laptops with open-source tools. No paid APIs are used.


---

## 1. Why we built this

Most people with a good app idea cannot code, and writing even a simple app takes days. We wanted to see how far a small team of AI "agents" could go if each one has a single, clear job, like a real software company with a CTO, a backend developer and a frontend developer.

The main rule of our project: **no paid AI services**. Everything (speech recognition, the language model and the app runtime) runs locally, so there are no recurring costs.

## 2. What it can do

- **Voice or text input.** Speak your idea into the microphone (Whisper turns it into text) or type it.
- **Requirements.** The idea is converted into a structured list of features.
- **Architecture.** The system designs database tables and API routes.
- **Backend generation.** A FastAPI + SQLAlchemy backend is written piece by piece (models, schemas, routes, authentication) and then validated and repaired automatically.
- **Frontend generation.** A React + Vite frontend is created. Business ideas (café, bakery, yoga studio, etc.) become a real one-page website; app ideas (employee system, to-do list) become a dashboard.
- **One-click run.** The finished app is built and started with Docker Compose.
- **Control panel with accounts and history.** A web page (`localhost:9000`) where users sign up, log in, build apps and see every past build.

## 3. How it works

```
 Voice / Text idea
        |
   M01  Sensory        speech -> text (Whisper) + text cleanup
        |
   M02  Requirements   idea -> requirements.json
        |
   M03  Architect      requirements -> architecture.json (tables, API routes)
        |               architecture -> frontend_api_spec.json (pages)
        |
   M06  Backend agent  architecture -> generated_backend/main.py
        |  Frontend agent  spec -> React pages + site / dashboard layout
        |
   Assemble project  ->  Docker Compose  ->  running app
```

### Modules

| Module | Folder | Purpose |
|---|---|---|
| M01 | `modules/m01_sensory` | Converts audio to text with OpenAI Whisper and normalizes the text. |
| M02 | `modules/m02_requirements` | Turns the raw idea into structured, validated requirements (JSON). |
| M03 | `modules/m03_architect` | Phase A: designs database tables and API routes. Phase B: derives the frontend page specification. |
| M06 | `modules/m06_devops` | Backend agent, frontend agent, frontend template (React + Vite) and Docker Compose files. |
| M07 | `modules/m07_shared_state` | Shared project state used by the agents. |
| M08 - M10 | `modules/m08_sandbox`, `m09_qa`, `m10_interaction` | Sandbox execution, QA and interaction modules. They are exercised by the integration test scripts and are not part of the one-click flow yet. |

### The agents work in separate roles

The architect never writes code. The backend agent only knows the architecture. The frontend agent only knows the API specification. They communicate through files (`architecture.json`, `frontend_api_spec.json`), not by chatting with each other, so each step stays small and checkable.

### Making a small local model reliable

A 3B or 7B model running on a laptop makes mistakes. To handle this we added several safeguards:

- JSON-only output, a maximum output length and a timeout on every model call, so a slow step can never hang for hours.
- The backend is generated **one piece at a time** (one model, one route, etc.) and then assembled.
- The assembled file is validated. Known recurring mistakes are repaired automatically (for example duplicate keyword arguments, single-record routes declared as lists, and response fields that can be empty).
- If repair fails, the models and schemas are rebuilt from safe built-in templates.

## 4. Two kinds of generated UI

The system picks the UI style automatically from the idea.

**Website style** (ideas such as a café site, dog walker, repair shop, bakery or yoga studio)
- A real one-page site: hero, opening hours, gallery and contact form, built from the features requested.
- The local model writes a small *design brief* (business name, colours, font, hero layout, card style, gallery layout, text). If the model is too slow, a built-in design is used and it still varies per project.
- Colour words in the idea ("red", "blue", "green") and "dark" are respected.
- The contact form is connected to the generated backend.

**Dashboard style** (ideas such as an employee system, to-do app or book tracker)
- Sidebar navigation with one page per feature, wired to the generated API.
- Colour theme follows the idea ("green gradient", "blue", "red", "orange", "pink", "teal"). Purple/pink is the default.

## 5. Requirements

- **Windows, macOS or Linux** (developed on Windows 11)
- **Python 3.10 or newer** (developed on Python 3.13)
- **Docker Desktop** (must be running)
- **Ollama** with a coding model (https://ollama.com)
- **ffmpeg** (needed by Whisper for voice input)
- A modern browser (Chrome recommended; the microphone needs `localhost`)
- At least 8 GB RAM; 16 GB is more comfortable

## 6. Setup

```powershell
# 1. Open the project folder, then create and activate a virtual environment
python -m venv .venv
.venv\Scripts\activate

# 2. Install the Python packages
pip install -r requirements.txt

# 3. Download the language model (one time)
ollama pull qwen2.5-coder:7b
# Faster option for laptops without a GPU:
ollama pull qwen2.5-coder:3b
```

On macOS/Linux, activate with `source .venv/bin/activate`.

## 7. Running it

### Option A: Control panel (recommended)

```powershell
python control_panel_server.py
```

1. Open **http://localhost:9000**.
2. **Sign up** (name, email, password) and log in.
3. Press the microphone and speak, or click one of the example ideas, or type your own.
4. Check the transcript and press **Build app**.
5. Watch the live progress. When it finishes, use **Open the app** and **API docs**.

The **My builds** section lists every past build with its status, features and time. For each build you can **Open again** (restart that app without regenerating it), **Retry**, **Use idea** (copy it back into the editor) or **Delete**.

### Option B: Command line

```powershell
python run_pipeline.py --idea "An app where users sign up, log in, and keep a list of books."
python run_pipeline.py --audio path\to\voice.wav
python run_pipeline.py --resume <folder-in-pipeline_runs> --backend-port 9100 --frontend-port 9200
```

`--resume` reuses a saved architecture and backend and only rebuilds the frontend and Docker containers, which takes about a minute.

### Where things run

| What | Address |
|---|---|
| Control panel | http://localhost:9000 |
| Generated backend (API docs) | http://localhost:9100/docs |
| Generated frontend | http://localhost:9200 |

Each build is saved in `pipeline_runs/<project-name>/`. Only one generated app can run at a time because the ports are fixed. To stop an app:

```powershell
cd pipeline_runs\<project-name>
docker compose down
```

## 8. Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CTO_MODEL` | `qwen2.5-coder:7b` | Ollama model used by M02, M03 and the backend agent. Use `qwen2.5-coder:3b` for a much faster run. |
| `CTO_FRONTEND_MODE` | `template` | `template` builds pages instantly. `llm` lets the model write every page (very slow on a CPU). |
| `CTO_UI_STYLE` | `auto` | Force `site` (website) or `app` (dashboard). |
| `CTO_AI_DESIGN` | `1` | Set to `0` to skip the AI design brief for websites. |
| `CTO_AI_DESIGN_TIMEOUT` | `300` | Seconds to wait for the AI design brief. |

PowerShell example:

```powershell
$env:CTO_MODEL = "qwen2.5-coder:3b"
python control_panel_server.py
```

## 9. Accounts and history

The control panel stores users and build history in a local SQLite file, `panel_data.db` (created automatically). Passwords are salted and hashed with scrypt, login tokens are stored only as SHA-256 hashes and expire after 7 days. Each user can only see and delete their own builds. Do not share this file.

## 10. Project structure

```
autonomous-ai-cto/
  control_panel.html        Web UI of the control panel
  control_panel_server.py   Local server: build API, login, history
  panel_store.py            SQLite store for users, sessions and history
  run_pipeline.py           The whole pipeline (CLI + function used by the panel)
  site_builder.py           Website-style frontend builder (AI design brief)
  modules/
    m01_sensory/            Whisper + text normalization
    m02_requirements/       Idea -> requirements
    m03_architect/          Architecture + frontend spec
    m06_devops/             Backend agent, frontend agent, frontend template
    m07_shared_state/       Shared project state
    m08_sandbox/  m09_qa/  m10_interaction/
  pipeline_runs/            Every generated project (code, docker-compose, specs)
  tests/  examples/         Tests and sample apps
  requirements.txt
```

## 11. Tests

Test scripts are included for the individual modules (for example `m02_requirements_test.py`, `m03_architect_test.py`, `m03_frontend_spec_test.py`, `m06_m08_test.py`, `m07_project_state_test.py`) and for the full pipeline (`full_pipeline_m08_m10_test.py`, `full_runtime_m10_test.py`), plus the `tests/` folder (unit and integration).

## 12. Limitations (honest list)

- **Speed.** On a laptop CPU the language model is slow. With the 3B model a small app takes about 10 minutes; the 7B model can be several times slower.
- **Model mistakes.** The generated backend is written by a small model and can contain bugs. The generator repairs the common ones, but not every one.
- **Dashboard design.** App-style frontends use one sidebar layout with a form page per feature. Only the colour theme changes.
- **Gallery images.** Website galleries use coloured tiles with icons, not real photographs.
- **No third-party services.** Payments, Google login, e-mail sending and similar integrations are not generated.
- **One app at a time.** The backend and frontend use fixed ports.
- **Accounts** exist only in the control panel, not inside the generated apps' own website layouts.

## 13. Future work

- More dashboard layouts (top navigation, card home page) and table/card views for lists.
- Real images in galleries.
- "Smart handoff": pause and ask the user for API keys when an external service is needed.
- Wire the sandbox and QA modules (M08, M09) into the main flow so the system tests and fixes its own code.
- Text-to-speech progress updates (the system speaking back to the user).

## 14. Technology used

Python, OpenAI Whisper, Ollama (Qwen2.5-Coder), FastAPI, SQLAlchemy, SQLite, React, Vite, Docker and Docker Compose.

---

*This project uses only open-source tools and runs entirely on a local machine.*