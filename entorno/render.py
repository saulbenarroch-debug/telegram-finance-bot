# -*- coding: utf-8 -*-
"""
Entorno en Vinetas - genera las laminas PNG (1414x2000, A4 vertical) del
newsletter semanal a partir de la edicion que arma el Worker.

Uso:
  py render.py                 -> baja la edicion del Worker y genera los PNG
  py render.py --datos x.json  -> usa un JSON local (sin red)
  py render.py --html          -> solo HTML, para inspeccionar en el navegador

El diseno es un clon del Canva "entorno en vinetas" (id DAHOniEgyiw): los
colores y la geometria se midieron sobre la exportacion PNG de la plantilla
(assets/referencia), no se estimaron a ojo.
  fondo #000000 · gris de tarjeta #313131 · coral #E8524C · texto #FFFFFF

Las laminas con texto variable se AUTO-AJUSTAN: Chrome mide el bloque y, si no
cabe, se reescala. Sin eso, la semana que la IA escriba largo la lamina se
corta en silencio.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import date
from pathlib import Path

BASE = Path(__file__).parent
ASSETS = BASE / "assets"
OUT = BASE / "out"

W, H = 1414, 2000  # lienzo A4 vertical (ratio 0,707 de la plantilla)

CHROME = (
    os.environ.get("CHROME_BIN")
    or shutil.which("google-chrome")
    or shutil.which("chromium-browser")
    or r"C:\Program Files\Google\Chrome\Application\chrome.exe"
)

WORKER = os.environ.get("WORKER_URL", "https://sureconomics-bot.sureconomics.workers.dev")

NAV_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
}

MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


# ------------------------------------------------------------------ datos

def leer_secreto():
    if os.environ.get("WEBHOOK_SECRET"):
        return os.environ["WEBHOOK_SECRET"].strip()
    env = BASE.parent / ".env"
    if env.exists():
        for linea in env.read_text(encoding="utf-8").splitlines():
            if linea.startswith("WEBHOOK_SECRET="):
                return linea.split("=", 1)[1].strip()
    raise SystemExit("falta WEBHOOK_SECRET (.env o variable de entorno)")


def bajar_edicion():
    url = f"{WORKER}/entorno?key={leer_secreto()}&formato=json"
    req = urllib.request.Request(url, headers={"User-Agent": "EntornoRender/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def bajar_foto(url, dest):
    """Baja la imagen destacada del articulo fuente. Si falla, la lamina sale
    con fondo negro: se degrada, no se rompe."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers=NAV_UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            datos = r.read()
        if len(datos) < 4000:
            return None
        ext = ".jpg" if b"\xff\xd8" == datos[:2] else ".png"
        p = dest / ("foto" + ext)
        p.write_bytes(datos)
        print(f"     foto {len(datos)//1024} KB -> {p.name}")
        return p
    except Exception as e:
        print("     sin foto:", e)
        return None


# ------------------------------------------------------------------ formato

def num(v, dec=2):
    if v is None:
        return "s/d"
    s = f"{abs(v):,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if v < 0 else "") + s


def pct(v, dec=1):
    if v is None:
        return "s/d"
    return ("+" if v >= 0 else "") + num(v, dec) + "%"


def fecha_corta(iso):
    if not iso:
        return ""
    a, m, d = iso[:10].split("-")
    return f"{int(d)}-{MESES[int(m) - 1][:3]}"


def fecha_larga(iso):
    a, m, d = iso[:10].split("-")
    return f"{int(d)} de {MESES[int(m) - 1]} de {a}"


