"""Site-style frontend: builds a real one-page website (hero, hours, gallery, contact...)
instead of the generic form-per-endpoint dashboard.

No model call -> instant. The look comes from the idea text:
  - business kind (cafe / dog walker / repair) picks content + palette
  - colour words ("red", "blue", ...) and "dark"/"light" override the palette
  - requested features (opening hours, gallery, contact form, menu) become sections, in order
"""
import json
import os
import re
from pathlib import Path

KINDS = {
    "cafe": {
        "name": "Corner Brew Café", "emoji": "☕", "cta": "Visit us today",
        "tagline": "Small-batch coffee, fresh bakes and a corner to call your own.",
        "about": "We roast in small batches every week and bake each morning before the doors open. "
                 "Come for the flat white, stay for the cinnamon buns.",
        "cards": [["☕", "Single-origin coffee", "Roasted weekly and brewed the way you like it."],
                  ["🥐", "Fresh bakes", "Croissants, sourdough and cakes baked every morning."],
                  ["🪴", "Cosy corners", "Window seats, free Wi-Fi and plenty of plugs."]],
        "gallery": [["☕", "Morning pour"], ["🥐", "Butter croissants"], ["🍰", "Cake counter"],
                    ["🪴", "Window seats"], ["🫘", "Fresh roast"], ["🎶", "Live music Fridays"]],
        "hours": [["Mon – Fri", "7:30 – 18:00"], ["Saturday", "8:00 – 20:00"], ["Sunday", "9:00 – 16:00"]],
        "light": {"bg": "#fbf6ef", "surface": "#ffffff", "ink": "#2b1d14", "muted": "#7a6556", "accent": "#b5651d"},
    },
    "dog": {
        "name": "Happy Paws Dog Walking", "emoji": "🐕", "cta": "Book a walk",
        "tagline": "Daily walks, happy tails. Friendly local walkers your dog will love.",
        "about": "Insured, background-checked walkers who treat your dog like family. "
                 "Solo walks, small group adventures and drop-in visits.",
        "cards": [["🦮", "Solo walks", "One-on-one time at your dog's own pace."],
                  ["🐾", "Group adventures", "Small groups of up to four friendly dogs."],
                  ["🏡", "Drop-in visits", "Feeding, cuddles and a garden break while you're out."]],
        "gallery": [["🐕", "Park run"], ["🦴", "Treat time"], ["🌳", "Forest trail"],
                    ["🐩", "New friends"], ["🏖️", "Beach day"], ["😴", "Post-walk nap"]],
        "hours": [["Mon – Fri", "8:00 – 18:00"], ["Saturday", "9:00 – 13:00"], ["Sunday", "Closed"]],
        "light": {"bg": "#f3faf6", "surface": "#ffffff", "ink": "#12372a", "muted": "#5b7d70", "accent": "#1f9d6b"},
    },
    "repair": {
        "name": "FixIt Fast Repairs", "emoji": "🔧", "cta": "Get a free quote",
        "tagline": "Phones, laptops and appliances fixed fast, with a 90-day guarantee.",
        "about": "Honest quotes, quality parts and most repairs done the same day. "
                 "Bring it in and we'll tell you the price before we touch it.",
        "cards": [["📱", "Phones & tablets", "Screens, batteries and charging ports."],
                  ["💻", "Laptops", "Upgrades, clean-ups and hardware repair."],
                  ["🔌", "Appliances", "Small appliance repair and safety checks."]],
        "gallery": [["📱", "Screen swap"], ["🔋", "Battery fix"], ["💻", "Laptop revival"],
                    ["🔧", "Our workbench"], ["🔌", "Appliance repair"], ["✅", "Tested & ready"]],
        "hours": [["Mon – Fri", "9:00 – 18:00"], ["Saturday", "10:00 – 15:00"], ["Sunday", "Closed"]],
        "light": {"bg": "#f4f7fb", "surface": "#ffffff", "ink": "#14202e", "muted": "#5d6e82", "accent": "#e8710a"},
    },
}
DARK = {"bg": "#0d1117", "surface": "#161b24", "ink": "#f1f4f9", "muted": "#9aa5b6"}
COLORS = {"red": "#d7263d", "blue": "#2563eb", "green": "#1f9d6b", "purple": "#7c3aed", "orange": "#f97316",
          "pink": "#ec4899", "yellow": "#eab308", "teal": "#0d9488", "brown": "#9a5b2e"}
