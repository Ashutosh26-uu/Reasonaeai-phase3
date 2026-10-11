"""Dashboard engine for app-style projects.

Reads the user's words:
  "everything in one dashboard" / nothing about dashboards  -> ONE dashboard (like before, plus an overview)
  "separate dashboards for admin and employee" / "alag alag" -> one dashboard PER ROLE, each with its own
                                                               pages, overview, and colour tint
In separate mode the app opens on a "choose your dashboard" screen. If the user is logged in and the
backend has a "who am I" route that returns a `role`, the matching dashboard opens automatically.
"""
import json
import re
from pathlib import Path

STOP = {"a", "an", "the", "one", "single", "separate", "different", "individual", "distinct", "dedicated", "multiple", "own",
        "each", "every", "main", "modern", "clean", "simple", "new", "good", "beautiful", "nice", "great", "responsive",
        "friendly", "green", "blue", "red", "orange", "pink", "teal", "purple", "yellow", "black", "white", "dark", "light",
        "gradient", "with", "and", "or", "for", "to", "of", "in", "your", "their", "its", "my", "our", "role", "based", "web",
        "mobile", "user-friendly", "full", "complete", "proper", "real", "basic", "custom", "alag", "all", "this", "that",
        "dashboard", "dashboards", "panel", "portal", "banao", "bana", "chahiye", "mujhe", "hai", "ek", "ka", "ki", "ke", "liye", "lie",
        "aur", "ya", "kar", "do", "wala", "wali", "good-looking", "attractive", "professional", "stylish", "cool"}
LEVEL3 = {"admin", "administrator", "owner", "superadmin", "super", "hr", "principal", "director"}
LEVEL2 = {"manager", "teacher", "doctor", "supervisor", "lead", "staff", "moderator", "coach", "trainer", "seller", "vendor",
          "instructor", "faculty", "receptionist", "librarian"}
ICONS = {"admin": "🛡️", "administrator": "🛡️", "owner": "👑", "manager": "💼", "hr": "🧑‍💼", "employee": "🧑‍🔧", "staff": "🧑‍💼",
         "student": "🎓", "teacher": "🧑‍🏫", "customer": "🛍️", "client": "🤝", "doctor": "🩺", "patient": "🧑‍⚕️", "seller": "🏪",
         "vendor": "🏪", "buyer": "🛒", "user": "👤", "member": "🪪", "parent": "👪", "driver": "🚚", "trainer": "🏋️"}
TINTS = [  # extra dashboards get their own colour (unless the user asked for one colour)
    None,
    {"--accent": "#14b8a6", "--accent-2": "#22d3ee", "--accent-grad": "linear-gradient(135deg, #14b8a6 0%, #22d3ee 100%)", "--accent-rgb": "20,184,166", "--accent2-rgb": "34,211,238", "--bg-glow": "#0a2a2c"},
    {"--accent": "#f97316", "--accent-2": "#facc15", "--accent-grad": "linear-gradient(135deg, #f97316 0%, #facc15 100%)", "--accent-rgb": "249,115,22", "--accent2-rgb": "250,204,21", "--bg-glow": "#2e1d0b"},
    {"--accent": "#ec4899", "--accent-2": "#a855f7", "--accent-grad": "linear-gradient(135deg, #ec4899 0%, #a855f7 100%)", "--accent-rgb": "236,72,153", "--accent2-rgb": "168,85,247", "--bg-glow": "#2c1030"},
]
COLOR_WORDS = ("green", "blue", "red", "orange", "pink", "teal")

SINGLE_RE = re.compile(r"\b(?:one|single|same|common|unified|combined|shared)\s+(?:[a-z-]+\s+)?dashboard\b|\ball[- ]in[- ]one\b|\beverything in one\b")
PER_ROLE_RE = re.compile(r"\bdashboards?\s+(?:for|per)\s+(?:each|every)\b|\b(?:one|a)\s+dashboard\s+(?:for|per)\s+(?:each|every)\b")
MULTI_RE = re.compile(r"\b(?:separate|different|individual|distinct|dedicated|multiple|alag(?:\s+alag)?)\b[^.\n]{0,40}\b(?:dashboards?|portals?|panels?)\b"
                      r"|\brole[- ]based\s+(?:dashboards?|portals?)\b")


def _singular(word: str) -> str:
    return word[:-1] if word.endswith("s") and not word.endswith("ss") and len(word) > 3 else word


