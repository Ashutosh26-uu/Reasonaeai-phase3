"""Plain-English design tweaks: "make it dark", "use green", "add testimonials", "centered hero".

Rule based on purpose: it is instant, needs no model and cannot invent anything. Tweaks are saved in
`site_tweaks.json` next to the project and applied on top of the AI design brief, so the site is
re-rendered in a fraction of a second. "reset" removes every tweak.
"""
import json
import re
from pathlib import Path

from site_builder import COLORS

from . import write_static_site
from .render import FONTS, SANS, SERIF

EXTRA_COLORS = {"gold": "#c9a227", "navy": "#1e3a8a", "maroon": "#9b1c31", "lavender": "#8b7bd8", "mint": "#2bb673",
                "coral": "#f2675a", "violet": "#7c3aed", "cyan": "#0ea5e9", "lime": "#65a30d", "indigo": "#4f46e5",
                "beige": "#b08968"}
SHADE = r"(?!\s+(?:green|blue|red|brown|purple|pink|orange|teal|yellow|gold|navy|grey|gray))"
MOODS = {"luxury": ("luxury", "luxurious", "premium", "classy", "upscale"), "elegant": ("elegant", "refined"),
         "playful": ("playful", "fun", "cheerful", "colorful", "colourful"), "bold": ("bold", "energetic", "sporty", "strong"),
         "calm": ("calm", "soft", "relaxing", "minimal", "peaceful"), "modern": ("professional", "corporate", "clean", "modern", "simple")}
SECTION_WORDS = {"menu": ("services", "service", "menu", "what we do"), "about": ("about us", "about", "our story", "story"),
                 "hours": ("opening hours", "hours", "timings"), "gallery": ("gallery", "photos", "images"),
                 "reviews": ("testimonials", "testimonial", "reviews", "review"), "faq": ("faq", "questions"),
                 "contact": ("contact form", "contact", "get in touch")}
ADD = ("add", "include", "show", "with", "insert", "need", "want", "also", "put")
REMOVE = ("remove", "delete", "hide", "without", "drop", "skip", "no ")
HELP = ('Try: "make it dark", "use green", "luxury look", "centered hero", "bigger title", "floating navbar", '
        '"sharp corners", "serif font", "add testimonials", "remove gallery", "rename it to Blue Door Cafe", or "reset".')