SECTION_WORDS = {"hours": ("hour", "timing", "schedule", "open"),
                 "gallery": ("gallery", "image", "photo", "picture"),
                 "contact": ("contact", "form", "message", "enquir", "inquir"),
                 "menu": ("menu", "service", "price", "offer")}
SITE_HINTS = ("site", "website", "landing", "portfolio", "homepage", "gallery", "opening hours", "contact form")


def _mix(hex_color: str, amount: float) -> str:
    """Mix a colour with white (amount 0..1)."""
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % tuple(round(c + (255 - c) * amount) for c in (r, g, b))


def _text(idea, requirements):
    parts = [idea or "", requirements.get("project_name", "")]
    for f in requirements.get("features", []):
        parts += [f.get("name", ""), f.get("description", "")]
    return " ".join(parts).lower()


def should_use_site(idea, requirements) -> bool:
    return any(h in _text(idea, requirements) for h in SITE_HINTS)


def _kind(text):
    found = {k: text.find(w) for k, w in (("cafe", "caf"), ("cafe2", "coffee"), ("dog", "dog"), ("repair", "repair"))}
    found["cafe"] = min([v for v in (found["cafe"], found.pop("cafe2")) if v >= 0] or [-1])
    hits = {k: v for k, v in found.items() if v >= 0}
    return min(hits, key=hits.get) if hits else None


def _sections(requirements):
    order = []
    for f in requirements.get("features", []):
        t = (f.get("name", "") + " " + f.get("description", "")).lower()
        for key, words in SECTION_WORDS.items():
            if any(w in t for w in words) and key not in order:
                order.append(key)
                break
    return order or ["menu", "hours", "gallery", "contact"]


def _contact_cfg(spec):
    for page in spec.get("pages", []):
        api = page.get("calls_api", {})
        if api.get("method") == "POST" and "contact" in (api.get("path", "") + page["name"]).lower():
            body = api.get("request_body", {})
            msg_key = next((k for k in body if "message" in k or "text" in k), "message")
            extra = {k: "1" for k in body if k != msg_key and k.endswith("id")}
            return {"url": api["base_url"] + api["path"].replace("{id}", "1"), "messageKey": msg_key, "extra": extra}
    return None


HEADING_FONTS = {  # name -> (google css2 family spec, css fallback, weight)
    "Playfair Display": ("Playfair+Display:wght@600;800", "Georgia,serif", 800),
    "DM Serif Display": ("DM+Serif+Display", "Georgia,serif", 400),
    "Fraunces": ("Fraunces:wght@600;800", "Georgia,serif", 800),
    "Poppins": ("Poppins:wght@600;800", "system-ui,sans-serif", 800),
    "Space Grotesk": ("Space+Grotesk:wght@500;700", "system-ui,sans-serif", 700),
    "Outfit": ("Outfit:wght@600;800", "system-ui,sans-serif", 800),
}
HEROES, STYLES, GALLERIES = ("split", "center", "bold"), ("soft", "sharp", "outline"), ("grid", "mosaic")
GENERIC_CARDS = [["✨", "Quality first", "Careful work, every single time."],
                 ["🤝", "Friendly service", "Real people who are happy to help."],
                 ["📍", "Local & trusted", "Proudly part of the neighbourhood."]]
GENERIC_GALLERY = [["✨", "Our space"], ["🌟", "Behind the scenes"], ["🎉", "Happy customers"],
                   ["🛠️", "Our work"], ["📸", "Moments"], ["💛", "Community"]]