def _clean_roles(tokens):
    roles = []
    for tok in tokens:
        tok = re.sub(r"[^a-z -]", "", tok.lower()).strip()
        words = [w for w in tok.split() if w not in STOP]
        if not words or len(words) > 2:
            continue
        role = _singular(" ".join(words))
        if role and role not in roles:
            roles.append(role)
    return roles[:4]


def detect_dashboards(idea: str):
    """Return a list of role names for separate dashboards, or None for ONE dashboard."""
    t = " " + (idea or "").lower() + " "
    if SINGLE_RE.search(t) and not PER_ROLE_RE.search(t):
        return None
    multi = bool(MULTI_RE.search(t) or PER_ROLE_RE.search(t))
    roles = []

    def add(chunk):
        roles.extend(r for r in _clean_roles(re.split(r",|&|\band\b|\baur\b|\bya\b|\bor\b", chunk)) if r not in roles)

    for m in re.finditer(r"\b((?:[a-z]+(?:\s*,\s*|\s+and\s+|\s+aur\s+|\s*&\s*))+[a-z]+)\s+(?:dashboards|portals|panels)\b", t):  # "admin and employee dashboards"
        add(m.group(1))
    for m in re.finditer(r"\b(?:dashboards?|portals?|panels?)\s+(?:for|per|of)\s+([a-z ,&/-]{3,70})", t):
        add(re.split(r"\bwith\b|\bwhere\b|\bthat\b|\bso\b", m.group(1))[0])
    if "dashboard" in t:  # Hindi: "admin aur employee ke liye alag dashboard"
        for m in re.finditer(r"([a-z]+(?:\s*,\s*[a-z]+)*(?:\s+(?:aur|and|&)\s+[a-z]+)?)\s+ke\s+(?:liye|lie)\b", t):
            add(m.group(1))
    for name in re.findall(r"\b([a-z]+)\s+(?:dashboard|portal|panel)s?\b", t):
        add(name)
    roles = roles[:4]
    if not multi and len(roles) >= 2:
        multi = True  # e.g. "admin dashboard and employee dashboard"
    if not multi:
        return None
    if len(roles) >= 2:
        return roles
    if not roles:
        return ["admin", "user"]
    return roles + (["admin"] if roles[0] == "user" else ["user"])


def _label(name: str) -> str:
    return " ".join(re.findall(r"[A-Z][a-z0-9]*|[a-z0-9]+", name.removesuffix("Page")))


def _kind(name: str) -> str:
    tokens = set(re.findall(r"[A-Z][a-z0-9]*", name.removesuffix("Page")))
    if tokens & {"Signup", "Login", "Register", "Signin", "Logout", "Auth"}:
        return "auth"
    if tokens & {"Profile", "Account", "Me", "Settings"}:
        return "profile"
    if tokens & {"Delete", "Remove"}:
        return "delete"
    if tokens & {"Create", "Add", "New", "Update", "Edit", "Modify"}:
        return "write"
    return "read"


def _level(role: str) -> int:
    words = set(role.split())
    return 3 if words & LEVEL3 else 2 if words & LEVEL2 else 1


def assign_pages(pages, roles):
    """role -> (work pages, account pages). Higher roles get more tools; everyone gets Login/Profile."""
    names = [p["name"] for p in pages]
    kinds = {n: _kind(n) for n in names}
    account = [n for n in names if kinds[n] in ("auth", "profile")]
    levels = {r: _level(r) for r in roles}
    if max(levels.values()) < 2:
        levels[roles[0]] = 3  # somebody must be able to add and edit things
    out = {}
    for role in roles:
        lv = levels[role]
        work = [n for n in names if kinds[n] not in ("auth", "profile") and (
            lv == 3 or (lv == 2 and kinds[n] != "delete") or kinds[n] == "read")]
        out[role] = (work or [n for n in names if n not in account], account)
    return out


def _blurb(level: int) -> str:
    return {3: "Manage everything: add, edit and remove records.",
            2: "Add and update records, and keep things running.",
            1: "View records and manage your own profile."}[level]


