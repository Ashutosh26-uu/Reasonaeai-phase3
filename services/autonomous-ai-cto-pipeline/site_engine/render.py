"""Renders a site plan into ONE static HTML file (inline CSS + a little vanilla JS).

No React, no build step: the Docker frontend container serves it as-is, so a build takes seconds.
Every layout choice (hero, nav, services, hours, gallery, shape style, fonts) is a variant the
planner picks, so different ideas give visibly different sites.
"""
import html
import json
import math
import random
from urllib.parse import quote

FONTS = {  # name -> (google css2 family, css fallback, heading weight)
    "Playfair Display": ("Playfair+Display:wght@600;800", "Georgia,serif", 800),
    "DM Serif Display": ("DM+Serif+Display", "Georgia,serif", 400),
    "Fraunces": ("Fraunces:wght@600;800", "Georgia,serif", 800),
    "Lora": ("Lora:wght@600;700", "Georgia,serif", 700),
    "Poppins": ("Poppins:wght@600;800", "system-ui,sans-serif", 800),
    "Space Grotesk": ("Space+Grotesk:wght@500;700", "system-ui,sans-serif", 700),
    "Outfit": ("Outfit:wght@600;800", "system-ui,sans-serif", 800),
    "Sora": ("Sora:wght@600;800", "system-ui,sans-serif", 800),
}
SERIF = ("Playfair Display", "DM Serif Display", "Fraunces", "Lora")
SANS = ("Poppins", "Space Grotesk", "Outfit", "Sora")
HEROES, NAVS, STYLES = ("split", "center", "bold", "spot"), ("bar", "pill"), ("soft", "sharp", "outline")
GALLERIES, SERVICES, HOURS = ("grid", "mosaic"), ("cards", "list", "icons"), ("table", "chips")
TITLES = {"menu": "What we do", "about": "Our story", "hours": "Opening hours", "gallery": "Gallery",
          "reviews": "Kind words", "faq": "Questions", "contact": "Get in touch"}
NAV_LABEL = {"menu": "Services", "about": "About", "hours": "Hours", "gallery": "Gallery",
             "reviews": "Reviews", "faq": "FAQ", "contact": "Contact"}


def e(value):
    return html.escape(str(value), quote=True)


