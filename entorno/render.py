# -*- coding: utf-8 -*-
"""
Entorno en Vinetas - genera las 8 laminas PNG (1414x2000, A4 vertical) del
newsletter semanal a partir de la edicion que arma el Worker.

Uso:
  py render.py                 -> baja la edicion del Worker y genera los PNG
  py render.py --forzar        -> igual, pero pide al Worker que la rearme
  py render.py --datos x.json  -> usa un JSON local (sin red)
  py render.py --html          -> solo HTML, para inspeccionar en el navegador

LA PLANTILLA ES EL CANVA "entorno en vinetas" (id DAHOniEgyiw), VERSION DE
SEPTIEMBRE DE 2026, Y NO SE REDISENA AQUI. El encargo del dueno fue literal:
"no quites nada, tu trabajo es anadir las fotos y la informacion, no cambiar la
plantilla". Asi que cada posicion, tamano, tipografia, color y opacidad de este
archivo esta copiada de la plantilla, no estimada:

  - la geometria sale de leer el diseno por la API de Canva (unidades de su
    lienzo, 1587,4 x 2245); cada pagina se maqueta en esas mismas unidades y se
    escala a 1414 px al final, para poder copiar los numeros tal cual;
  - las tipografias salen del PDF exportado, que incrusta el nombre real de
    cada fuente: Inter, Host Grotesk Light, Montserrat, IBM Plex Mono y Nourd
    Heavy (esta ultima no es libre; ver NUMEROS mas abajo);
  - la pila de papeles de la portada y el mapa de puntos de Latam son los de la
    plantilla, extraidos con fondo transparente. El mapa es un archivo propio
    (assets/mapa.png); la pila es stock de Canva y NO va en el repo: ver
    recurso_privado().

La referencia contra la que comparar se exporta de Canva a assets/referencia/
(fuera del repo por lo mismo: lleva las fotos de stock de ejemplo).

Lo unico que NO viene de la plantilla es lo que la plantilla deja en blanco o
con relleno de ejemplo: las fotos, los textos y las cifras de cada semana.

LAS LAMINAS CON TEXTO VARIABLE SE AUTOAJUSTAN: un guion en la pagina mide cada
caja y, si el texto no cabe, lo encoge. Sin eso, la semana que la IA escriba
largo la lamina se corta en silencio (trampa 6 del CLAUDE.md).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from datetime import date
from pathlib import Path

BASE = Path(__file__).parent
ASSETS = BASE / "assets"
OUT = BASE / "out"

W, H = 1414, 2000  # lienzo A4 vertical (ratio 0,707 de la plantilla)
# Unidades de Canva -> pixeles. La pagina de la plantilla mide 1587,4 x 2245.
CW, CH = 1587.4016, 2245.0
S = W / CW

# Donde van la pila y el mapa, medido en PIXELES sobre la exportacion de la
# plantilla al extraerlos (ver el docstring). Se convierten a unidades de Canva.
PILA = (388, 857, 698, 506)
MAPA = (0, 0, 527, 673)

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


def bajar_edicion(forzar=False):
    """Pide la edicion al Worker.

    EL TIMEOUT ES LARGO A PROPOSITO. Si el Worker no tiene la edicion en cache,
    la arma dentro de ESTA peticion, que es justo lo que se busca: una peticion
    HTTP no tiene el corte de ~30 s de ctx.waitUntil() mientras el cliente siga
    esperando. Con cuatro noticias y cinco fotos, armarla tarda mas que antes.
    """
    url = f"{WORKER}/entorno?key={leer_secreto()}&formato=json" + ("&force=1" if forzar else "")
    req = urllib.request.Request(url, headers={"User-Agent": "EntornoRender/2.0"})
    with urllib.request.urlopen(req, timeout=360) as r:
        return json.loads(r.read().decode("utf-8"))


def bajar_foto(url, dest, nombre):
    """Baja una imagen de la edicion. Si falla, la pagina sale sin foto: se
    degrada, no se rompe."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers=NAV_UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            datos = r.read()
        if len(datos) < 4000:
            return None
        # Chrome reconoce el formato por el contenido, no por la extension; la
        # extension es solo para quien abra la carpeta.
        ext = ".jpg" if datos[:2] == b"\xff\xd8" else (".webp" if datos[8:12] == b"WEBP" else ".png")
        p = dest / (nombre + ext)
        p.write_bytes(datos)
        print(f"     {nombre}: {len(datos)//1024} KB")
        return p
    except Exception as e:
        print(f"     {nombre}: sin foto ({e})")
        return None


def recurso_privado(nombre):
    """Un recurso de la plantilla que NO puede ir en el repositorio.

    El repo es publico (trampa 13 del CLAUDE.md: asi Actions sale gratis) y la
    pila de papeles de la portada es una foto de stock de Canva. Usarla dentro
    del diseno esta permitido; publicarla como archivo suelto, no. Asi que vive
    en el KV del Worker y se pide con la misma clave que la edicion. Se guarda
    en assets/privado/, que esta en .gitignore, para no pedirla cada vez.
    """
    ruta = ASSETS / "privado" / nombre
    if ruta.exists():
        return ruta
    url = f"{WORKER}/recurso?key={leer_secreto()}&nombre={nombre}"
    try:
        with urllib.request.urlopen(urllib.request.Request(
                url, headers={"User-Agent": "EntornoRender/2.0"}), timeout=60) as r:
            datos = r.read()
    except Exception as e:
        # Sin la pila la portada sale sin ella, no se cae: la foto de la noticia
        # principal sigue en su marco. Se avisa para que alguien la reponga.
        print(f"     aviso: no pude traer {nombre} del Worker ({e}); la portada sale sin la pila")
        return None
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_bytes(datos)
    return ruta