def esc_html(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def parrafos(txt):
    return [p.strip() for p in re.split(r"\n\s*\n", str(txt or "")) if p.strip()]


# ------------------------------------------------------------------ estilo

CSS_BASE = """
@font-face { font-family:'Poppins'; font-weight:500; src:url('__A__/fonts/Poppins-500.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-weight:600; src:url('__A__/fonts/Poppins-600.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-weight:700; src:url('__A__/fonts/Poppins-700.woff2') format('woff2'); }
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1414px; height:2000px; }
.page { position:relative; width:1414px; height:2000px; background:#000000; overflow:hidden;
        font-family:'Poppins',sans-serif; color:#FFFFFF; }
.abs { position:absolute; }
.marca { top:0; left:0; width:1414px; height:118px; border-bottom:2px solid #FFFFFF; z-index:5; }
.marca .izq { position:absolute; left:46px;  top:38px; font-weight:500; font-size:30px; letter-spacing:2px; }
.marca .der { position:absolute; right:46px; top:38px; font-weight:500; font-size:30px; letter-spacing:2px; }
/* titulo de seccion: geometrica pesada, condensada como en el Canva */
.titulo { font-weight:700; line-height:0.94; letter-spacing:-2px;
          transform:scaleX(0.94); transform-origin:left top; }
.pie { left:67px; bottom:40px; font-weight:500; font-size:25px; color:#8A8A8A; letter-spacing:1px; }
.fit { transform-origin:left top; }
"""

CSS_CIFRAS = """
.card-dolar { left:67px; top:470px; width:1347px; height:210px; background:#313131; }
.card-dolar .et { position:absolute; left:40px; top:62px; font-weight:500; font-size:68px; letter-spacing:1px; }
.pill { position:absolute; top:26px; height:158px; background:#FFFFFF; color:#000000;
        border-radius:26px; padding:22px 30px; }
.pill .lb { font-weight:500; font-size:24px; letter-spacing:3px; line-height:1.15; color:#3A3A3A; }
.pill .vl { font-weight:700; font-size:46px; line-height:1.1; margin-top:6px; white-space:nowrap; }
.brecha { left:67px; top:681px; width:1347px; height:37px; background:#E8524C; }
.brecha .lb { position:absolute; left:56px; top:4px; font-weight:500; font-size:27px; letter-spacing:2px; }
.brecha .vl { position:absolute; left:420px; top:2px; font-weight:600; font-style:italic; font-size:29px; }
/* En flujo (flex), no en posiciones fijas: cada tarjeta crece con su contenido
   y una linea que envuelve no se sale de la caja blanca. */
.cards { left:0; top:770px; width:1414px; display:flex; flex-direction:column;
         align-items:flex-start; gap:24px; }
.tarjeta { background:#FFFFFF; color:#000000; padding:26px 40px 30px 40px; }
.tarjeta h3 { color:#E8524C; font-weight:700; font-size:44px; line-height:1.05; }
.tarjeta .l { font-weight:500; font-size:33px; line-height:1.5; }
.tarjeta .l b { font-weight:700; }
.tarjeta .chico { font-size:29px; color:#3A3A3A; }
"""

CSS_PORTADA = """
.foto-full { inset:0; width:1414px; height:2000px; object-fit:cover; filter:brightness(0.42) grayscale(0.25); }
.velo { inset:0; background:linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 45%, rgba(0,0,0,0.85) 100%); }
.fecha-pill { left:170px; top:270px; border:3px solid #FFFFFF; border-radius:60px;
              padding:14px 44px; font-weight:500; font-size:34px; letter-spacing:6px; }
.marca-tit { left:160px; top:370px; font-size:150px; }
.franja { left:0; bottom:0; width:1414px; background:#313131; padding:56px 160px 70px 160px; }
.franja .et { font-weight:500; font-size:44px; letter-spacing:6px; color:#DADADA; }
.franja .tt { font-weight:700; font-size:74px; line-height:1.06; letter-spacing:-1px; margin-top:10px;
              transform:scaleX(0.95); transform-origin:left top; }
.franja .sm { font-weight:500; font-size:29px; line-height:1.45; color:#C9C9C9; margin-top:22px; }
"""

CSS_NOTICIA = """
.cab { left:0; top:118px; width:1414px; background:#000000; padding:52px 0 46px 0; }
.nicho { position:absolute; left:74px; top:150px; font-weight:700; font-size:34px; letter-spacing:4px;
         writing-mode:vertical-rl; transform:rotate(180deg); }
.cab .tt { margin-left:196px; margin-right:80px; font-weight:700; font-size:92px; line-height:0.98;
           letter-spacing:-2px; transform:scaleX(0.95); transform-origin:left top; }
.cab .sub { margin-left:196px; margin-right:90px; margin-top:26px; font-weight:500; font-size:36px;
            line-height:1.3; color:#E8524C; }
.cuerpo { left:0; width:1414px; background:#FFFFFF; color:#000000; }
.cuerpo .foto { position:absolute; left:8px; top:0; width:610px; height:100%; object-fit:cover; }
.cuerpo .txt { margin-left:668px; margin-right:70px; padding:44px 0 44px 0; }
.cuerpo p { font-weight:500; font-size:31px; line-height:1.52; text-align:justify; margin-bottom:26px; }
.cierre { left:0; width:1414px; background:#000000; padding:44px 100px 40px 100px; }
.cierre p { font-weight:500; font-size:30px; line-height:1.5; text-align:justify; }
.cierre .bullet { color:#E8524C; font-weight:700; }
.credito { margin-top:26px; font-weight:500; font-size:24px; color:#8A8A8A; }
"""

CSS_LATAM = """
.items { left:0; top:430px; width:1414px; display:flex; flex-direction:column;
         align-items:flex-start; gap:26px; }
.item { background:#FFFFFF; color:#000000; padding:24px 40px 28px 40px; }
.item h3 { color:#E8524C; font-weight:700; font-size:40px; line-height:1.08; }
.item p { font-weight:500; font-size:30px; line-height:1.45; margin-top:6px; }
"""


def css(*extras):
    return (CSS_BASE + "".join(extras)).replace("__A__", ASSETS.as_uri())


def marca():
    return ('<div class="abs marca"><div class="izq">ÓSCAR DOVAL</div>'
            '<div class="der">MUNDO ECONÓMICO</div></div>')


# ------------------------------------------------------------------ laminas

def html_portada(ed, esc=1.0, foto=None):
    s = ed.get("secciones", {})
    fondo = (f'<img class="abs foto-full" src="{foto.as_uri()}">' if foto else "")
    anio, mes, dia = ed["hoy"].split("-")  # la plantilla usa DD/MM/AA
    return f"""<!doctype html><meta charset="utf-8"><style>{css(CSS_PORTADA)}</style>
<div class="page">
  {fondo}<div class="abs velo"></div>
  {marca()}
  <div class="abs fecha-pill">{dia}/{mes}/{anio[2:]}</div>
  <div class="abs titulo marca-tit">Entorno en<br>Viñetas</div>
  <div class="abs franja fit" style="transform:scale({esc:.4f})">
    <div class="et">Resumen semanal</div>
    <div class="tt">{esc_html(s.get('TITULAR', ''))}</div>
    <div class="sm">{esc_html(s.get('CONTRAPORTADA', ''))}</div>
  </div>
</div>"""


def html_noticia(ed, esc=1.0, foto=None):
    s = ed.get("secciones", {})
    ps = parrafos(s.get("CUERPO", ""))
    arriba, abajo = ps[:2], ps[2:]
    img = (f'<img class="foto" src="{foto.as_uri()}">' if foto else "")
    port = ed.get("portada") or {}
    credito = ""
    if port.get("titulo"):
        credito = (f'<div class="credito">Fuente: {esc_html(port["titulo"])}'
                   + (f' — {esc_html(port["medio"])}' if port.get("medio") else "") + "</div>")
    return f"""<!doctype html><meta charset="utf-8"><style>{css(CSS_NOTICIA)}</style>
<div class="page">
  {marca()}
  <div class="abs cab" id="cab">
    <div class="nicho">{esc_html(s.get('NICHO', 'VENEZUELA').split('/')[0].strip())}</div>
    <div class="tt">{esc_html(s.get('TITULAR', ''))}</div>
    <div class="sub">{esc_html(s.get('SUBTITULO', ''))}</div>
  </div>
  <div class="abs cuerpo fit" id="cuerpo" style="top:__TOP_CUERPO__px;transform:scale({esc:.4f})">
    {img}<div class="txt">{''.join(f'<p>{esc_html(p)}</p>' for p in arriba)}</div>
  </div>
  <div class="abs cierre" id="cierre" style="top:__TOP_CIERRE__px">
    {''.join(f'<p><span class="bullet">▪</span> {esc_html(p)}</p>' for p in abajo)}
    {credito}
  </div>
</div>"""


def html_latam(ed, esc=1.0, foto=None):
    s = ed.get("secciones", {})
    bloques = []
    sangrias = [300, 210, 330, 240]
    for i, crudo in enumerate([x.strip() for x in re.split(r"\n?-{3,}\n?", s.get("LATAM", "")) if x.strip()][:4]):
        lineas = [l.strip() for l in crudo.split("\n") if l.strip()]
        if not lineas:
            continue
        sang = sangrias[i % len(sangrias)]
        bloques.append(
            f'<div class="item" style="margin-left:{sang}px;width:{1414 - sang}px">'
            f'<h3>{esc_html(lineas[0])}</h3><p>{esc_html(" ".join(lineas[1:]))}</p></div>'
        )
    return f"""<!doctype html><meta charset="utf-8"><style>{css(CSS_LATAM)}</style>
<div class="page">
  {marca()}
  <div class="abs titulo" style="left:67px;top:200px;font-size:118px">LATAM<br>ENLATADA</div>
  <div class="abs items fit" style="transform:scale({esc:.4f})">{''.join(bloques)}</div>
  <div class="abs pie">{fecha_larga(ed['hoy'])} · Entorno en Viñetas</div>
</div>"""


def html_cifras(ed, esc=1.0, foto=None):
    d = ed.get("datos", ed)
    c, m, inf, ibc = d["cambiario"], d["mercados"], d["inflacion"], d["ibc"]

    def mk(k, unidad="", suf=""):
        x = m.get(k)
        if not x:
            return "s/d"
        v = num(x["valor"], 0 if x.get("dec") == 0 else 2)
        return (f"{unidad}{v}{suf} <span class='chico'>({pct(x.get('sem'))} sem · "
                f"{pct(x.get('ytd'))} año)</span>")

    pills = (
        f"<div class='pill' style='left:390px;width:455px'>"
        f"<div class='lb'>TASA DE CAMBIO<br><b>PARALELA</b></div>"
        f"<div class='vl'>Bs. {num(c['paralelo'])}</div></div>"
        f"<div class='pill' style='left:865px;width:455px'>"
        f"<div class='lb'>TASA DE CAMBIO<br><b>BCV</b></div>"
        f"<div class='vl'>Bs. {num(c['bcv'])}</div></div>"
    )
    tarjetas = [
        (325, "Devaluación<br>acumulada del año",
         [f"<b>{pct(c['devalYTD'])}</b> — la tasa BCV pasó de Bs. {num(c['baseAnual'])} "
          f"el 1 de enero a Bs. {num(c['bcv'])}"]),
        (241, "Inflación",
         [f"<b>IPC ({inf['mes']}):</b> {pct(inf['mensual'])} mensual",
          f"<b>Acumulada en el año:</b> {num(inf['acumulada'], 1)}%"]),
        (300, "Commodities",
         [f"<b>Petróleo Brent:</b> {mk('brent', 'US$ ', ' /barril')}",
          f"<b>Oro:</b> {mk('oro', 'US$ ', ' /onza')}"]),
        (255, "Criptoactivos",
         [f"<b>BTC:</b> {mk('btc', 'US$ ')}", f"<b>ETH:</b> {mk('eth', 'US$ ')}"]),
        (340, "Mercado bursátil",
         [f"<b>Dow Jones:</b> {mk('dow')}", f"<b>S&amp;P 500:</b> {mk('sp500')}",
          f"<b>Nasdaq:</b> {mk('nasdaq')}",
          f"<b>IBC Caracas:</b> {num(ibc['valor'])} <span class='chico'>"
          f"({pct(ibc['sem'])} sem · {pct(ibc['ytd'])} año)</span>"]),
    ]
    bloques = "".join(
        f"<div class='tarjeta' style='margin-left:{sa}px;width:{1414 - sa}px'>"
        f"<h3>{ti}</h3>{''.join(f'<div class=l>{l}</div>' for l in li)}</div>"
        for sa, ti, li in tarjetas
    )
    brecha = "s/d" if c["brecha"] is None else num(c["brecha"], 1) + "%"
    fechas = sorted(x["fecha"] for x in m.values() if x.get("fecha"))
    return f"""<!doctype html><meta charset="utf-8"><style>{css(CSS_CIFRAS)}</style>
<div class="page">
  {marca()}
  <div class="abs titulo" style="left:67px;top:200px;font-size:118px">ECONOMÍA EN<br>CIFRAS</div>
  <div class="abs card-dolar"><div class="et">DÓLAR</div>{pills}</div>
  <div class="abs brecha"><div class="lb">BRECHA SEMANAL</div><div class="vl">{brecha}</div></div>
  <div class="abs cards fit" style="transform:scale({esc:.4f})">{bloques}</div>
  <div class="abs pie">Cierres al {fecha_corta(fechas[-1] if fechas else '')} ·
     tasa BCV del {fecha_corta(c['fechaBcv'])} · {fecha_larga(d['hoy'])}</div>
</div>"""


# (nombre, funcion, selector a medir, alto disponible en px)
LAMINAS = [
    ("1-portada", html_portada, ".franja", 760),
    ("2-noticia", html_noticia, "#cuerpo", 980),
    ("3-cifras", html_cifras, ".cards", 1130),
    ("4-latam", html_latam, ".items", 1420),
]


# ------------------------------------------------------------------ salida

def altura_bloque(html_path, selector):
    """Pregunta a Chrome cuanto mide de verdad un bloque, para reescalarlo."""
    probe = html_path.with_name(html_path.stem + "-probe.html")
    probe.write_text(
        html_path.read_text(encoding="utf-8")
        + f"<script>document.body.setAttribute('data-h',"
          f"Math.ceil((document.querySelector('{selector}')||{{}}).scrollHeight||0));</script>",
        encoding="utf-8",
    )
    try:
        r = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--virtual-time-budget=2500",
             "--dump-dom", probe.as_uri()],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
        m = re.search(r'data-h="(\d+)"', r.stdout or "")
        return int(m.group(1)) if m else 0
    finally:
        probe.unlink(missing_ok=True)


