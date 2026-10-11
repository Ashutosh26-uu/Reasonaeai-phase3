"""Colour engine for generated websites.

From one accent colour (or just a hue) and a mood it builds a complete palette:
background, surface, text, muted text, a second harmonious accent, tints and lines.
Text contrast is checked (WCAG) and adjusted, so any colour a user asks for stays readable.
"""
import colorsys


def _rgb(hex_color):
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _hex(r, g, b):
    return "#%02x%02x%02x" % tuple(round(max(0.0, min(1.0, c)) * 255) for c in (r, g, b))


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, max(0.0, min(1.0, l)), max(0.0, min(1.0, s)))
    return _hex(r, g, b)


def to_hsl(hex_color):
    r, g, b = _rgb(hex_color)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return h * 360, s, l


def luminance(hex_color):
    def channel(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in _rgb(hex_color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def mix(a, b, t):
    return _hex(*[x + (y - x) * t for x, y in zip(_rgb(a), _rgb(b))])


# How far the second accent sits from the first on the colour wheel, per mood.
HARMONY = {"calm": 22, "bold": 150, "playful": 48, "elegant": -22, "modern": 40, "luxury": 0}


def _nudge(color, h, target_bg, minimum, direction):
    """Move a colour's lightness until it reaches the contrast `minimum` against target_bg."""
    for _ in range(25):
        if contrast(color, target_bg) >= minimum:
            break
        _, s, l = to_hsl(color)
        color = hsl(h, s, l + direction * 0.02)
    return color


def build_palette(accent=None, mood="modern", dark=False, hue=0.0):
    if accent:
        h, s, l = to_hsl(accent)
        accent = hsl(h, max(s, 0.45), min(max(l, 0.34), 0.66 if dark else 0.54))
    else:
        h = hue % 360
        accent = hsl(h, 0.70, 0.60 if dark else 0.44)
    h = to_hsl(accent)[0]

    if mood == "luxury":
        accent2 = hsl(43, 0.82, 0.56)
    else:
        accent2 = hsl(h + (HARMONY.get(mood, 48) or 48), 0.72, 0.62 if dark else 0.52)

    if dark:
        bg, surface, ink, muted = hsl(h, 0.30, 0.07), hsl(h, 0.24, 0.115), hsl(h, 0.20, 0.95), hsl(h, 0.12, 0.70)
        direction = 1
    else:
        bg, surface, ink, muted = hsl(h, 0.38, 0.972), "#ffffff", hsl(h, 0.28, 0.10), hsl(h, 0.14, 0.36)
        direction = -1

    # Button colour: text on it must reach 4.5:1.
    on_accent = "#ffffff" if contrast(accent, "#ffffff") >= contrast(accent, "#111111") else "#111111"
    for _ in range(25):
        if contrast(accent, on_accent) >= 4.5:
            break
        _, s, l = to_hsl(accent)
        accent = hsl(h, s, l + (-0.02 if on_accent == "#ffffff" else 0.02))
    # Accent used as *text* on the page background must also be readable.
    accent_text = _nudge(accent, h, bg, 4.5, direction)
    muted = _nudge(muted, h, bg, 4.5, direction)
    ink = _nudge(ink, h, bg, 7.0, direction)

    return {
        "bg": bg, "surface": surface, "ink": ink, "muted": muted,
        "accent": accent, "accent2": accent2, "at": accent_text, "on": on_accent,
        "accent_d": mix(accent, "#000000" if on_accent == "#ffffff" else "#ffffff", 0.35),
        "soft": mix(accent, bg, 0.88), "line": mix(ink, bg, 0.13), "line2": mix(ink, bg, 0.28),
    }