def edicion_normalizada(ed):
    """Las cuatro noticias y el bloque Latam, vengan en el formato que vengan.

    Una edicion guardada en KV antes de la plantilla de cuatro noticias trae una
    sola (NICHO / TITULAR / SUBTITULO / CUERPO). Se convierte en la noticia 1
    para que un render nuevo sobre una cache vieja no se caiga: sale con una
    noticia en vez de cuatro hasta que el lunes se arme la siguiente.
    """
    notas = list(ed.get("noticias") or [])
    s = ed.get("secciones") or {}
    if not notas and (s.get("TITULAR") or s.get("CUERPO")):
        ps = parrafos(s.get("CUERPO", ""))
        notas = [{
            "numero": 1,
            "tema": (s.get("NICHO") or "VENEZUELA").split("/")[0].strip(),
            "titulo": s.get("TITULAR", ""), "subtitulo": s.get("SUBTITULO", ""),
            "sumario": s.get("CONTRAPORTADA", ""),
            "cuerpo": "\n\n".join(ps[:2]), "lectura": " ".join(ps[2:3]),
            "texto2": "", "imagen": (ed.get("portada") or {}).get("imagen", ""),
        }]
    latam = ed.get("latam") or {}
    if not latam.get("items") and s.get("LATAM"):
        latam = {"items": [" ".join(x.strip().split("\n"))
                           for x in re.split(r"\n?-{3,}\n?", s["LATAM"]) if x.strip()][:4],
                 "imagen": ""}
    return notas[:4], latam


# ------------------------------------------------------------------ formato

def num(v, dec=2):
    if v is None:
        return "s/d"
    s = f"{abs(v):,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if v < 0 else "") + s


def pct(v, dec=1):
    if v is None:
        return "s/d"
    # Menos tipografico (−), como en la plantilla: el guion corto se lee como
    # separador y no como signo en una columna de cifras.
    return ("+" if v >= 0 else "−") + num(abs(v), dec) + "%"


def fecha_corta(iso):
    if not iso:
        return ""
    a, m, d = iso[:10].split("-")
    return f"{int(d)}-{MESES[int(m) - 1][:3]}"


def fecha_larga(iso):
    a, m, d = iso[:10].split("-")
    return f"{int(d)} de {MESES[int(m) - 1]} de {a}"


