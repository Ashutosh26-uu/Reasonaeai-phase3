"""Static website engine: idea -> plan (mood, colours, layouts, content) -> one HTML file.

The local model only makes small decisions (a JSON design brief). Colours, layouts, animation and
accessibility come from the design system in this package, so the result is quick and reliable
even on a CPU-only laptop. Same idea always gives the same site; different ideas look different.
"""
import json
import os
import random
import re
from pathlib import Path

from site_builder import (COLORS, GENERIC_CARDS, GENERIC_GALLERY, KINDS, _clip, _contact_cfg, _hash, _hex, _kind,
                          _pairs, _pick, _sections, _text, ai_design_brief)

from .palette import build_palette
from .render import (FONTS, GALLERIES, HEROES, HOURS, NAVS, SANS, SERIF, SERVICES, STYLES, BUILDERS, render)

HUES = (("jewel", 43), ("coffee", 28), ("caf", 28), ("bak", 340), ("dog", 150), ("pet", 150), ("repair", 24), ("gym", 8), ("fitness", 8),
        ("yoga", 165), ("law", 215), ("legal", 215), ("clinic", 192), ("dental", 192), ("health", 190), ("school", 45),
        ("kids", 45), ("salon", 322), ("beauty", 322), ("travel", 200), ("photograph", 265), ("portfolio", 255),
        ("restaurant", 14), ("florist", 330), ("garden", 135))
MOODS = (("luxury", ("luxury", "premium", "upscale", "boutique", "elegant", "jewel")),
         ("playful", ("kids", "fun", "playful", "colorful", "colourful", "toy", "party")),
         ("bold", ("bold", "gym", "fitness", "startup", "tech", "sport")),
         ("calm", ("yoga", "spa", "wellness", "calm", "clinic", "cafe", "café", "coffee", "bakery")))
EYEBROW = {"calm": "Welcome to", "bold": "Meet", "luxury": "Introducing", "playful": "Say hello to",
           "elegant": "Welcome to", "modern": "Welcome to"}
MOOD_OK = ("calm", "bold", "playful", "luxury", "elegant", "modern")


def _first_emoji(value, default):
    """Keep ONE emoji (the model sometimes returns several, or a word). Handles ZWJ/skin-tone sequences."""
    if not isinstance(value, str) or not value.strip() or ord(value.strip()[0]) < 0x2190:
        return default
    s = value.strip()
    out, i = s[0], 1
    while i < len(s) and (s[i] in "\ufe0f\u200d" or s[i - 1] == "\u200d" or 0x1F3FB <= ord(s[i]) <= 0x1F3FF):
        out += s[i]
        i += 1
    return out


def _mood(text, brief):
    ai = (brief or {}).get("mood")
    if ai in MOOD_OK:
        return ai
    for mood, words in MOODS:
        if any(w in text for w in words):
            return mood
    return "modern"