_APP = r"""import { useEffect, useState } from 'react';
__IMPORTS__
import './App.css';

const DATA = __DATA__;
const PAGES = { __PAGEMAP__ };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
};

function Overview({ dash, go }) {
  const tools = [...dash.pages, ...dash.account];
  return (
    <div className="overview">
      <div className="panel welcome">
        <h2>{DATA.multi ? 'Welcome to the ' + dash.title : 'Welcome to ' + DATA.project}</h2>
        <p className="panel-hint">{dash.blurb}</p>
        <div className="stat-row">
          <div><b>{dash.pages.length}</b><span>Tools</span></div>
          <div><b>{DATA.multi ? dash.role : 'Everyone'}</b><span>Access level</span></div>
        </div>
      </div>
      <div className="quick-grid">
        {tools.map((n) => (
          <button key={n} className="quick-card" onClick={() => go(n)}>
            <b>{DATA.labels[n]}</b>
            <span>{DATA.descriptions[n] || 'Open this page'}</span>
            <i>Open &rarr;</i>
          </button>
        ))}
      </div>
    </div>
  );
}

function Gate({ onPick }) {
  return (
    <div className="gate">
      <h1>{DATA.project}</h1>
      <p className="muted">Choose your dashboard</p>
      <div className="gate-grid">
        {DATA.dashboards.map((d) => (
          <button key={d.id} className="gate-card" style={d.tint || undefined} onClick={() => onPick(d.id)}>
            <span className="gate-ico">{d.icon}</span>
            <b>{d.title}</b>
            <span>{d.blurb}</span>
            <i>Enter &rarr;</i>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const first = DATA.multi ? null : DATA.dashboards[0].id;
  const saved = store.get('dash');
  const [dashId, setDashId] = useState(DATA.dashboards.some((d) => d.id === saved) ? saved : first);
  const [page, setPage] = useState('overview');
  const [locked, setLocked] = useState(null);
  const [token, setToken] = useState(store.get('token'));

  const choose = (id) => { setDashId(id); setPage('overview'); store.set('dash', id); };

  // Logged in? Ask the backend who we are and open the dashboard that matches the role.
  useEffect(() => {
    const t = store.get('token');
    setToken(t);
    if (!DATA.me || !t) return;
    fetch(DATA.me, { headers: { Authorization: 'Bearer ' + t } })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        const role = u && typeof u.role === 'string' ? u.role.toLowerCase() : '';
        const hit = role && DATA.dashboards.find((d) => role.includes(d.id) || d.id.includes(role));
        if (hit) { setLocked(hit.id); setDashId(hit.id); }
      })
      .catch(() => {});
  }, [page]);

  const dash = DATA.dashboards.find((d) => d.id === dashId);
  if (!dash) return <Gate onPick={choose} />;
  const navBtn = (n) => (
    <button key={n} className={'nav-item' + (page === n ? ' active' : '')} onClick={() => setPage(n)}>
      <span className="nav-dot"></span>{DATA.labels[n]}
    </button>
  );
  const Current = PAGES[page];
  return (
    <div className="app-shell" style={dash.tint || undefined}>
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="dot"></span>{DATA.project}</div>
        {DATA.multi && <div className="role-badge">{dash.title}</div>}
        <button className={'nav-item' + (page === 'overview' ? ' active' : '')} onClick={() => setPage('overview')}>
          <span className="nav-dot"></span>Overview
        </button>
        <div className="sidebar-section-label">{DATA.multi ? 'Tools' : 'Pages'}</div>
        {dash.pages.map(navBtn)}
        {dash.account.length > 0 && <div className="sidebar-section-label">Account</div>}
        {dash.account.map(navBtn)}
        {DATA.multi && !locked && (
          <button className="nav-item switch" onClick={() => { setDashId(null); store.set('dash', null); }}>Switch dashboard</button>
        )}
        {token && (
          <button className="nav-item signout" onClick={() => { store.set('token', null); setToken(null); setLocked(null); }}>Sign out</button>
        )}
      </aside>
      <main className="content">
        <div className="topbar">
          <h1>{page === 'overview' ? 'Overview' : DATA.labels[page]}</h1>
          <span className="crumb">{DATA.multi ? dash.title : DATA.project}</span>
        </div>
        <div className="page-body">
          {page === 'overview' ? <Overview dash={dash} go={setPage} /> : Current ? <Current /> : null}
        </div>
      </main>
    </div>
  );
}
"""