# ---------- generated art ----------
def _blob(rng, cx, cy, r, n=7, wobble=0.26):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * (1 - wobble + rng.random() * wobble * 2)
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d = "M%.1f,%.1f" % ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
    for i in range(1, n + 1):
        p0, p1 = pts[i % n], pts[(i + 1) % n]
        d += " Q%.1f,%.1f %.1f,%.1f" % (p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    return d + "Z"


def art_svg(pl):
    rng = random.Random(pl["seed"])
    p = pl["palette"]
    dots = "".join('<circle cx="%d" cy="%d" r="3" fill="%s" opacity=".35"/>' % (300 + (i % 5) * 18, 40 + (i // 5) * 18, p["on"] if pl["look"]["hero"] == "bold" else p["accent"]) for i in range(25))
    return (
        '<svg viewBox="0 0 400 400" role="img" aria-label="%s">'
        '<defs><linearGradient id="ga" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient>'
        '<linearGradient id="gb" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>'
        '<path d="%s" fill="url(#gb)" opacity=".35" transform="translate(26 -10) scale(1.04)"/>'
        '<path d="%s" fill="url(#ga)"/>'
        '<path d="%s" fill="%s" opacity=".18"/>%s'
        '<circle cx="86" cy="318" r="34" fill="%s" opacity=".9"/>'
        '<text x="200" y="232" font-size="132" text-anchor="middle">%s</text></svg>'
    ) % (e(pl["name"]), p["accent"], p["accent2"], p["accent2"], p["accent"],
         _blob(rng, 200, 200, 150), _blob(rng, 200, 200, 138), _blob(rng, 150, 150, 70), p["surface"], dots,
         p["accent2"], e(pl["emoji"]))


# ---------- sections ----------
def nav(pl):
    links = "".join('<a href="#%s">%s</a>' % (s, NAV_LABEL[s]) for s in pl["sections"] if s in NAV_LABEL)
    target = "contact" if "contact" in pl["sections"] else "top"
    return ('<header class="nav"><div class="wrap"><div class="nav-in"><a class="logo" href="#top"><i>%s</i>%s</a>'
            '<nav aria-label="Main">%s</nav><a class="btn sm" href="#%s">%s</a></div></div></header>'
            % (e(pl["emoji"]), e(pl["name"]), links, target, e(pl["cta"])))


def hero(pl):
    target = "contact" if "contact" in pl["sections"] else ("hours" if "hours" in pl["sections"] else "top")
    ghost = '<a class="btn ghost" href="#hours">Opening hours</a>' if "hours" in pl["sections"] and target != "hours" else ""
    stats = "".join("<li><b>%s</b><span>%s</span></li>" % (e(a), e(b)) for a, b in pl["stats"])
    return ('<section class="hero" id="top"><div class="wrap hero-in"><div class="rv"><p class="eyebrow">%s</p><h1>%s</h1>'
            '<p class="lead">%s</p><div class="cta"><a class="btn" href="#%s">%s</a>%s</div><ul class="stats">%s</ul></div>'
            '<div class="hero-art rv">%s</div></div></section>'
            % (e(pl["eyebrow"]), e(pl["name"]), e(pl["tagline"]), target, e(pl["cta"]), ghost, stats, art_svg(pl)))


def services(pl):
    v, items = pl["look"]["services"], pl["services"]
    if v == "list":
        body = '<ol class="rows">%s</ol>' % "".join(
            '<li class="rv"><span class="n">%02d</span><h3>%s</h3><p>%s</p></li>' % (i + 1, e(t), e(d)) for i, (_, t, d) in enumerate(items))
    elif v == "icons":
        body = '<div class="icons">%s</div>' % "".join(
            '<div class="it rv"><div class="ico">%s</div><h3>%s</h3><p>%s</p></div>' % (e(i), e(t), e(d)) for i, t, d in items)
    else:
        body = '<div class="grid3">%s</div>' % "".join(
            '<div class="card rv"><div class="ico">%s</div><h3>%s</h3><p>%s</p></div>' % (e(i), e(t), e(d)) for i, t, d in items)
    return '<p class="sub rv">%s</p>%s' % (e(pl["about"]), body)


def about(pl):
    vals = "".join('<li><span>%s</span>%s</li>' % (e(i), e(t)) for i, t, _ in pl["services"])
    return '<div class="about"><p class="big rv">%s</p><ul class="vals rv">%s</ul></div>' % (e(pl["about"]), vals)


def hours(pl):
    if pl["look"]["hours"] == "chips":
        return '<div class="chips">%s</div>' % "".join(
            '<div class="chip rv" data-hrow="%d"><b>%s</b>%s</div>' % (i, e(d), e(t)) for i, (d, t) in enumerate(pl["hours"]))
    return '<div class="card hours-card rv">%s</div>' % "".join(
        '<div class="hrow" data-hrow="%d"><span>%s</span><b>%s</b></div>' % (i, e(d), e(t)) for i, (d, t) in enumerate(pl["hours"]))


def gallery(pl):
    return '<div class="gallery">%s</div>' % "".join(
        '<figure class="tile t%d rv"><span>%s</span><figcaption>%s</figcaption></figure>' % (k % 4, e(i), e(c)) for k, (i, c) in enumerate(pl["gallery"]))


def reviews(pl):
    return '<div class="grid3">%s</div>' % "".join(
        '<figure class="card rv"><div class="stars" aria-label="5 stars">★★★★★</div><blockquote class="q">%s</blockquote>'
        '<figcaption class="who">%s</figcaption></figure>' % (e(q), e(n)) for q, n in pl["reviews"])


def faq(pl):
    return '<div class="faq">%s</div>' % "".join(
        '<details class="rv"><summary>%s</summary><p>%s</p></details>' % (e(q), e(a)) for q, a in pl["faq"])


def contact(pl):
    return ('<div class="contact-grid"><form class="card form rv" id="cform">'
            '<label>Your name<input name="name" required placeholder="Jane Doe" autocomplete="name"></label>'
            '<label>Email<input name="email" type="email" required placeholder="jane@example.com" autocomplete="email"></label>'
            '<label>Message<textarea name="message" rows="5" required placeholder="How can we help?"></textarea></label>'
            '<button class="btn" type="submit">Send message</button><p class="note" id="cnote" role="status"></p></form>'
            '<div class="card info rv"><h3>Find us</h3><p>📍 %s</p><p>📞 %s</p><p>✉️ hello@%s.example</p>'
            '<div class="map" aria-hidden="true">%s</div></div></div>'
            % (e(pl["address"]), e(pl["phone"]), "".join(c for c in pl["name"].lower() if c.isalnum()), e(pl["emoji"])))


BUILDERS = {"menu": services, "about": about, "hours": hours, "gallery": gallery, "reviews": reviews, "faq": faq, "contact": contact}


def footer(pl):
    links = "".join('<a href="#%s">%s</a>' % (s, NAV_LABEL[s]) for s in pl["sections"] if s in NAV_LABEL)
    return ('<footer class="footer"><div class="wrap foot-in"><div><b>%s %s</b><p>%s</p></div><nav>%s</nav></div>'
            '<div class="wrap copy">© %s · A sample site</div></footer>' % (e(pl["emoji"]), e(pl["name"]), e(pl["tagline"]), links, "2026"))


# ---------- page ----------
_JS = """(function(){
var rv=document.querySelectorAll('.rv');
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target)}})},{threshold:.12});rv.forEach(function(n){io.observe(n)})}else{rv.forEach(function(n){n.classList.add('in')})}
var d=(new Date().getDay()+6)%7,i=d<5?0:d===5?1:2,t=document.querySelector('[data-hrow="'+i+'"]');if(t)t.classList.add('today');
var f=document.getElementById('cform');
if(f){f.addEventListener('submit',function(ev){ev.preventDefault();var n=document.getElementById('cnote'),b=f.querySelector('button');
if(!CONTACT){n.className='note error';n.textContent='No contact endpoint was generated for this site.';return}
b.disabled=true;n.className='note';n.textContent='Sending...';
var body=Object.assign({},CONTACT.extra);body[CONTACT.messageKey]='From '+f.name.value+' <'+f.email.value+'>: '+f.message.value;
fetch(CONTACT.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){
if(!r.ok)return r.json().catch(function(){return{}}).then(function(j){throw new Error(typeof j.detail==='string'?j.detail:'The server could not save your message ('+r.status+').')});
f.reset();n.className='note ok';n.textContent="Thanks! Your message was sent. We'll get back to you soon."}).catch(function(err){
n.className='note error';n.textContent=err.message==='Failed to fetch'?'Cannot reach the server. Is the backend running?':err.message}).then(function(){b.disabled=false})})}
})();"""


def render(pl):
    p, lk = pl["palette"], pl["look"]
    font = FONTS[lk["font"]]
    radius = {"soft": ("22px", "999px"), "sharp": ("4px", "4px"), "outline": ("12px", "999px")}[lk["style"]]
    vars_css = ";".join("--%s:%s" % (k.replace("_", "-"), v) for k, v in p.items() if isinstance(v, str))
    vars_css += ";--r:%s;--rb:%s;--hfont:\"%s\",%s;--hw:%d" % (radius[0], radius[1], lk["font"], font[1], font[2])
    sections = []
    for i, key in enumerate(pl["sections"]):
        alt = " alt" if i % 2 else ""
        sections.append('<section class="sec%s" id="%s"><div class="wrap"><h2 class="rv">%s</h2>%s</div></section>'
                        % (alt, key, TITLES[key], BUILDERS[key](pl)))
    favicon = "data:image/svg+xml," + quote("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%s</text></svg>" % pl["emoji"])
    contact_json = json.dumps(pl["contact"]).replace("</", "<\\/")
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>%s</title><link rel="icon" href="%s">'
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=%s&display=swap">'
        '<style>:root{%s}%s</style><noscript><style>.rv{opacity:1!important;transform:none!important}</style></noscript></head>'
        '<body data-hero="%s" data-nav="%s" data-style="%s" data-gal="%s">%s<main>%s%s</main>%s'
        '<script>var CONTACT=%s;%s</script></body></html>'
        % (e(pl["name"]), favicon, font[0], vars_css, CSS, lk["hero"], lk["nav"], lk["style"], lk["gallery"],
           nav(pl), hero(pl), "".join(sections), footer(pl), contact_json, _JS))


CSS = """
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:400 1.02rem/1.65 Inter,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body:before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(900px 520px at 85% -8%,var(--soft),transparent 70%),radial-gradient(700px 420px at -5% 35%,color-mix(in srgb,var(--accent2) 14%,transparent),transparent 70%)}
h1,h2,h3{font-family:var(--hfont);font-weight:var(--hw);line-height:1.1;margin:0;letter-spacing:-.02em}
a{color:inherit;text-decoration:none}svg{max-width:100%}.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.btn{display:inline-flex;align-items:center;gap:8px;border:0;cursor:pointer;background:var(--accent);color:var(--on);font:600 1rem Inter,system-ui,sans-serif;padding:14px 28px;border-radius:var(--rb);box-shadow:0 14px 30px -14px var(--accent);transition:transform .2s,box-shadow .2s}
.btn:hover{transform:translateY(-2px);box-shadow:0 20px 34px -14px var(--accent)}.btn:disabled{opacity:.6;cursor:wait}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line2)}.btn.sm{padding:10px 20px;font-size:.92rem}
.nav{position:sticky;top:0;z-index:20;backdrop-filter:blur(14px);background:color-mix(in srgb,var(--bg) 82%,transparent);border-bottom:1px solid var(--line)}
.nav-in{display:flex;align-items:center;justify-content:space-between;gap:20px;height:70px}
.logo{display:flex;align-items:center;gap:10px;font:var(--hw) 1.2rem var(--hfont)}.logo i{font-style:normal;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--soft)}
.nav nav{display:flex;gap:26px;font-size:.94rem;color:var(--muted)}.nav nav a:hover{color:var(--at)}
[data-nav=pill] .nav{background:none;border:0;backdrop-filter:none;top:12px}
[data-nav=pill] .nav-in{background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:999px;padding:0 12px 0 20px;height:62px;box-shadow:0 14px 40px -24px rgba(0,0,0,.45)}
.hero{padding:84px 0 96px}.hero-in{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center}
.eyebrow{color:var(--at);font-weight:600;letter-spacing:.14em;text-transform:uppercase;font-size:.78rem;margin:0 0 14px}
.hero h1{font-size:clamp(2.6rem,6.4vw,4.7rem)}.lead{font-size:1.2rem;color:var(--muted);max-width:36ch;margin:20px 0 30px}
.cta{display:flex;gap:12px;flex-wrap:wrap}.hero-art svg{width:100%;height:auto;display:block;filter:drop-shadow(0 30px 40px color-mix(in srgb,var(--accent) 28%,transparent))}
.stats{display:flex;gap:30px;list-style:none;padding:0;margin:38px 0 0;flex-wrap:wrap}.stats b{display:block;font:var(--hw) 1.6rem var(--hfont)}.stats span{font-size:.85rem;color:var(--muted)}
[data-hero=center] .hero-in{grid-template-columns:1fr;text-align:center}[data-hero=center] .lead{margin-inline:auto}
[data-hero=center] .cta,[data-hero=center] .stats{justify-content:center}[data-hero=center] .hero-art{max-width:400px;margin:20px auto 0}
[data-hero=bold] .hero{background:linear-gradient(135deg,var(--accent),var(--accent-d));color:var(--on);border-radius:0 0 var(--r) var(--r)}
[data-hero=bold] .eyebrow,[data-hero=bold] .lead,[data-hero=bold] .stats span{color:var(--on);opacity:.88}
[data-hero=bold] .hero .btn{background:var(--on);color:var(--accent);box-shadow:none}[data-hero=bold] .hero .btn.ghost{background:transparent;color:var(--on);box-shadow:inset 0 0 0 1.5px var(--on)}
[data-hero=spot] .hero-in{grid-template-columns:1.5fr .5fr}[data-hero=spot] h1{font-size:clamp(3rem,9.4vw,6.6rem)}[data-hero=spot] .lead{max-width:44ch}
.sec{padding:96px 0}.sec.alt{background:color-mix(in srgb,var(--ink) 3.5%,var(--bg))}
.sec h2{font-size:clamp(1.9rem,4.2vw,2.8rem);margin-bottom:14px}.sub{color:var(--muted);max-width:58ch;margin:0 0 40px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:28px;box-shadow:0 20px 44px -30px rgba(0,0,0,.4);transition:transform .25s}.card:hover{transform:translateY(-4px)}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:22px;margin:0}
.ico{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;font-size:1.7rem;background:var(--soft);margin-bottom:16px}
.card h3,.it h3{font-size:1.25rem;margin-bottom:8px}.card p,.it p{margin:0;color:var(--muted)}
.rows{list-style:none;margin:0;padding:0}.rows li{display:grid;grid-template-columns:70px 1fr 1.4fr;gap:20px;align-items:center;padding:26px 0;border-top:1px solid var(--line2)}
.rows li:last-child{border-bottom:1px solid var(--line2)}.rows .n{font:var(--hw) 1.6rem var(--hfont);color:var(--at)}.rows h3{font-size:1.4rem}.rows p{margin:0;color:var(--muted)}
.icons{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:34px}.it{text-align:center}.it .ico{margin:0 auto 14px;width:76px;height:76px;font-size:2rem;border-radius:50%}
.about{display:grid;grid-template-columns:1.3fr .7fr;gap:48px;align-items:start}.big{font:var(--hw) clamp(1.3rem,2.6vw,1.9rem)/1.4 var(--hfont);margin:0}
.vals{list-style:none;margin:0;padding:0;display:grid;gap:12px}.vals li{display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px;font-weight:600}.vals span{font-size:1.4rem}
.hours-card{max-width:560px;padding:8px 26px;margin-top:20px}.hrow{display:flex;justify-content:space-between;padding:18px 0;border-bottom:1px dashed var(--line2)}.hrow:last-child{border:0}
.hrow.today span{color:var(--at);font-weight:600}.hrow.today span:after{content:"Today";margin-left:10px;font-size:.7rem;background:var(--accent);color:var(--on);border-radius:99px;padding:2px 9px;vertical-align:middle}
.chips{display:flex;flex-wrap:wrap;gap:14px;margin-top:20px}.chip{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 24px}.chip b{display:block;color:var(--at)}.chip.today{outline:2px solid var(--accent)}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:20px}
.tile{margin:0;aspect-ratio:4/3;border-radius:var(--r);display:grid;place-items:center;position:relative;overflow:hidden;font-size:3.4rem;transition:transform .3s}.tile:hover{transform:scale(1.03) rotate(-.4deg)}
.t0{background:linear-gradient(135deg,var(--accent),var(--accent2))}.t1{background:linear-gradient(225deg,var(--accent2),var(--accent-d))}.t2{background:linear-gradient(315deg,var(--accent-d),var(--accent))}.t3{background:radial-gradient(circle at 30% 20%,var(--accent2),var(--accent-d))}
.tile figcaption{position:absolute;left:0;right:0;bottom:0;padding:26px 16px 12px;font:600 .9rem Inter,sans-serif;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.6))}
[data-gal=mosaic] .gallery{grid-template-columns:repeat(4,1fr);grid-auto-rows:150px}[data-gal=mosaic] .tile{aspect-ratio:auto}
[data-gal=mosaic] .tile:nth-child(1){grid-column:span 2;grid-row:span 2;font-size:5rem}[data-gal=mosaic] .tile:nth-child(4){grid-column:span 2}
.stars{color:var(--accent2);letter-spacing:3px;margin-bottom:10px}.q{font:var(--hw) 1.1rem/1.5 var(--hfont);margin:0}.who{margin-top:14px;font-size:.88rem;color:var(--muted)}
.faq{display:grid;gap:12px;max-width:760px}details{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 22px}summary{cursor:pointer;font-weight:600}details p{margin:10px 0 0;color:var(--muted)}
.contact-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:24px;margin-top:20px}.form{display:grid;gap:16px}
.form label{display:grid;gap:6px;font-size:.85rem;font-weight:600;color:var(--muted)}
.form input,.form textarea{font:400 1rem Inter,system-ui,sans-serif;padding:13px 15px;border-radius:calc(var(--r) / 2);border:1.5px solid var(--line2);background:var(--bg);color:var(--ink)}
.form input:focus,.form textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent)}.form .btn{justify-self:start}
.note{margin:0;padding:0;min-height:1.2em;font-size:.92rem;color:var(--muted)}.note.ok{color:#127a47;font-weight:600}.note.error{color:#b3261e;font-weight:600}
.info h3{margin-bottom:14px}.info p{margin:8px 0;color:var(--muted)}.map{margin-top:18px;height:130px;border-radius:var(--r);display:grid;place-items:center;font-size:3rem;background:repeating-linear-gradient(45deg,var(--soft),var(--soft) 12px,var(--bg) 12px,var(--bg) 24px)}
.footer{border-top:1px solid var(--line);padding:46px 0 26px;color:var(--muted)}.foot-in{display:flex;justify-content:space-between;gap:30px;flex-wrap:wrap}.foot-in b{color:var(--ink)}.foot-in p{margin:6px 0 0;max-width:34ch}
.foot-in nav{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}.copy{margin-top:30px;font-size:.85rem}
[data-style=sharp]{--r:4px}[data-style=outline] .card,[data-style=outline] details,[data-style=outline] .chip,[data-style=outline] .vals li{box-shadow:none;border:2px solid var(--ink)}
.rv{opacity:0;transform:translateY(18px);transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .7s cubic-bezier(.2,.7,.2,1)}.rv.in{opacity:1;transform:none}
@media(prefers-reduced-motion:reduce){.rv{opacity:1;transform:none;transition:none}html{scroll-behavior:auto}}
@media(max-width:820px){.nav nav{display:none}.hero{padding:56px 0 64px}.hero-in,.about,.contact-grid,[data-hero=spot] .hero-in{grid-template-columns:1fr}.hero-art{max-width:300px;margin:0 auto}
.rows li{grid-template-columns:50px 1fr}.rows p{grid-column:2}.gallery,[data-gal=mosaic] .gallery{grid-template-columns:repeat(2,1fr)}[data-gal=mosaic] .tile:nth-child(n){grid-column:auto;grid-row:auto}.sec{padding:64px 0}}
"""