def make_plan(idea, requirements, spec, brief, ov=None):
    text, idea_l = _text(idea, requirements), (idea or "").lower()
    kind = _kind(text)
    base = KINDS.get(kind) or {
        "name": " ".join(w.capitalize() for w in re.split(r"[_\-\s]+", requirements.get("project_name", "My Site")) if w) or "My Site",
        "emoji": "✨", "cta": "Get in touch", "tagline": "Welcome! Here is everything you need to know about us.",
        "about": "A friendly local business built around people. Have a look around and say hello.",
        "cards": GENERIC_CARDS, "gallery": GENERIC_GALLERY,
        "hours": [["Mon – Fri", "9:00 – 17:00"], ["Saturday", "10:00 – 14:00"], ["Sunday", "Closed"]]}
    b = brief or {}
    ov = ov or {}
    seed = _hash(requirements.get("project_name", "") + (idea or ""))
    rng = random.Random(seed)
    mood = ov.get("mood") or _mood(text, brief)

    accent = ov.get("accent") or next((hexv for word, hexv in COLORS.items() if re.search(rf"\b{word}\b", idea_l)), None) or _hex(b.get("accent"), None)
    hue = next((h for word, h in HUES if word in text), 43 if mood == "luxury" else seed % 360)  # luxury defaults to gold
    dark = ov["dark"] if "dark" in ov else True if re.search(r"\bdark\b", idea_l) else False if re.search(r"\blight\b", idea_l) else \
        (b.get("mode") == "dark" or mood == "luxury" or (mood == "bold" and rng.random() < 0.4))
    palette = build_palette(accent, mood, dark, hue)

    fonts = SERIF if mood in ("calm", "elegant", "luxury") else SANS
    look = {
        "font": ov.get("font") or _pick(b.get("heading_font"), FONTS, rng.choice(fonts)),
        "hero": ov.get("hero") or _pick(b.get("hero"), HEROES, rng.choice(HEROES)),
        "style": ov.get("style") or _pick(b.get("style"), STYLES, rng.choice(STYLES)),
        "gallery": ov.get("gallery") or _pick(b.get("gallery_layout"), GALLERIES, rng.choice(GALLERIES)),
        "nav": ov.get("nav") or rng.choice(NAVS), "services": rng.choice(SERVICES), "hours": rng.choice(HOURS), "mood": mood, "dark": dark,
    }
    sections = [s for s in _sections(requirements) if s in BUILDERS and s not in ov.get("remove", [])]
    for extra in ov.get("add", []):
        if extra in BUILDERS and extra not in sections:
            sections.insert(sections.index("contact") if "contact" in sections else len(sections), extra)
    if "menu" not in sections and "about" not in sections:
        sections.insert(0, "about")
    name = ov.get("name") or _clip(b.get("business_name"), 40, base["name"])
    address = _clip(b.get("address"), 60, "12 Market Street, Old Town")
    phone = _clip(b.get("phone"), 24, "+1 555 0142")
    return {
        "seed": seed, "kind": kind, "name": name, "emoji": _first_emoji(b.get("emoji"), base["emoji"]),
        "eyebrow": EYEBROW[mood], "tagline": ov.get("tagline") or _clip(b.get("tagline"), 110, base["tagline"]),
        "about": _clip(b.get("about"), 240, base["about"]), "cta": _clip(b.get("cta"), 24, base["cta"]),
        "services": _pairs(b.get("cards"), ("icon", "title", "text"), 3, base["cards"]) if brief else base["cards"],
        "gallery": _pairs(b.get("gallery"), ("icon", "caption"), 6, base["gallery"]) if brief else base["gallery"],
        "hours": _pairs(b.get("hours"), ("day", "time"), 3, base["hours"]) if brief else base["hours"],
        "stats": [("4.9★", "Average rating"), ("2,000+", "Happy customers"), ("10 yrs", "Of experience")],
        "reviews": [("Absolutely loved it. Friendly team and everything felt carefully done.", "Priya S."),
                    ("The best in the neighbourhood. I recommend it to everyone I know.", "Daniel R."),
                    ("Great quality and a real sense of care. I'll be back soon!", "Mei L.")],
        "faq": [("Do I need to book in advance?", "Walk-ins are welcome, but booking ahead guarantees your spot."),
                ("Where are you located?", address), ("How can I contact you?", "Use the form below or call us on " + phone + ".")],
        "address": address, "phone": phone, "sections": sections, "contact": _contact_cfg(spec),
        "palette": palette, "look": look,
    }


def write_static_site(project_dir: Path, idea: str, requirements: dict, spec: dict) -> dict:
    # The AI design brief is saved with the project, so re-running (resume / "Open again") is instant
    # and the site keeps its look. Set CTO_REDESIGN=1 to ask the model for a fresh design.
    cache = project_dir / "site_brief.json"
    brief = None
    if cache.exists() and not os.environ.get("CTO_REDESIGN"):
        try:
            brief = json.loads(cache.read_text(encoding="utf-8"))
        except ValueError:
            brief = None
    if brief is None:
        brief = ai_design_brief(" ".join([idea or "", requirements.get("project_name", "")] +
                                         [f.get("name", "") + ": " + f.get("description", "") for f in requirements.get("features", [])]))
        if brief:
            cache.write_text(json.dumps(brief, ensure_ascii=False, indent=2), encoding="utf-8")
    tweaks = project_dir / "site_tweaks.json"
    ov = json.loads(tweaks.read_text(encoding="utf-8")) if tweaks.exists() else {}
    plan = make_plan(idea, requirements, spec, brief, ov)
    (project_dir / "frontend" / "index.html").write_text(render(plan), encoding="utf-8")
    lk = plan["look"]
    return {"kind": plan["kind"] or "custom", "name": plan["name"], "sections": plan["sections"], "ai": bool(brief),
            "look": "mood=%s, hero=%s, nav=%s, style=%s, gallery=%s, font=%s, %s, accent=%s" % (
                lk["mood"], lk["hero"], lk["nav"], lk["style"], lk["gallery"], lk["font"],
                "dark" if lk["dark"] else "light", plan["palette"]["accent"])}