def esc(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def parrafos(txt):
    return [p.strip() for p in re.split(r"\n\s*\n", str(txt or "")) if p.strip()]


def uri(p):
    return p.as_uri() if p else ""


# ------------------------------------------------------------------ estilo

def fuentes_css():
    """Las @font-face de la plantilla, desde los archivos del repo.

    SE INCRUSTAN Y NO SE PIDEN A GOOGLE a proposito: el render corre en Actions
    y en local, y una lamina no puede salir con otra tipografia porque un dia
    fonts.googleapis.com tarde en contestar. La ficha (fonts/v2.json) conserva
    el unicode-range de cada archivo: sin el, el navegador baja el latin-ext
    para todo y las tildes salen de otro archivo.
    """
    reglas = []
    for f in json.loads((ASSETS / "fonts" / "v2.json").read_text(encoding="utf-8")):
        familia = {"HostGrotesk": "Host Grotesk", "IBMPlexMono": "IBM Plex Mono"}.get(
            f["familia"], f["familia"])
        reglas.append(
            "@font-face{font-family:'%s';font-style:%s;font-weight:%s;"
            "src:url('%s') format('woff2');unicode-range:%s}"
            % (familia, f["estilo"], f["peso"], (ASSETS / "fonts" / f["archivo"]).as_uri(), f["rango"]))
    # NUMEROS: los "8" de las tasas en la plantilla son Nourd Heavy, una fuente
    # de Canva que no se puede redistribuir. El sustituto es Archivo Black, que
    # ya estaba en el repo: pesada, geometrica y con cifras de ancho parejo.
    reglas.append("@font-face{font-family:'Archivo Black';font-weight:400;"
                  "src:url('%s') format('woff2')}" % (ASSETS / "fonts" / "ArchivoBlack-400.woff2").as_uri())
    return "\n".join(reglas)


CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:1414px; height:2000px; overflow:hidden; background:#000; }
.page { position:absolute; left:0; top:0; width:1587.4016px; height:2245px; overflow:hidden;
        transform:scale(__S__); transform-origin:0 0; color:#fff; }
.a { position:absolute; }
/* Inter tiene eje de tamano optico. La plantilla usa dos cortes: "Inter" (el de
   texto, opsz 14) en titulos y cuerpo, e "Inter 18pt" en el titular de la
   portada y en la lamina de cifras. Asi se distinguen, como en el PDF. */
.i   { font-family:'Inter',sans-serif; font-variation-settings:'opsz' 14; }
.i18 { font-family:'Inter',sans-serif; font-variation-settings:'opsz' 18; }
.hg  { font-family:'Host Grotesk',sans-serif; font-weight:300; }
.mo  { font-family:'Montserrat',sans-serif; }
.pm  { font-family:'IBM Plex Mono',monospace; }
.b { font-weight:700; }
.tt { font-weight:700; letter-spacing:-0.091em; line-height:0.98; }
.sub { text-decoration:underline; text-decoration-thickness:0.06em; text-underline-offset:0.08em; }
.just { text-align:justify; }
.una { white-space:nowrap; }
/* ALINEADO A LA DERECHA CON ESPACIADO NEGATIVO. CSS aplica letter-spacing
   tambien detras de la ultima letra; Canva no. Con -0.091em, un texto alineado a
   la derecha se salia ~16 unidades de su caja: medido en LATAM ENLATADA, que
   quedaba 20 a la derecha de la plantilla. El relleno lo devuelve a su sitio. */
.dcha { text-align:right; padding-right:0.091em; }
img.foto { object-fit:cover; display:block; }
"""

# Encoge cada [data-fit] hasta que quepa en su caja, en pasos de un 3 %.
#   data-fit="h:NNN"  alto maximo (texto que envuelve)
#   data-fit="w:NNN"  ancho maximo (una sola linea)
# Las medidas se toman en unidades de Canva: la pagina se escala con transform,
# que no altera el layout, asi que offsetWidth sigue en esas unidades.
# Deja en data-encogido la proporcion final, que render.py lee para avisar.
#
# ANTES DE ENCOGER, SE CORRIGE DONDE CAE LA PRIMERA LINEA, y esto no es un
# retoque a ojo. CSS reparte el interlineado mitad arriba y mitad abajo de cada
# linea, tambien de la primera; Canva pone la primera linea pegada al borde de
# la caja y usa el interlineado solo entre lineas. Con interlineado menor que
# el de la fuente, CSS sube todo el bloque. Medido el 24/09/2026 contra la
# exportacion de la plantilla, renglon a renglon: el paso entre lineas era
# identico, y el bloque subia 0,105 em con interlineado 0,98 y 0,199 em con
# 0,8. Las dos medidas cuadran con (1,194 - interlineado) / 2, donde 1,194 es
# el alto natural de Inter; cada familia tiene el suyo (ALTO_NATURAL).
#
# Va en em para que siga valiendo si luego el texto se encoge. Quedan fuera las
# cajas que centran su propio texto (display:flex: los LEER MAS y las tasas). Y
# el tema girado se mueve con translateY DESPUES del giro: en esa caja "abajo"
# es "a la derecha".
AJUSTE = """<script>
var ALTO_NATURAL = {'Inter': 1.194, 'Montserrat': 1.219, 'Host Grotesk': 1.2,
                    'IBM Plex Mono': 1.3, 'Archivo Black': 1.2};
document.fonts.ready.then(function () {
  document.querySelectorAll('.page .a').forEach(function (el) {
    if (/^(IMG|svg)$/i.test(el.tagName) || !el.textContent.trim()) return;
    var cs = getComputedStyle(el);
    if (cs.display === 'flex') return;
    var fs = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight) / fs;
    if (!isFinite(lh)) return;
    var fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    var d = ((ALTO_NATURAL[fam] || 1.2) - lh) / 2;
    if (el.classList.contains('girado')) el.style.transform = 'rotate(-90deg) translateY(' + d.toFixed(4) + 'em)';
    else el.style.marginTop = d.toFixed(4) + 'em';
  });
  document.querySelectorAll('[data-fit]').forEach(function (el) {
    var p = el.dataset.fit.split(':'), modo = p[0], max = parseFloat(p[1]);
    var base = parseFloat(getComputedStyle(el).fontSize), fs = base, n = 0;
    var mide = function () { return modo === 'w' ? el.scrollWidth : el.scrollHeight; };
    while (mide() > max + 0.5 && fs > base * 0.5 && n < 80) {
      fs *= 0.97; el.style.fontSize = fs + 'px'; n++;
    }
    if (n) el.setAttribute('data-encogido', (fs / base).toFixed(2));
  });
  document.body.setAttribute('data-listo', '1');
});
</script>"""


def pagina(cuerpo, fondo="#000"):
    return ("<!doctype html><html><head><meta charset='utf-8'><style>"
            + fuentes_css() + CSS.replace("__S__", "%.6f" % S)
            + "</style></head><body><div class='page' style='background:%s'>" % fondo
            + cuerpo + "</div>" + AJUSTE + "</body></html>")


def caja(left, top, w=None, h=None, extra=""):
    s = "left:%.2fpx;top:%.2fpx;" % (left, top)
    if w is not None:
        s += "width:%.2fpx;" % w
    if h is not None:
        s += "height:%.2fpx;" % h
    return s + extra


def en_unidades(px):
    return tuple(v / S for v in px)


def lineas_dobles():
    """La franja de dos lineas blancas de arriba (portada y noticias)."""
    return "<div class='a' style='%s'></div>" % caja(
        -112.18, 82.30, 1793.90, 85.92, "border:3px solid #fff;")


def foto_o_mapa(foto, left, top, w, h, opacidad=1.0):
    """La foto de una pagina, o el mapa de puntos de la plantilla si no hay.

    SIN FOTO NO SE PONE LA DE OTRA NOTICIA. Queda un cuadro negro con el mapa de
    la propia plantilla: se lee como un recurso grafico del newsletter y no como
    un hueco, y no le cuelga a una noticia la imagen de otra.
    """
    if foto:
        return "<img class='a foto' src='%s' style='%s'>" % (
            uri(foto), caja(left, top, w, h, "opacity:%.2f;" % opacidad))
    mx, my, mw, mh = en_unidades(MAPA)
    # Se centra en la parte VISIBLE de la caja: la de la foto de Latam desborda
    # la pagina por la derecha (asi esta en la plantilla) y la de las noticias
    # por la izquierda, y centrado en la caja entera el mapa salia cortado.
    x0, x1 = max(left, 0), min(left + w, CW)
    y0, y1 = max(top, 0), min(top + h, CH)
    vw, vh = x1 - x0, y1 - y0
    esc_m = min(vw / mw, vh / mh) * 0.8
    return ("<div class='a' style='%s'><img src='%s' style='position:absolute;"
            "left:%.2fpx;top:%.2fpx;width:%.2fpx;opacity:0.55'></div>") % (
        caja(left, top, w, h, "background:#000;overflow:hidden;"), uri(ASSETS / "mapa.png"),
        (x0 - left) + (vw - mw * esc_m) / 2, (y0 - top) + (vh - mh * esc_m) / 2, mw * esc_m)


# ------------------------------------------------------------------ laminas

# El marco de la foto de la portada: el trazo de papel rasgado de la plantilla,
# copiado tal cual de su SVG (viewBox 1023,224 x 727,632).
MARCO = ("M743.42 0C681.29.01 617.1.23 562.36.84 393.42 2.73 155.78 8.41 79.51 10.93S.72 15.97.72 "
         "15.97C.19 22.76.01 37.06 0 56.37v2.78c.02 50.86 1.17 134.06.72 207.07C.09 368.96.72 706.2.72 "
         "706.2l.11 17.02v4.41H190.45c47.27 0 567.94-3.78 567.94-3.78s96.43 2.42 161.46 2.42c16.25 0 "
         "30.54-.15 40.88-.53 51.69-1.89 61.77-3.15 62.4-5.67.06-.23.08-1.11.08-2.62 0-15.28-2.66-94.73"
         "-3.23-206.03-.63-122.29-3.78-283.66-5.04-356.78s-1.89-144.98-4.41-150.02c-1.68-3.36-1.12-3.92"
         "-3.55-3.92-1.21 0-3.17.14-6.54.14C993.82.84 879.64.02 754.2 0Z")


def html_portada(ed, fotos, notas, latam):
    n = notas[0] if notas else {}
    foto = fotos.get("n1")
    anio, mes, dia = ed["hoy"][:10].split("-")  # la plantilla usa DD/MM/AA
    px, py, pw, ph = en_unidades(PILA)
    partes = []
    if foto:
        # La plantilla deja la foto de fondo casi negra: medida sobre su
        # exportacion, una luminancia media de 12 a 14 sobre 255. Una foto de
        # prensa normal ronda 110, de ahi el 0,13.
        partes.append("<img class='a foto' src='%s' style='%s'>" % (
            uri(foto), caja(0, 0, CW, CH, "filter:brightness(0.13);")))
    partes.append(lineas_dobles())
    partes.append("<div class='a' style='%s'></div>" % caja(
        178.44, 297.70, 297.73, 75.97, "border:4px solid #fff;border-radius:38px;"))
    partes.append("<div class='a hg' style='%s'>%s/%s/%s</div>" % (caja(
        194.72, 310.43, 265.16, None,
        "font-size:42.57px;line-height:0.96;letter-spacing:0.072em;text-align:center;"),
        dia, mes, anio[2:]))
    partes.append("<div class='a i tt' style='%s'>Entorno en Viñetas</div>" % caja(
        158.74, 386.95, 1040.55, None, "font-size:191.76px;"))
    pila = recurso_privado("pila.png")
    if pila:
        partes.append("<img class='a' src='%s' style='%s'>" % (uri(pila), caja(px, py, pw, ph)))
    if foto:
        partes.append(
            "<svg class='a' style='%s' viewBox='0 0 1023.224 727.632'>"
            "<defs><clipPath id='marco'><path d='%s'/></clipPath></defs>"
            "<image href='%s' x='0' y='0' width='1023.224' height='727.632' "
            "preserveAspectRatio='xMidYMid slice' clip-path='url(#marco)'/></svg>"
            % (caja(551.57, 1027.83, 562.42, 399.94, "opacity:0.9;"), MARCO, uri(foto)))
    partes.append("<div class='a' style='%s'></div>" % caja(0, 1712.94, 1652.75, 532.10, "background:#000;"))
    partes.append("<div class='a hg' style='%s'>Resumen semanal</div>" % caja(
        158.74, 1796.96, None, None, "font-size:51.90px;line-height:0.96;letter-spacing:0.072em;"))
    # El titular es de una linea en la plantilla (caja de 120 de alto, con el
    # sumario pegado debajo). Si no cabe, se encoge en vez de saltar de linea.
    partes.append("<div class='a i18 una' data-fit='w:1270' style='%s'>%s</div>" % (caja(
        158.74, 1858.42, None, None,
        "font-size:100.64px;font-weight:700;line-height:1.23;letter-spacing:-0.064em;"),
        esc(n.get("titulo", ""))))
    partes.append("<div class='a hg' data-fit='h:200' style='%s'>%s</div>" % (caja(
        158.74, 1978.99, 1270, None, "font-size:51.90px;line-height:0.96;letter-spacing:0.072em;"),
        esc(n.get("sumario", ""))))
    return pagina("".join(partes))


# Las cuatro franjas del indice, tal cual la plantilla: la foto de cada una va
# sobre negro con SU opacidad (0,33 / 0,25 / 0,14 / 0,20) y con su propia caja,
# que desborda un poco la franja. No se igualan: el diseno las tiene distintas.
FRANJAS = [
    # (top franja, foto: left, top, w, h, opacidad)
    (0.00,    (-16.20,  -17.54,  1619.79, 578.80, 0.33)),
    (561.26,  (0.00,    552.49,  1619.79, 570.03, 0.25)),
    (1122.52, (-13.45,  1122.52, 1619.79, 570.03, 0.14)),
    (1683.78, (-26.89,  1692.55, 1619.79, 560.15, 0.20)),
]


def html_indice(ed, fotos, notas, latam):
    partes = []
    # Mismo orden de capas que en Canva: la franja negra k+1 tapa lo que la foto
    # k desborda por abajo.
    for k, (top, (fl, ft, fw, fh, op)) in enumerate(FRANJAS):
        partes.append("<div class='a' style='%s'></div>" % caja(0, top, 1587.40, 561.26, "background:#000;"))
    for k, (top, (fl, ft, fw, fh, op)) in enumerate(FRANJAS):
        f = fotos.get("n%d" % (k + 1))
        if f and k < len(notas):
            partes.append("<img class='a foto' src='%s' style='%s'>" % (
                uri(f), caja(fl, ft, fw, fh, "opacity:%.2f;" % op)))
        if k < len(notas):
            partes.append(
                "<div class='a mo' style='%s'>LEER MAS</div>" % caja(
                    1007.72, 351.72 + k * 561.26, 476.22, 111.40,
                    "border:1px solid #fff;border-radius:56px;display:flex;align-items:center;"
                    "justify-content:center;font-size:38.36px;line-height:1.4;letter-spacing:0.009em;"))
    for k, n in enumerate(notas):
        # Una linea, como en la plantilla. Puede crecer a la derecha hasta el
        # ancho de la columna del sumario (1322) antes de encogerse: la caja de
        # 778 de Canva es la que ocupaba "NOTICIA 1 TITULAR" y nada mas.
        partes.append("<div class='a i tt sub una' data-fit='w:1322' style='%s'>%s</div>" % (caja(
            77.71, 66.25 + k * 561.26, None, None, "font-size:93.35px;"), esc(n.get("titulo", ""))))
        partes.append("<div class='a mo just' data-fit='h:125' style='%s'>%s</div>" % (caja(
            77.71, 208.26 + k * 561.26, 1322.31, None,
            "font-size:38.36px;line-height:1.4;letter-spacing:0.009em;"), esc(n.get("sumario", ""))))
    return pagina("".join(partes), fondo="#fff")


def html_noticia(ed, fotos, notas, latam, k):
    n = notas[k]
    ps = parrafos(n.get("cuerpo", ""))
    cuerpo = "".join("<p style='margin-bottom:%s'>%s</p>" % ("0" if i == len(ps) - 1 else "1.4em", esc(p))
                     for i, p in enumerate(ps))
    partes = [
        "<div class='a' style='%s'></div>" % caja(-97.42, -54.62, 1782.23, 615.07, "background:#000;"),
        lineas_dobles(),
        foto_o_mapa(fotos.get("n%d" % (k + 1)), -112.18, 619.44, 809.57, 809.57),
        "<div class='a' style='%s'></div>" % caja(-28.36, 1488.02, 1870.08, 858.39, "background:#000;"),
        "<div class='a i just' data-fit='h:843' style='%s'>%s</div>" % (caja(
            747.89, 624.24, 727.61, None, "font-size:32.43px;line-height:1.4;color:#000;"), cuerpo),
        "<div class='a i just' data-fit='h:206' style='%s'>▪ %s</div>" % (caja(
            116.50, 1531.92, 1331.76, None, "font-size:32.43px;line-height:1.4;"), esc(n.get("lectura", ""))),
        "<div class='a i just' data-fit='h:215' style='%s'>%s</div>" % (caja(
            123.77, 1995.05, 1324.49, None, "font-size:32.43px;line-height:1.4;"), esc(n.get("texto2", ""))),
        "<div class='a mo' style='%s'>SURECONOMICS</div>" % caja(
            1136.63, 106.46, 380.94, None, "font-size:33.33px;line-height:1.4;text-align:right;"),
        "<div class='a i tt' data-fit='h:290' style='%s'>%s</div>" % (caja(
            179.73, 252.91, 609.92, None, "font-size:121.64px;"), esc(n.get("titulo", ""))),
        # El tema va girado -90 grados sobre el centro de su caja, como en Canva:
        # alineado al principio, que girado queda abajo.
        "<div class='a i tt una girado' data-fit='w:267' style='%s'>%s</div>" % (caja(
            -16.76, 333.08, 266.52, 54.46,
            "font-size:46.16px;line-height:0.8;transform:rotate(-90deg);"), esc(n.get("tema", ""))),
        "<div class='a i tt sub' data-fit='h:200' style='%s'>%s</div>" % (caja(
            116.50, 1758.42, 972.88, None, "font-size:93.35px;"), esc(n.get("subtitulo", ""))),
        "<div class='a i tt sub' data-fit='h:170' style='%s'>%s</div>" % (caja(
            926.59, 379.66, 660.81, None, "font-size:63.40px;"), esc(n.get("subtitulo", ""))),
        "<div class='a i tt dcha' style='%s'>(%02d)</div>" % (caja(
            616.50, 203.37, 168.26, None,
            "font-size:73.07px;line-height:0.8;color:#ec2736;"), k + 1),
    ]
    return pagina("".join(partes), fondo="#fff")


def linea(x0, x1, y):
    """Linea de 6 de grosor centrada en y, como las de la plantilla."""
    return "<div class='a' style='%s'></div>" % caja(x0, y - 3, x1 - x0, 6, "background:#fff;")


def vertical(x, y0, y1):
    return "<div class='a' style='%s'></div>" % caja(x - 3, y0, 6, y1 - y0, "background:#fff;")


def html_cifras(ed, fotos, notas, latam):
    d = ed.get("datos", ed)
    c, m, inf, ibc = d["cambiario"], d["mercados"], d["inflacion"], d["ibc"]

    def val(k, dec=None):
        x = m.get(k) or {}
        if x.get("valor") is None:
            return "s/d"
        return num(x["valor"], dec if dec is not None else (0 if x.get("dec") == 0 else 2))

    def sem(k):
        x = m.get(k) or {}
        return pct(x.get("sem"), 2) if x.get("sem") is not None else "s/d"

    fechas = sorted(x["fecha"] for x in m.values() if isinstance(x, dict) and x.get("fecha"))
    cierre = fecha_corta(fechas[-1]) if fechas else ""
    brecha = "s/d" if c.get("brecha") is None else num(c["brecha"], 2) + "%"
    dolariz = d.get("dolarizacion") or {}
    dolariz_txt = (num(dolariz["valor"], 0) + "%") if dolariz.get("valor") is not None else "s/d"

    et = "font-size:31.45px;line-height:0.96;letter-spacing:0.072em;color:#000;"
    # NUMEROS: la plantilla trae un "8" de relleno en cada pildora. Las tasas de
    # verdad tienen seis cifras ("954,01"), y en el hueco que deja la etiqueta
    # caben unas 190 unidades: se encogen hasta caber, con la tipografia y la
    # posicion de la plantilla.
    # Sin comillas en el nombre: van dentro de un atributo style='...' y una
    # comilla simple lo cerraria, perdiendo el resto del estilo. Paso el 24/09/2026:
    # las dos tasas desaparecieron de la lamina sin ningun error.
    tasa = ("font-family:Archivo Black,sans-serif;font-size:91.39px;line-height:0.97;color:#000;")
    partes = [
        linea(87.86, 972.45, 1369.90), linea(91.35, 975.94, 961.20), linea(87.86, 975.94, 1970.27),
        linea(969.13, 1473.37, 838.21), linea(968.95, 1473.19, 1467.64), linea(968.95, 1473.19, 577.25),
        vertical(972.45, 165.27, 2128.47), linea(87.86, 1468.25, 2131.99), linea(87.86, 1468.25, 161.74),
        vertical(87.86, 161.74, 2129.44), vertical(1469.70, 161.74, 2129.44), linea(81.53, 966.12, 658.12),
        "<div class='a pm' data-fit='h:100' style='%s'>Fuente: BCV · ve.dolarapi.com (tasas) · Bolsa de "
        "Valores de Caracas (IBC) · Yahoo Finance (índices, commodities, cripto) | %s</div>" % (caja(
            153.96, 2025.34, 741.07, None, "font-size:20.46px;line-height:1.4;"), fecha_larga(d["hoy"])),
        "<div class='a i tt' style='%s'>ECONOMÍA<br>EN<br>CIFRAS</div>" % caja(
            142.75, 212.67, 763.49, None, "font-size:125.39px;"),
        "<div class='a i18 b' style='%s'>DÓLAR</div>" % caja(
            998.66, 279.52, None, None, "font-size:73.02px;line-height:1.35;"),
        "<div class='a' style='%s'></div>" % caja(995.55, 387.09, 449.73, 154.73, "background:#fff;border-radius:22px;"),
        "<div class='a i18' style='%s'>TASA DE<br>CAMBIO<br><b>PARALELA</b></div>" % caja(1032.43, 415.84, 281.63, None, et),
        "<div class='a una' data-fit='w:175' data-sin-aviso='1' style='%s'>%s</div>" % (caja(
            1254.22, 410.13, None, 108.64, tasa + "display:flex;align-items:center;"), num(c.get("paralelo"))),
        "<div class='a' style='%s'></div>" % caja(996.87, 608.18, 448.41, 154.73, "background:#fff;border-radius:22px;"),
        "<div class='a i18' style='%s'>TASA DE<br>CAMBIO<br><b>BCV</b></div>" % caja(1040.70, 635.59, 281.63, None, et),
        "<div class='a una' data-fit='w:175' data-sin-aviso='1' style='%s'>%s</div>" % (caja(
            1254.22, 629.89, None, 108.64, tasa + "display:flex;align-items:center;"), num(c.get("bcv"))),
        "<div class='a' style='%s'></div>" % caja(968.03, 801.08, 1618.84, 44.08, "background:#e8524c;"),
        "<div class='a mo' style='%s'>BRECHA SEMANAL</div>" % caja(
            998.66, 802.77, None, None, "font-size:35.42px;line-height:1.4;letter-spacing:0.009em;"),
        "<div class='a i18' style='%s'>%s</div>" % (caja(
            1355.58, 798.82, 176.74, None,
            "font-size:40.50px;font-style:italic;line-height:1.4;letter-spacing:0.072em;text-align:center;"), brecha),
        "<div class='a i18 b' style='%s'>Devaluación acumulada del año</div>" % caja(
            1008.83, 911.33, 436.45, None, "font-size:54.90px;line-height:0.85;color:#e8524c;"),
        "<div class='a i18 b una' data-fit='w:440' style='%s'>%s</div>" % (caja(
            1008.83, 1090.33, None, None, "font-size:109.29px;line-height:0.85;"),
            ("s/d" if c.get("devalYTD") is None else num(c["devalYTD"], 1) + "%")),
        "<div class='a mo' style='%s'>Extensión de dolarización informal: <span style='font-weight:500'>%s</span></div>" % (caja(
            1008.83, 1241.53, 408.46, None, "font-size:32.00px;line-height:1.4;letter-spacing:0.009em;"), dolariz_txt),
        "<div class='a i18 b' style='%s'>Inflación</div>" % caja(
            1013.08, 1538.77, None, None, "font-size:54.90px;line-height:0.85;color:#e8524c;"),
        "<div class='a mo just' data-fit='h:330' style='%s'><span style='font-weight:500'>IPC (%s):</span> "
        "%s mensual<br><span style='font-weight:500'>Inflación acumulada en el año:</span> %s</div>" % (caja(
            1020.90, 1632.21, 349.46, None, "font-size:35.42px;line-height:1.4;letter-spacing:0.009em;"),
            esc(inf.get("mes", "")), pct(inf.get("mensual")),
            ("s/d" if inf.get("acumulada") is None else num(inf["acumulada"], 1) + "%")),
        "<div class='a i18 b' style='%s'>Commodities</div>" % caja(
            136.63, 708.32, 876.46, None, "font-size:76.00px;line-height:1.35;"),
        "<div class='a mo just' style='%s'>Petróleo Brent: $%s por barril<br>Oro: $%s por onza (%s)</div>" % (caja(
            136.63, 817.71, 720, None, "font-size:33.78px;line-height:1.4;letter-spacing:0.009em;"),
            val("brent"), val("oro"), fecha_corta((m.get("oro") or {}).get("fecha", ""))),
        "<div class='a i18 b' style='%s'>Criptoactivos (al %s)</div>" % (caja(
            136.63, 1014.58, 724.64, None, "font-size:76.00px;line-height:1.09;"),
            fecha_corta((m.get("btc") or {}).get("fecha", ""))),
        "<div class='a mo just' style='%s'>BTC: $%s<br>ETH: $%s</div>" % (caja(
            136.63, 1219.83, 720, None, "font-size:33.78px;line-height:1.4;letter-spacing:0.009em;"),
            val("btc", 2), val("eth", 2)),
        "<div class='a i18 b' style='%s'>Mercado Bursátil</div>" % caja(
            136.63, 1431.75, 724.64, None, "font-size:76.00px;line-height:1.35;"),
        "<div class='a i18' style='%s'>(cierre %s)</div>" % (caja(
            136.63, 1522.25, None, None, "font-size:43.97px;line-height:1.4;letter-spacing:0.009em;"), cierre),
        "<div class='a mo just' data-fit='h:355' style='%s'>Dow Jones: %s (%s sem.)<br>S&amp;P 500: %s (%s sem.)"
        "<br>NASDAQ: %s (%s sem.)<br>Bolsa de Valores de Caracas -IBC: %s (%s sem.; %s en el año)</div>" % (caja(
            136.63, 1603.23, 780, None, "font-size:33.78px;line-height:1.4;letter-spacing:0.009em;"),
            val("dow"), sem("dow"), val("sp500"), sem("sp500"), val("nasdaq"), sem("nasdaq"),
            num(ibc.get("valor")), pct(ibc.get("sem"), 2), pct(ibc.get("ytd"), 0)),
    ]
    return pagina("".join(partes))


def html_latam(ed, fotos, notas, latam):
    mx, my, mw, mh = en_unidades(MAPA)
    items = latam.get("items") or []
    lista = "".join("<li style='margin-bottom:%s'>%s</li>" % ("0" if i == len(items) - 1 else "1.19em", esc(x))
                    for i, x in enumerate(items))
    partes = [
        "<img class='a' src='%s' style='%s'>" % (uri(ASSETS / "mapa.png"), caja(mx, my, mw, mh)),
    ]
    # Sin foto, el mapa de la plantilla en su hueco (ver foto_o_mapa). Aqui pasa
    # casi todas las semanas: los titulares de Latam llegan del feed de Google
    # News, sin enlace directo al medio, y sin enlace directo no hay foto.
    partes.append(foto_o_mapa(fotos.get("latam"), 970.22, 879.81, 809.57, 1206.49))
    partes += [
        "<div class='a i tt dcha' style='%s'>LATAM<br>ENLATADA</div>" % caja(
            566.86, 394.08, 934.35, None, "font-size:180.75px;line-height:0.8;color:#ec2736;"),
        "<div class='a i tt dcha' style='%s'>(04)</div>" % caja(
            1314.69, 334.35, 160.19, None, "font-size:69.56px;line-height:0.8;color:#ec2736;"),
        "<ul class='a i just' data-fit='h:1161' style='%s'>%s</ul>" % (caja(
            80.29, 879.81, 754.05, None,
            "font-size:36.40px;line-height:1.19;padding-left:1.1em;list-style:disc;"), lista),
    ]
    return pagina("".join(partes))


def laminas(notas):
    """(nombre, funcion) de cada lamina, en el orden del album.

    Las de noticia son tantas como noticias traiga la edicion: una cache vieja
    trae una sola, y una pagina de noticia vacia seria la plantilla sin rellenar.
    """
    out = [("1-portada", html_portada), ("2-indice", html_indice)]
    for k in range(len(notas)):
        out.append(("%d-noticia-%d" % (3 + k, k + 1),
                    (lambda kk: lambda ed, f, n, l: html_noticia(ed, f, n, l, kk))(k)))
    out += [("%d-cifras" % (3 + len(notas)), html_cifras), ("%d-latam" % (4 + len(notas)), html_latam)]
    return out


# ------------------------------------------------------------------ salida

def chrome(args, timeout=180):
    """Chrome sin cabeza con un perfil propio.

    EL PERFIL PROPIO NO ES OPCIONAL en Windows: sin el, Chrome se cuelga si hay
    una ventana abierta con el perfil del usuario. Costo una tarde en el mapa de
    activos petroleros y esta apuntado tambien en plantillas/post.py del medio.
    """
    perfil = tempfile.mkdtemp(prefix="entorno-")
    try:
        return subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--user-data-dir=%s" % perfil, "--allow-file-access-from-files",
             # Da tiempo a las tipografias y al guion de autoajuste.
             "--virtual-time-budget=8000"] + args,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    finally:
        shutil.rmtree(perfil, ignore_errors=True)


def avisar_encogidos(nombre, html_path):
    """Dice que textos no cupieron. Sin esto, una semana que la IA escriba largo
    sale con letra a la mitad y nadie sabe por que."""
    r = chrome(["--dump-dom", html_path.as_uri()])
    for m in re.finditer(r'<[^>]*data-encogido="([\d.]+)"[^>]*>([^<]{0,50})', r.stdout or ""):
        if "data-sin-aviso" in m.group(0):
            continue
        factor = float(m.group(1))
        if factor < 0.9:
            print(f"     aviso {nombre}: texto encogido al {factor:.0%}: «{m.group(2).strip()}…»")


def png(html_path, png_path):
    chrome(["--hide-scrollbars", "--force-device-scale-factor=1", f"--window-size={W},{H}",
            f"--screenshot={png_path}", html_path.as_uri()])


def main():
    solo_html = "--html" in sys.argv
    if "--datos" in sys.argv:
        # utf-8-sig: PowerShell escribe BOM y json.loads lo rechaza.
        ed = json.loads(
            Path(sys.argv[sys.argv.index("--datos") + 1]).read_text(encoding="utf-8-sig")
        )
    else:
        ed = bajar_edicion(forzar="--forzar" in sys.argv)

    dest = OUT / ed.get("hoy", date.today().isoformat())
    if dest.exists():
        # Una edicion anterior del mismo dia pudo dejar laminas con otros
        # nombres (la plantilla vieja tenia cuatro); send_telegram.py manda lo
        # que haya en la carpeta y no puede mezclar las dos.
        for p in dest.glob("*.png"):
            p.unlink()
    dest.mkdir(parents=True, exist_ok=True)
    # La edicion se guarda junto a las laminas: send_telegram.py la necesita
    # para mandar el texto cuando se armo en frio, y sirve para depurar.
    (dest / "edicion.json").write_text(json.dumps(ed, ensure_ascii=False, indent=1), encoding="utf-8")

    notas, latam = edicion_normalizada(ed)
    print(f"{len(notas)} noticias · Latam con {len(latam.get('items') or [])} párrafos")
    fotos = {}
    for k, n in enumerate(notas):
        fotos["n%d" % (k + 1)] = bajar_foto(n.get("imagen"), dest, "foto-n%d" % (k + 1))
    fotos["latam"] = bajar_foto(latam.get("imagen"), dest, "foto-latam")

    for nombre, fn in laminas(notas):
        html_path = dest / f"{nombre}.html"
        html_path.write_text(fn(ed, fotos, notas, latam), encoding="utf-8")
        avisar_encogidos(nombre, html_path)
        print("HTML", html_path.name)
        if not solo_html:
            png(html_path, dest / f"{nombre}.png")
            print("PNG ", f"{nombre}.png")


if __name__ == "__main__":
    main()