def png(html_path, png_path):
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--window-size={W},{H}",
         f"--screenshot={png_path}", html_path.as_uri()],
        check=True, capture_output=True, timeout=180,
    )


def main():
    solo_html = "--html" in sys.argv
    if "--datos" in sys.argv:
        # utf-8-sig: PowerShell escribe BOM y json.loads lo rechaza.
        ed = json.loads(
            Path(sys.argv[sys.argv.index("--datos") + 1]).read_text(encoding="utf-8-sig")
        )
    else:
        ed = bajar_edicion()

    dest = OUT / ed.get("hoy", date.today().isoformat())
    dest.mkdir(parents=True, exist_ok=True)
    foto = bajar_foto((ed.get("portada") or {}).get("imagen"), dest)

    # La lamina de la noticia acomoda su bloque blanco entre la cabecera y el
    # cierre: ambas alturas dependen del texto, asi que se miden.
    for nombre, fn, selector, disponible in LAMINAS:
        html_path = dest / f"{nombre}.html"

        def escribir(e=1.0):
            html = fn(ed, e, foto)
            if nombre == "2-noticia":
                cab = altura_medida(dest, fn, ed, e, foto, "#cab")
                top_cuerpo = 118 + cab
                alto_cuerpo = min(disponible, 1930 - top_cuerpo - 260)
                html = (html.replace("__TOP_CUERPO__", str(top_cuerpo))
                            .replace("__TOP_CIERRE__", str(top_cuerpo + alto_cuerpo)))
                html = html.replace('id="cuerpo"', f'id="cuerpo" data-alto="{alto_cuerpo}"')
                html = html.replace(".cuerpo { left:0;", f".cuerpo {{ height:{alto_cuerpo}px; left:0;")
            html_path.write_text(html, encoding="utf-8")

        escribir()
        alto = altura_bloque(html_path, selector)
        if alto > disponible:
            e = disponible / alto
            escribir(e)
            print(f"     {nombre}: bloque {alto}px -> escala {e:.3f}")
        print("HTML", html_path.name)
        if not solo_html:
            png(html_path, dest / f"{nombre}.png")
            print("PNG ", (dest / f'{nombre}.png').name)


def altura_medida(dest, fn, ed, e, foto, selector):
    """Alto real de un bloque auxiliar (la cabecera de la lamina de noticia)."""
    tmp = dest / "_medir.html"
    html = fn(ed, e, foto).replace("__TOP_CUERPO__", "0").replace("__TOP_CIERRE__", "0")
    tmp.write_text(html, encoding="utf-8")
    try:
        return altura_bloque(tmp, selector)
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