_CSS = """
/* dashboards */
.role-badge { margin: 0 10px 14px; padding: 6px 12px; border-radius: 999px; font-size: .75rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #fff; background: var(--accent-grad); align-self: flex-start; }
.nav-item.switch { margin-top: auto; border: 1px dashed var(--border); }
.nav-item.signout { color: var(--danger); }
.overview { display: grid; gap: 24px; }
.welcome .stat-row { display: flex; gap: 36px; margin-top: 20px; }
.welcome .stat-row b { display: block; font-size: 1.6rem; text-transform: capitalize; }
.welcome .stat-row span { color: var(--muted); font-size: .85rem; }
.quick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
.quick-card { display: grid; gap: 6px; text-align: left; padding: 20px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--ink); cursor: pointer; font: inherit; transition: transform .2s, border-color .2s; }
.quick-card:hover { transform: translateY(-3px); border-color: var(--accent); }
.quick-card span { color: var(--muted); font-size: .85rem; }
.quick-card i { font-style: normal; color: var(--accent); font-weight: 600; font-size: .85rem; }
.gate { min-height: 100vh; display: grid; place-content: center; gap: 10px; padding: 40px 20px; text-align: center; }
.gate h1 { margin: 0; font-size: 2.2rem; letter-spacing: -.02em; }
.gate-grid { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
.gate-card { width: 260px; display: grid; gap: 8px; text-align: left; padding: 26px; border-radius: 20px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); cursor: pointer; font: inherit; transition: transform .2s, box-shadow .2s, border-color .2s; }
.gate-card:hover { transform: translateY(-5px); border-color: var(--accent); box-shadow: 0 26px 50px -28px var(--accent); }
.gate-ico { font-size: 2rem; }
.gate-card span:not(.gate-ico) { color: var(--muted); font-size: .9rem; }
.gate-card i { font-style: normal; color: var(--accent); font-weight: 700; }
"""


def write_dashboards(project_dir: Path, spec: dict, idea: str) -> dict:
    pages = spec["pages"]
    pretty = " ".join(w.capitalize() for w in re.split(r"[_\-\s]+", spec["project_name"]) if w) or spec["project_name"]
    index_html = project_dir / "frontend" / "index.html"
    if index_html.exists():
        index_html.write_text(index_html.read_text(encoding="utf-8").replace("__PROJECT_TITLE__", pretty), encoding="utf-8")

    roles = detect_dashboards(idea)
    idea_l = (idea or "").lower()
    named_colour = any(re.search(rf"\b{c}\b", idea_l) for c in COLOR_WORDS)
    names = [p["name"] for p in pages]
    kinds = {n: _kind(n) for n in names}
    if roles:
        assigned = assign_pages(pages, roles)
        levels = {r: _level(r) for r in roles}
        if max(levels.values()) < 2:
            levels[roles[0]] = 3
        dashboards = []
        for i, role in enumerate(roles):
            work, account = assigned[role]
            dashboards.append({"id": role, "role": role, "title": role.title() + " Dashboard", "icon": ICONS.get(role.split()[-1], "👤"),
                               "blurb": _blurb(levels[role]), "pages": work, "account": account,
                               "tint": None if named_colour else TINTS[i % len(TINTS)]})
    else:
        dashboards = [{"id": "main", "role": "everyone", "title": "Dashboard", "icon": "📊", "blurb": "Everything in one place: pick a page on the left to get started.",
                       "pages": [n for n in names if kinds[n] not in ("auth", "profile")] or names,
                       "account": [n for n in names if kinds[n] in ("auth", "profile")], "tint": None}]

    me = None
    for p in pages:
        api = p.get("calls_api", {})
        if api.get("method") == "GET" and api.get("path", "").rstrip("/").endswith("/me") and api.get("base_url"):
            me = api["base_url"] + api["path"]
    data = {"project": pretty, "multi": bool(roles), "dashboards": dashboards, "me": me,
            "labels": {n: _label(n) for n in names},
            "descriptions": {p["name"]: (p.get("description") or "").strip()[:90] for p in pages}}
    imports = "\n".join(f"import {n} from './pages/{n}';" for n in names)
    app = _APP.replace("__IMPORTS__", imports).replace("__PAGEMAP__", ", ".join(names)).replace("__DATA__", json.dumps(data, ensure_ascii=False))
    src = project_dir / "frontend" / "src"
    (src / "app.jsx").write_text(app, encoding="utf-8")
    css = src / "App.css"
    text = css.read_text(encoding="utf-8")
    if "/* dashboards */" not in text:
        css.write_text(text + _CSS, encoding="utf-8")
    return {"mode": "separate" if roles else "single", "dashboards": [d["title"] for d in dashboards]}