BRIEF_PROMPT = """You are a creative web designer. Design a ONE-PAGE website for this idea:
\"\"\"{idea}\"\"\"
Invent a fictional business. Make the look and feel unique to this idea (not generic).
Reply with ONLY a JSON object, no markdown, in exactly this shape:
{{"business_name":"...", "emoji":"one emoji", "tagline":"max 90 chars", "about":"max 200 chars", "cta":"max 3 words",
 "accent":"#rrggbb main brand colour", "mode":"light or dark",
 "heading_font":"one of: {fonts}", "hero":"one of: split, center, bold",
 "style":"one of: soft, sharp, outline", "gallery_layout":"one of: grid, mosaic",
 "cards":[{{"icon":"emoji","title":"2-4 words","text":"max 70 chars"}}, (exactly 3)],
 "gallery":[{{"icon":"emoji","caption":"2-3 words"}}, (exactly 6)],
 "hours":[{{"day":"Mon - Fri","time":"9:00 - 18:00"}}, (exactly 3, last one may be Closed)],
 "address":"fictional street address", "phone":"fictional phone"}}"""


def _hex(v, default):
    return v.strip() if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v.strip()) else default


def _clip(v, n, default):
    return v.strip()[:n] if isinstance(v, str) and v.strip() else default


def _pick(v, options, default):
    return v if v in options else default


def _pairs(v, keys, n, default):
    try:
        out = [[str(item[k]).strip()[:80] for k in keys] for item in v][:n]
        return out if len(out) == n and all(all(x) for x in out) else default
    except Exception:
        return default


def ai_design_brief(idea_text: str):
    """Ask the local model for a small JSON design brief. Returns a dict or None (-> fallback)."""
    if os.environ.get("CTO_AI_DESIGN", "1") == "0":
        return None
    try:
        import ollama
        timeout = float(os.environ.get("CTO_AI_DESIGN_TIMEOUT", "300"))
        model = os.environ.get("CTO_MODEL", "qwen2.5-coder:7b")
        print(f"[{__import__('time').strftime('%H:%M:%S')}] Designer: asking the AI for a website design (up to {int(timeout)}s)...", flush=True)
        reply = ollama.Client(timeout=timeout).chat(
            model=model, format="json",
            messages=[{"role": "user", "content": BRIEF_PROMPT.format(idea=idea_text[:600], fonts=", ".join(HEADING_FONTS))}],
            options={"temperature": 0.8, "num_predict": 900},
        )
        text = reply["message"]["content"] if isinstance(reply, dict) else reply.message.content
        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
        brief = json.loads(text)
        return brief if isinstance(brief, dict) else None
    except Exception as exc:  # slow / offline / bad JSON -> deterministic fallback
        print(f"Designer: AI design unavailable ({type(exc).__name__}); using built-in design.", flush=True)
        return None


def _hash(text: str) -> int:
    return sum(ord(ch) * (i + 7) for i, ch in enumerate(text))