def parse(text: str):
    ov, said = {}, []
    t = text
    for key, pattern in (("name", r"(?:rename(?: it| the site| the business)?(?: to)?|call it|name it|change the name to|business name(?: is| to)?)\s+[\"“']?([^\"”'\n.,]{2,40})"),
                         ("tagline", r"tagline(?: to| is|:)?\s+[\"“']?([^\"”'\n]{3,100})")):
        m = re.search(pattern, t, re.I)
        if m:
            ov[key] = m.group(1).strip()
            said.append(f"name set to {ov[key]}" if key == "name" else "tagline updated")
            t = t.replace(m.group(0), " ")  # keep the new name out of the colour / layout rules below
    t = " " + t.lower() + " "

    for word, hexv in {**COLORS, **EXTRA_COLORS}.items():
        if re.search(rf"\b{word}\b", t):
            ov["accent"] = hexv
            said.append(f"colour set to {word}")
            break
    if re.search(rf"\b(dark(?:er)?|night){SHADE}\b", t) or "dark mode" in t:
        ov["dark"] = True
        said.append("dark theme")
    elif re.search(rf"\b(light(?:er)?|bright(?:er)?|white){SHADE}\b", t):
        ov["dark"] = False
        said.append("light theme")
    for mood, words in MOODS.items():
        if any(re.search(rf"\b{w}\b", t) for w in words):
            ov["mood"] = mood
            said.append(f"{mood} mood")
            break
    for name in FONTS:
        if name.lower() in t:
            ov["font"] = name
            said.append(f"{name} font")
            break
    else:
        pick = _hash(t)
        if re.search(r"\b(serif|classic|traditional)\b", t):
            ov["font"] = SERIF[pick % len(SERIF)]
            said.append(f"serif font ({ov['font']})")
        elif re.search(r"\b(sans|clean font|modern font)\b", t):
            ov["font"] = SANS[pick % len(SANS)]
            said.append(f"modern font ({ov['font']})")
    if re.search(r"\b(center|centre|centered|centred)\b", t):
        ov["hero"] = "center"; said.append("centered hero")
    elif re.search(r"(big|huge|large|bigger|larger)\s+(title|heading|headline)", t):
        ov["hero"] = "spot"; said.append("big headline hero")
    elif re.search(r"(bold|colou?red|full colou?r)\s+hero|hero\s+(bold|in colou?r)", t):
        ov["hero"] = "bold"; said.append("bold colour hero")
    elif re.search(r"\bsplit\b", t):
        ov["hero"] = "split"; said.append("split hero")
    if re.search(r"\b(floating|pill|rounded)\s+(nav|navbar|menu)", t):
        ov["nav"] = "pill"; said.append("floating navbar")
    elif re.search(r"\b(simple|plain|normal|bar)\s+(nav|navbar|menu)", t):
        ov["nav"] = "bar"; said.append("simple navbar")
    if re.search(r"\b(sharp|square|boxy|angular)\b", t):
        ov["style"] = "sharp"; said.append("sharp corners")
    elif re.search(r"\b(round corners|rounded corners|curvy|soft corners|soft style)\b", t):
        ov["style"] = "soft"; said.append("soft rounded corners")
    elif re.search(r"\b(outline|outlined|bordered|borders)\b", t):
        ov["style"] = "outline"; said.append("outline style")
    if re.search(r"\b(mosaic|collage)\b", t):
        ov["gallery"] = "mosaic"; said.append("mosaic gallery")
    elif re.search(r"\b(grid gallery|even grid|equal tiles)\b", t):
        ov["gallery"] = "grid"; said.append("grid gallery")

    add, remove = [], []
    for key, words in SECTION_WORDS.items():
        for w in words:
            m = re.search(rf"\b{re.escape(w)}\b", t)
            if not m:
                continue
            before = t[max(0, m.start() - 22):m.start()]
            if any(v in before for v in REMOVE):
                remove.append(key); said.append(f"removed {key} section")
            elif any(v in before for v in ADD):
                add.append(key); said.append(f"added {key} section")
            break
    if add:
        ov["add"] = add
    if remove:
        ov["remove"] = remove

    return ov, said


def _hash(text):
    return sum(ord(c) * (i + 3) for i, c in enumerate(text))


def merge(old: dict, new: dict) -> dict:
    out = {**old, **{k: v for k, v in new.items() if k not in ("add", "remove")}}
    add, remove = set(old.get("add", [])), set(old.get("remove", []))
    for k in new.get("add", []):
        add.add(k); remove.discard(k)
    for k in new.get("remove", []):
        remove.add(k); add.discard(k)
    out["add"], out["remove"] = sorted(add), sorted(remove)
    return out


def tweak_site(project_dir: Path, text: str) -> dict:
    text = (text or "").strip()[:300]
    path = project_dir / "site_tweaks.json"
    if not text:
        return {"changed": [], "message": "Type what you would like to change. " + HELP}
    if re.search(r"\b(reset|start over|undo all|original design)\b", text.lower()):
        path.unlink(missing_ok=True)
        changed, ov = ["back to the original design"], {}
    else:
        new, changed = parse(text)
        if not changed:
            return {"changed": [], "message": "I could not match that. " + HELP}
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        ov = merge(old, new)
        path.write_text(json.dumps(ov, ensure_ascii=False, indent=2), encoding="utf-8")
    req = json.loads((project_dir / "requirements.json").read_text(encoding="utf-8"))
    spec_file = project_dir / "frontend_api_spec.json"
    spec = json.loads(spec_file.read_text(encoding="utf-8")) if spec_file.exists() else {"pages": []}
    idea_file = project_dir / "idea.txt"
    idea = idea_file.read_text(encoding="utf-8") if idea_file.exists() else ""
    write_static_site(project_dir, idea, req, spec)
    return {"changed": changed, "message": "Done: " + ", ".join(changed) + "."}