def write_site(project_dir: Path, idea: str, requirements: dict, spec: dict) -> dict:
    text = _text(idea, requirements)
    kind = _kind(text)
    base = KINDS.get(kind) or {
        "name": " ".join(w.capitalize() for w in re.split(r"[_\-\s]+", requirements.get("project_name", "My Site")) if w) or "My Site",
        "emoji": "✨", "cta": "Get in touch", "tagline": "Welcome! Here is everything you need to know about us.",
        "about": "A friendly local business built around people. Have a look around and say hello.",
        "cards": GENERIC_CARDS, "gallery": GENERIC_GALLERY,
        "hours": [["Mon – Fri", "9:00 – 17:00"], ["Saturday", "10:00 – 14:00"], ["Sunday", "Closed"]],
        "light": {"bg": "#f6f5fb", "surface": "#ffffff", "ink": "#1c1b2b", "muted": "#66647c", "accent": "#6d4aff"},
    }
    seed = _hash(requirements.get("project_name", "") + (idea or ""))
    brief = ai_design_brief(" ".join([idea or "", requirements.get("project_name", "")] +
                                     [f.get("name", "") + ": " + f.get("description", "") for f in requirements.get("features", [])]))
    ai = bool(brief)
    b = brief or {}
    idea_l = (idea or "").lower()
    # --- palette ---
    pal = dict(base["light"])
    if ai:
        pal["accent"] = _hex(b.get("accent"), pal["accent"])
        pal.update({"bg": _mix(pal["accent"], 0.95), "surface": "#ffffff", "ink": "#1b1c26", "muted": "#666b7a"})
    for word, hexv in COLORS.items():           # user's own words always win
        if re.search(rf"\b{word}\b", idea_l):
            pal["accent"] = hexv
            pal.update({"bg": _mix(hexv, 0.95)}) if ai else None
            break
    mode = b.get("mode") if ai else None
    if re.search(r"\bdark\b", idea_l) or mode == "dark" or (not ai and kind == "repair" and not re.search(r"\blight\b", idea_l)):
        pal.update(DARK)
    pal["accent2"] = _mix(pal["accent"], 0.55)
    pal["soft"] = _mix(pal["accent"], 0.9) if pal["bg"] != DARK["bg"] else _mix(pal["accent"], 0.0)
    # --- look & feel (AI choice, else varies per project so sites differ) ---
    font = _pick(b.get("heading_font"), HEADING_FONTS, list(HEADING_FONTS)[seed % len(HEADING_FONTS)])
    radius = {"soft": ("22px", "999px"), "sharp": ("4px", "4px"), "outline": ("12px", "999px")}
    style = _pick(b.get("style"), STYLES, STYLES[seed % 3])
    hero = _pick(b.get("hero"), HEROES, HEROES[(seed // 3) % 3])
    gal = _pick(b.get("gallery_layout"), GALLERIES, GALLERIES[(seed // 9) % 2])
    pal["r"], pal["rb"] = radius[style]
    pal["hfont"] = f'"{font}",{HEADING_FONTS[font][1]}'
    pal["hw"] = str(HEADING_FONTS[font][2])
    # --- content ---
    cards = _pairs(b.get("cards"), ("icon", "title", "text"), 3, base["cards"]) if ai else base["cards"]
    gallery = _pairs(b.get("gallery"), ("icon", "caption"), 6, base["gallery"]) if ai else base["gallery"]
    hours = _pairs(b.get("hours"), ("day", "time"), 3, base["hours"]) if ai else base["hours"]
    name = _clip(b.get("business_name"), 40, base["name"])
    data = {"name": name, "emoji": _clip(b.get("emoji"), 4, base["emoji"]), "cta": _clip(b.get("cta"), 24, base["cta"]),
            "tagline": _clip(b.get("tagline"), 110, base["tagline"]), "about": _clip(b.get("about"), 240, base["about"]),
            "cards": cards, "gallery": gallery, "hours": hours,
            "address": _clip(b.get("address"), 60, "12 Market Street, Old Town"), "phone": _clip(b.get("phone"), 24, "+1 555 0142"),
            "hero": hero, "style": style, "galleryLayout": gal,
            "sections": _sections(requirements), "contact": _contact_cfg(spec),
            "feature_titles": [f["name"] for f in requirements.get("features", [])]}
    src = project_dir / "frontend" / "src"
    (src / "App.jsx").write_text(_APP.replace("__DATA__", json.dumps(data, ensure_ascii=False)), encoding="utf-8")
    (src / "Site.css").write_text(":root{" + ";".join(f"--{k}:{v}" for k, v in pal.items()) + "}\n" + _CSS, encoding="utf-8")
    idx = project_dir / "frontend" / "index.html"
    if idx.exists():
        html = idx.read_text(encoding="utf-8").replace("__PROJECT_TITLE__", name)
        link = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family='
                + HEADING_FONTS[font][0] + '&display=swap" />')
        html = re.sub(r'<link rel="stylesheet" href="https://fonts\.googleapis[^>]*>', "", html).replace("</head>", link + "</head>")
        idx.write_text(html, encoding="utf-8")
    return {"kind": kind or "custom", "name": name, "sections": data["sections"], "ai": ai,
            "look": f"hero={hero}, style={style}, gallery={gal}, font={font}, accent={pal['accent']}"}


_APP = r"""import { useState } from 'react';
import './Site.css';

const SITE = __DATA__;
const TITLES = { menu: 'What we do', hours: 'Opening hours', gallery: 'Gallery', contact: 'Get in touch' };

function Hours() {
  const today = (new Date().getDay() + 6) % 7; // Mon=0
  const active = today < 5 ? 0 : today === 5 ? 1 : 2;
  return (
    <div className="hours">
      {SITE.hours.map(([day, time], i) => (
        <div className={'hours-row' + (i === active ? ' today' : '')} key={day}>
          <span>{day}{i === active && <em>Today</em>}</span>
          <strong className={time === 'Closed' ? 'closed' : ''}>{time}</strong>
        </div>
      ))}
    </div>
  );
}

function Contact() {
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [state, setState] = useState({ status: 'idle', text: '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (!SITE.contact) return setState({ status: 'error', text: 'No contact endpoint was generated for this app.' });
    setState({ status: 'sending', text: '' });
    try {
      const body = { ...SITE.contact.extra, [SITE.contact.messageKey]: 'From ' + form.name + ' <' + form.email + '>: ' + form.message };
      const res = await fetch(SITE.contact.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        let detail = '';
        try { const d = await res.json(); detail = typeof d.detail === 'string' ? d.detail : ''; } catch (_) {}
        throw new Error(detail || 'The server could not save your message (' + res.status + ').');
      }
      setForm({ name: '', email: '', message: '' });
      setState({ status: 'ok', text: "Thanks! Your message was sent. We'll get back to you soon." });
    } catch (err) {
      setState({ status: 'error', text: err.message === 'Failed to fetch' ? 'Cannot reach the server. Is the backend running?' : err.message });
    }
  };
  return (
    <div className="contact-grid">
      <form className="card form" onSubmit={submit}>
        <label>Your name<input required value={form.name} onChange={set('name')} placeholder="Jane Doe" /></label>
        <label>Email<input required type="email" value={form.email} onChange={set('email')} placeholder="jane@example.com" /></label>
        <label>Message<textarea required rows={5} value={form.message} onChange={set('message')} placeholder="How can we help?" /></label>
        <button className="btn" disabled={state.status === 'sending'}>{state.status === 'sending' ? 'Sending...' : 'Send message'}</button>
        {state.text && <p className={'note ' + state.status}>{state.text}</p>}
      </form>
      <div className="card info">
        <h3>Find us</h3>
        <p>📍 {SITE.address}</p>
        <p>📞 {SITE.phone}</p>
        <p>✉️ hello@{SITE.name.toLowerCase().replace(/[^a-z]/g, '')}.example</p>
        <div className="map" aria-hidden="true">{SITE.emoji}</div>
      </div>
    </div>
  );
}

function Section({ id, title, children, alt }) {
  return (
    <section id={id} className={'section' + (alt ? ' alt' : '')}>
      <div className="wrap">
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  );
}

export default function App() {
  const secs = SITE.sections;
  return (
    <div className={'site hero-' + SITE.hero + ' gal-' + SITE.galleryLayout + ' style-' + SITE.style}>
      <header className="nav">
        <div className="wrap nav-in">
          <a className="logo" href="#top"><span>{SITE.emoji}</span> {SITE.name}</a>
          <nav>
            {secs.map((s) => <a key={s} href={'#' + s}>{TITLES[s]}</a>)}
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap hero-in">
            <div>
              <p className="eyebrow">Welcome to</p>
              <h1>{SITE.name}</h1>
              <p className="lead">{SITE.tagline}</p>
              <div className="cta">
                <a className="btn" href={secs.includes('contact') ? '#contact' : '#top'}>{SITE.cta}</a>
                {secs.includes('hours') && <a className="btn ghost" href="#hours">See opening hours</a>}
              </div>
            </div>
            <div className="hero-art" aria-hidden="true"><span>{SITE.emoji}</span></div>
          </div>
        </section>

        {secs.map((s, i) => {
          const alt = i % 2 === 1;
          if (s === 'menu') return (
            <Section key={s} id={s} title={TITLES[s]} alt={alt}>
              <p className="sub">{SITE.about}</p>
              <div className="cards">
                {SITE.cards.map(([icon, t, d]) => (
                  <div className="card feature" key={t}><div className="icon">{icon}</div><h3>{t}</h3><p>{d}</p></div>
                ))}
              </div>
            </Section>
          );
          if (s === 'hours') return <Section key={s} id={s} title={TITLES[s]} alt={alt}><Hours /></Section>;
          if (s === 'gallery') return (
            <Section key={s} id={s} title={TITLES[s]} alt={alt}>
              <div className="gallery">
                {SITE.gallery.map(([icon, cap], k) => (
                  <figure className={'tile t' + (k % 3)} key={cap}><span>{icon}</span><figcaption>{cap}</figcaption></figure>
                ))}
              </div>
            </Section>
          );
          return <Section key={s} id={s} title={TITLES[s]} alt={alt}><Contact /></Section>;
        })}
      </main>

      <footer className="footer"><div className="wrap">© {new Date().getFullYear()} {SITE.name} · A sample site</div></footer>
    </div>
  );
}
"""

_CSS = r"""
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,"Segoe UI",sans-serif;line-height:1.6}
h1,h2,h3{font-family:var(--hfont);font-weight:var(--hw);margin:0;line-height:1.15}
a{color:inherit;text-decoration:none}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.nav{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
.nav-in{display:flex;align-items:center;justify-content:space-between;height:68px;gap:16px}
.logo{font-family:var(--hfont);font-weight:var(--hw);font-size:1.25rem}
.nav nav{display:flex;gap:24px;font-size:.95rem;color:var(--muted)}
.nav nav a:hover{color:var(--accent)}
.hero{background:radial-gradient(900px 400px at 85% 0,var(--accent2),transparent 70%),var(--soft);padding:84px 0 96px}
.hero-in{display:grid;grid-template-columns:1.2fr .8fr;gap:40px;align-items:center}
.eyebrow{color:var(--accent);font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:.8rem;margin:0 0 12px}
.hero h1{font-size:clamp(2.4rem,6vw,4.2rem);letter-spacing:-.02em}
.lead{font-size:1.2rem;color:var(--muted);max-width:34ch;margin:18px 0 28px}
.cta{display:flex;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;border:0;cursor:pointer;background:var(--accent);color:#fff;font:600 1rem Inter,system-ui,sans-serif;padding:13px 28px;border-radius:var(--rb);box-shadow:0 10px 24px -10px var(--accent);transition:transform .15s}
.btn:hover{transform:translateY(-2px)}.btn:disabled{opacity:.6;cursor:wait}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--ink) 25%,transparent)}
.hero-art{aspect-ratio:1;border-radius:50% 50% 46% 54%/55% 45% 55% 45%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;font-size:clamp(5rem,14vw,9rem);box-shadow:0 40px 80px -30px var(--accent)}
.section{padding:84px 0}.section.alt{background:color-mix(in srgb,var(--ink) 4%,var(--bg))}
.section h2{font-size:clamp(1.8rem,4vw,2.6rem);margin-bottom:12px}
.sub{color:var(--muted);max-width:60ch;margin:0 0 32px}
.card{background:var(--surface);border:1px solid color-mix(in srgb,var(--ink) 10%,transparent);border-radius:var(--r);padding:26px;box-shadow:0 18px 40px -28px rgba(0,0,0,.35)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px}
.feature .icon{font-size:2rem;width:58px;height:58px;display:grid;place-items:center;border-radius:16px;background:var(--soft);margin-bottom:14px}
.feature h3{font-size:1.2rem;margin-bottom:6px}.feature p{margin:0;color:var(--muted)}
.hours{max-width:520px;margin-top:24px;background:var(--surface);border-radius:var(--r);padding:10px 24px;border:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
.hours-row{display:flex;justify-content:space-between;padding:16px 0;border-bottom:1px dashed color-mix(in srgb,var(--ink) 18%,transparent)}
.hours-row:last-child{border-bottom:0}.hours-row.today span{font-weight:600;color:var(--accent)}
.hours-row em{font-style:normal;font-size:.7rem;background:var(--accent);color:#fff;border-radius:99px;padding:2px 9px;margin-left:10px;vertical-align:middle}
.closed{color:var(--muted)}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
.tile{margin:0;aspect-ratio:4/3;border-radius:var(--r);display:grid;place-items:center;position:relative;overflow:hidden;font-size:3.4rem;transition:transform .25s}
.tile:hover{transform:scale(1.03)}
.t0{background:linear-gradient(135deg,var(--accent),var(--accent2))}
.t1{background:linear-gradient(225deg,var(--accent2),var(--accent))}
.t2{background:linear-gradient(315deg,var(--accent),var(--soft))}
.tile figcaption{position:absolute;left:0;right:0;bottom:0;padding:26px 16px 12px;font:600 .9rem Inter,sans-serif;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.55))}
.contact-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:24px;margin-top:24px}
.form{display:grid;gap:16px}
.form label{display:grid;gap:6px;font-size:.85rem;font-weight:600;color:var(--muted)}
.form input,.form textarea{font:400 1rem Inter,system-ui,sans-serif;padding:12px 14px;border-radius:12px;border:1.5px solid color-mix(in srgb,var(--ink) 16%,transparent);background:var(--bg);color:var(--ink)}
.form input:focus,.form textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 20%,transparent)}
.form .btn{justify-self:start}
.note{margin:0;padding:12px 14px;border-radius:12px;font-size:.92rem}
.note.ok{background:#e6f8ef;color:#116a3f}.note.error{background:#fdeceb;color:#a32a22}
.info h3{margin-bottom:14px}.info p{margin:8px 0;color:var(--muted)}
.map{margin-top:18px;height:130px;border-radius:16px;display:grid;place-items:center;font-size:3rem;background:repeating-linear-gradient(45deg,var(--soft),var(--soft) 12px,var(--bg) 12px,var(--bg) 24px)}
.footer{padding:30px 0;text-align:center;color:var(--muted);font-size:.9rem;border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
/* ---- design variants ---- */
.style-outline .card,.style-outline .hours{box-shadow:none;border:2px solid var(--ink)}
.style-outline .btn{box-shadow:none}.style-sharp .card,.style-sharp .hours{box-shadow:none}
.hero-center .hero-in{grid-template-columns:1fr;text-align:center}.hero-center .lead{margin-inline:auto}
.hero-center .cta{justify-content:center}.hero-center .hero-art{display:none}.hero-center .hero{padding:110px 0}
.hero-bold .hero{background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#000));color:#fff}
.hero-bold .hero .eyebrow,.hero-bold .hero .lead{color:rgba(255,255,255,.88)}
.hero-bold .hero .btn{background:#fff;color:var(--accent);box-shadow:none}
.hero-bold .hero .btn.ghost{background:transparent;color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.6)}
.hero-bold .hero-art{background:rgba(255,255,255,.14);box-shadow:none}
.gal-mosaic .gallery{grid-template-columns:repeat(4,1fr);grid-auto-rows:150px}
.gal-mosaic .tile{aspect-ratio:auto}
.gal-mosaic .tile:nth-child(1){grid-column:span 2;grid-row:span 2;font-size:5rem}.gal-mosaic .tile:nth-child(4){grid-column:span 2}
@media(max-width:800px){.hero-in,.contact-grid{grid-template-columns:1fr}.hero-art{max-width:260px}.gallery,.gal-mosaic .gallery{grid-template-columns:repeat(2,1fr)}.gal-mosaic .tile:nth-child(n){grid-column:auto;grid-row:auto}.nav nav{display:none}}
"""
