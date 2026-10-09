# -*- coding: utf-8 -*-
"""
Entorno en Vinetas - genera las 8 laminas PNG (1414x2000, A4 vertical) del
newsletter semanal a partir de la edicion que arma el Worker.

Uso:
  py render.py                 -> baja la edicion del Worker y genera los PNG
  py render.py --forzar        -> igual, pero pide al Worker que la rearme
  py render.py --datos x.json  -> usa un JSON local (sin red)
  py render.py --html          -> solo HTML, para inspeccionar en el navegador

LA PLANTILLA ES EL CANVA "Entorno en vinetas (propuesta paleta 2)" (id
DAHWrdKhQZs), LA VERDE DE OCTUBRE DE 2026, Y NO SE REDISENA AQUI. El contenido
lo dicta la "guia maestra de contenido" del equipo de comunicacion (ver el
CLAUDE.md del repo). El encargo del dueno fue literal:
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
import urllib.error
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
PILA = (388, 814, 698, 506)  # 43 px mas arriba que en septiembre (medido el 08/10/2026)
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


def resolver_google_news(url):
    """El articulo real detras de un enlace de Google News, o "".

    Esos enlaces son un redirector que solo salta con JavaScript: pedirlos da
    una pagina de Google sin foto. Pero la propia pagina trae una firma
    (data-n-a-sg) y una marca de tiempo (data-n-a-ts) con las que su endpoint
    interno batchexecute devuelve la direccion del articulo. Probado el
    25/09/2026 con los tres enlaces de Google de la edicion: los tres se
    resolvieron (France 24, Univision, Hartford Courant).

    ES UN ENDPOINT INTERNO DE GOOGLE, NO UNA API. Puede cambiar sin aviso; si
    deja de funcionar, esto devuelve "" y la pagina cae al siguiente escalon
    (ver completar_fotos), no se rompe. Se usa SOLO para sacar la foto: el
    texto de las noticias sigue saliendo de lo que ya leyo el Worker.
    """
    if "news.google." not in (url or ""):
        return url or ""
    import urllib.parse
    try:
        ident = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
        # Google corta con 429 si se le piden muchas seguidas (paso el 09/10/2026
        # probando desde una sola IP): una pausa y un reintento.
        for intento in range(2):
            try:
                html = urllib.request.urlopen(urllib.request.Request(
                    "https://news.google.com/articles/%s" % ident, headers=NAV_UA), timeout=20).read().decode("utf-8", "replace")
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or intento:
                    raise
                import time
                time.sleep(20)
        sg = re.search(r'data-n-a-sg="([^"]+)"', html)
        ts = re.search(r'data-n-a-ts="([^"]+)"', html)
        if not (sg and ts):
            return ""
        carga = ('["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],'
                 '"X","X",1,[1,1,1],1,1,null,0,0,null,0],"%s",%s,"%s"]') % (ident, ts.group(1), sg.group(1))
        cuerpo = urllib.parse.urlencode({"f.req": json.dumps([[["Fbv4je", carga, None, "generic"]]])}).encode()
        r = urllib.request.urlopen(urllib.request.Request(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute", data=cuerpo,
            headers=dict(NAV_UA, **{"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})), timeout=20)
        m = re.search(r'\\"garturlres\\",\\"(https?://[^\\"]+)', r.read().decode("utf-8", "replace"))
        return m.group(1) if m else ""
    except Exception:
        return ""


def palabras(t):
    """Las palabras con peso de un titular. Es la misma medida que usa el Worker
    (palabrasTitular) para decidir si dos titulares cuentan lo mismo."""
    import unicodedata
    t = unicodedata.normalize("NFD", str(t or "").lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return {w for w in re.sub(r"[^a-z0-9 ]", " ", t).split() if len(w) > 3 and w not in VACIAS}


# Palabras de mas de tres letras que no dicen de que va un titular. Sin esto,
# «Dialogo SOBRE deuda» y «Marco Rubio SOBRE Venezuela» sumaban un punto.
VACIAS = {"sobre", "para", "como", "desde", "entre", "hasta", "tras", "segun", "este", "esta",
          "estos", "estas", "tiene", "hace", "dice", "donde", "cuando", "porque", "pero", "todo",
          "todos", "mientras", "nuevo", "nueva", "ante", "contra", "durante"}


def og_imagen(url):
    """El og:image de un articulo, pedido desde AQUI y no desde el Worker.

    HAY MEDIOS QUE LE CIERRAN LA PUERTA A CLOUDFLARE. El 24/09/2026 la noticia
    principal salio sin foto con una fuente de enlace directo (Efecto Cocuyo):
    desde el Worker no hubo og:image y desde fuera estaba en el byte 3.544 del
    HTML. Es lo mismo que le pasa a Groq con las IP de centros de datos. El
    render corre en GitHub, desde otra red, asi que reintenta lo que el Worker
    no consiguio. Un redirector de Google News se resuelve antes al articulo
    (resolver_google_news): el redirector en si no tiene foto.
    """
    url = resolver_google_news(url)
    if not url:
        return ""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=NAV_UA), timeout=25) as r:
            html = r.read(150000).decode("utf-8", "replace")
    except Exception:
        return ""
    for patron in (r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
                   r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image',
                   r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)'):
        m = re.search(patron, html, re.I)
        if m and m.group(1).startswith("http"):
            return m.group(1).replace("&amp;", "&")
    return ""


def completar_fotos(notas, latam, titulares):
    """Busca foto para cada noticia que llego sin ella. Tres escalones.

    TODA NOTICIA LLEVA IMAGEN: lo exigio Edicion el 25/09/2026, viendo paginas
    con el mapa solo y franjas del indice en negro. Por orden:

      1. la del propio articulo, pedida desde aqui (hay medios que le cierran la
         puerta a Cloudflare) y resolviendo antes el enlace de Google News;
      2. la del MISMO HECHO en otro medio: un titular de la edicion que se le
         parezca (tres palabras con peso en comun), porque hay medios que no
         dejan leer su pagina a nadie (France 24 da 403);
      3. y si no, el hueco queda con el mapa de la plantilla y lo denuncia el
         pinta oscurecida y con el mapa encima (ver foto_o_mapa).
    """
    for n in notas:
        if n.get("imagen"):
            continue
        n["imagen"] = og_imagen(n.get("url", ""))
        if n["imagen"]:
            print(f"     foto de la noticia {n.get('numero')}: recuperada de su propio artículo")
            continue
        ref = palabras(" ".join([n.get("fuenteTitulo", ""), n.get("titulo", ""), n.get("sumario", "")]))
        parecidos = sorted(((len(ref & palabras(t.get("t"))), t) for t in titulares
                            if t.get("l") and t.get("l") != n.get("url")), key=lambda x: -x[0])
        for comunes, t in parecidos[:4]:
            if comunes < 3:
                break
            n["imagen"] = og_imagen(t["l"])
            if n["imagen"]:
                print(f"     foto de la noticia {n.get('numero')}: del mismo hecho en otro medio («{t['t'][:50]}»)")
                break
    if not latam.get("imagen") and latam.get("url"):
        latam["imagen"] = og_imagen(latam["url"])


def credito_de_url(url, medio=""):
    """«Foto: <medio>» para una foto sacada del og:image de un articulo.

    TODA FOTO LLEVA CREDITO desde la guia maestra de octubre de 2026. La de un
    articulo es del medio que la publico: es lo que se puede afirmar sin
    inventar un fotografo. El nombre sale de la ficha de la noticia, y si no
    viene, del dominio.
    """
    if medio:
        return "Foto: " + medio
    d = re.sub(r"^https?://(www\.)?", "", url or "").split("/")[0]
    return ("Foto: " + d) if d else ""


def foto_wikidata(nombre):
    """(url, credito) de la imagen de una entidad en Wikidata, o ("", "").

    Para los huecos que la guia pide con un sujeto concreto y que el articulo no
    resuelve: el LUGAR de la noticia principal (fondo de portada, «el fondo dice
    donde pasa») y su PROTAGONISTA (pagina de perspectivas). El modelo dice el
    nombre; la imagen y su licencia salen de Wikidata y Commons, no del modelo.
    Es el mismo camino que usa el medio para sus portadas (motor/entidad.py del
    otro repo), que se eligio porque buscar por texto en Commons trae fotos del
    lugar correcto y del asunto equivocado.
    """
    if not nombre:
        return "", ""
    import urllib.parse
    api = "https://www.wikidata.org/w/api.php?"
    try:
        q = json.loads(urllib.request.urlopen(urllib.request.Request(
            api + urllib.parse.urlencode({"action": "wbsearchentities", "search": nombre,
                                          "language": "es", "format": "json", "limit": 1}),
            headers={"User-Agent": "EntornoRender/3.0 (sureconomics.com)"}), timeout=20).read())
        if not q.get("search"):
            return "", ""
        qid = q["search"][0]["id"]
        e = json.loads(urllib.request.urlopen(urllib.request.Request(
            api + urllib.parse.urlencode({"action": "wbgetclaims", "entity": qid, "property": "P18",
                                          "format": "json"}),
            headers={"User-Agent": "EntornoRender/3.0 (sureconomics.com)"}), timeout=20).read())
        p18 = (e.get("claims") or {}).get("P18") or []
        if not p18:
            return "", ""
        archivo = p18[0]["mainsnak"]["datavalue"]["value"]
        info = json.loads(urllib.request.urlopen(urllib.request.Request(
            "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({
                "action": "query", "titles": "File:" + archivo, "prop": "imageinfo",
                "iiprop": "url|extmetadata", "iiurlwidth": 1600, "format": "json"}),
            headers={"User-Agent": "EntornoRender/3.0 (sureconomics.com)"}), timeout=20).read())
        pag = next(iter(info["query"]["pages"].values()))
        ii = pag["imageinfo"][0]
        meta = ii.get("extmetadata") or {}
        autor = re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", "")).strip()
        lic = (meta.get("LicenseShortName") or {}).get("value", "").strip()
        partes = [p for p in (autor[:60], lic, "Wikimedia Commons") if p]
        return ii.get("thumburl") or ii.get("url"), "Foto: " + " · ".join(partes)
    except Exception:
        return "", ""


def misma_foto(a, b):
    return bool(a and b and a.read_bytes() == b.read_bytes())


def repartir_fotos(ed, notas, latam, dest):
    """Las fotos de la edicion, cada una con su credito y SIN REPETIRSE.

    Reglas de la guia maestra (octubre de 2026):
      - cada vineta lleva la foto de SU noticia;
      - la portada lleva DOS fotos de la noticia 01, distintas: el fondo dice
        DONDE pasa (el lugar, en plano abierto) y la polaroid QUE o QUIEN;
      - «¿Que podria pasar?» lleva otra foto de la noticia 01, distinta de las
        de portada;
      - Latam, la del pais del punto mas fuerte;
      - ninguna imagen se repite en la edicion, y no se rellena un hueco con la
        foto de otra noticia (la «foto prestada» de septiembre queda fuera: la
        guia lo prohibe expresamente).
    Lo que quede sin foto se dice en el chequeo antes de enviar, no se tapa.
    Devuelve {clave: (ruta, credito)}.
    """
    fotos = {}
    usadas = []

    def tomar(clave, url, credito):
        p = bajar_foto(url, dest, "foto-" + clave) if url else None
        if p and any(misma_foto(p, u) for u in usadas):
            print(f"     {clave}: la foto ya sale en otra pagina; no se repite")
            p = None
        if p:
            usadas.append(p)
            fotos[clave] = (p, credito)
        return p

    for k, n in enumerate(notas):
        tomar("n%d" % (k + 1), n.get("imagen"), n.get("credito") or credito_de_url(n.get("url"), n.get("medio")))
    n1 = notas[0] if notas else {}
    # LA POLAROID NO ES LA FOTO DE LA VINETA 01: la guia prohibe repetir una
    # imagen en la edicion, y la primera prueba (09/10/2026) puso la misma foto
    # en la portada y en la vineta. La polaroid dice «que o quien»: el
    # protagonista. El fondo dice «donde»: el lugar. Y «¿Que podria pasar?» lleva
    # un segundo actor de la misma noticia.
    for clave, campo in (("polaroid", "protagonista"), ("fondo", "lugar"), ("perspectiva", "secundario")):
        url, cred = foto_wikidata(n1.get(campo))
        tomar(clave, url, cred)
    lat_url = latam.get("imagen")
    tomar("latam", lat_url, latam.get("credito") or credito_de_url(latam.get("url"), latam.get("medio")))
    if "latam" not in fotos and latam.get("pais"):
        url, cred = foto_wikidata(latam.get("pais"))
        tomar("latam", url, cred)
    return fotos


def lunes_objetivo(hoy):
    """El lunes en que sale la edicion: hoy si es lunes, si no el proximo."""
    from datetime import timedelta
    return hoy + timedelta(days=(7 - hoy.weekday()) % 7)


def semana_cubierta(hoy):
    """(desde, hasta) de la semana que cubre la edicion: la ANTERIOR al lunes de
    envio, de lunes a domingo. Decision de Saul el 08/10/2026 siguiendo la guia
    («sale cada lunes y cubre la semana anterior»); el ejemplo de la plantilla,
    que ponia la semana que empieza, estaba mal."""
    from datetime import timedelta
    l = lunes_objetivo(hoy)
    return l - timedelta(days=7), l - timedelta(days=1)


def numero_de_edicion(hoy):
    """El numero correlativo: los numeros del boletin YA ENVIADOS antes del lunes
    de esta edicion, mas uno. Decision de Saul el 08/10/2026 («contar las ya
    enviadas»). Se cuentan los enviados, no los creados: el equipo crea numeros
    vacios por adelantado.

    Sin acceso al panel (no hay credenciales o no contesta) se cuenta desde una
    ancla medida ese dia: el 12/10/2026 es la N.º 3. Se avisa, porque esa cuenta
    asume que no se salta ninguna semana.
    """
    l = lunes_objetivo(hoy)
    # En local las claves del panel viven en el .env del bot; en Actions llegan
    # como secretos del repo (entorno.yml).
    env = BASE.parent / ".env"
    if env.exists():
        for linea in env.read_text(encoding="utf-8").splitlines():
            k, _, v = linea.partition("=")
            if k in ("SURECONOMICS_USUARIO", "SURECONOMICS_CLAVE") and v.strip():
                os.environ.setdefault(k, v.strip())
    try:
        sys.path.insert(0, str(BASE))
        import subir_boletin
        p = subir_boletin.Panel()
        p.entrar()
        numeros = (p.llamar("/admin/boletin/numeros") or {}).get("numeros") or []
        enviados = [n for n in numeros if n.get("status") == "sent"
                    and (n.get("send_on") or "") < l.isoformat()]
        return len(enviados) + 1
    except BaseException as e:  # Panel() sale con SystemExit si faltan las claves
        n = 3 + (l - date(2026, 10, 12)).days // 7
        print(f"     aviso: no pude contar los numeros enviados en el panel ({e}); uso N.º {n}")
        return n


def edicion_normalizada(ed):
    """Las cuatro noticias, la pagina de perspectivas y Latam, vengan como vengan.

    El formato de octubre de 2026 (guia maestra) trae por noticia los tres
    lentes del analisis (economico, politico, crecimiento) y, aparte, el titular
    de la semana, la agenda y el escenario. Una edicion de antes trae la
    «lectura» en vinetas sueltas: se muestran como vinetas sin nombre de lente.
    """
    notas = list(ed.get("noticias") or [])
    s = ed.get("secciones") or {}
    if not notas and (s.get("TITULAR") or s.get("CUERPO")):
        ps = parrafos(s.get("CUERPO", ""))
        notas = [{
            "numero": 1,
            "tema": (s.get("NICHO") or "VENEZUELA").split("/")[0].strip(),
            "titulo": s.get("TITULAR", ""), "subtitulo": s.get("SUBTITULO", ""),
            "cuerpo": "\n\n".join(ps[:2]), "lectura": " ".join(ps[2:3]),
            "imagen": (ed.get("portada") or {}).get("imagen", ""),
        }]
    latam = ed.get("latam") or {}
    if not latam.get("puntos") and latam.get("items"):
        latam = dict(latam, puntos=latam["items"])
    if not latam.get("puntos") and s.get("LATAM"):
        latam = dict(latam, puntos=[" ".join(x.strip().split("\n"))
                                    for x in re.split(r"\n?-{3,}\n?", s["LATAM"]) if x.strip()][:4])
    return notas[:4], latam


def palabras_de(t):
    return len(re.findall(r"[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ$%.,]+", str(t or "")))


def raices(t):
    """Las palabras con peso de un texto, recortadas a 5 letras: «licencia» y
    «licencias» cuentan como la misma."""
    return {w[:5] for w in palabras(t)}


GUION = re.compile(r"[-–—→←]")
RELLENO = re.compile(r"^\s*(t[ií]tulo|subt[ií]tulo|tema|evento\s*\d*|titular relevante de la semana\.?)\s*$", re.I)


def chequeo(ed, notas, latam, fotos):
    """El checklist de la guia maestra («ninguna edicion sale sin pasar estos 10
    puntos»), hecho por codigo antes de mandar las laminas.

    No bloquea nada: lo dice en el chat, encima del boton de subir al boletin,
    para que la persona que aprueba sepa que mirar. Lo que el codigo no puede
    comprobar (que una cifra sea la mas reciente) se dice como «a revisar».
    Devuelve [(estado, punto, detalle)], con estado "ok", "aviso" o "revisar".
    """
    out = []

    def punto(ok, nombre, detalle=""):
        out.append(("ok" if ok else "aviso", nombre, detalle))

    # 1. Numero de edicion y fecha (desde el 09/10/2026, el lunes de salida y no la semana).
    punto(bool(ed.get("edicion")) and bool(fecha_de_salida(ed)), "Número de edición y fecha en la portada",
          "" if ed.get("edicion") else "falta el número de edición")
    # 2. Titular de portada = vineta 01.
    n1 = notas[0] if notas else {}
    tit = ed.get("titular") or ""
    comun = raices(tit) & raices(" ".join([n1.get("titulo", ""), n1.get("subtitulo", ""), n1.get("cuerpo", "")]))
    punto(bool(tit) and len(comun) >= 2, "Titular de portada coincide con la viñeta 01",
          "" if tit else "no hay titular de la semana")
    # 3. Campos vacios, de relleno o repetidos.
    campos = []
    for k, n in enumerate(notas):
        for c in ("tema", "titulo", "subtitulo", "cuerpo"):
            campos.append(("viñeta %d, %s" % (k + 1, c), n.get(c, "")))
        for c, nombre in LENTES:
            campos.append(("viñeta %d, lente %s" % (k + 1, nombre.lower()), (n.get("lentes") or {}).get(c, "")))
    campos += [("escenario", ed.get("escenario", ""))] + [("Latam, punto %d" % (i + 1), x)
                                                         for i, x in enumerate(latam.get("puntos") or [])]
    vacios = [c for c, v in campos if not str(v).strip() or RELLENO.match(str(v))]
    # El tema se repite con razon (dos vinetas de PETROLEO); el resto no.
    textos = [str(v).strip() for c, v in campos if str(v).strip() and not c.endswith(", tema")]
    repetidos = len(textos) - len(set(textos))
    punto(not vacios and not repetidos and len(notas) == 4, "Ningún campo vacío, de relleno ni repetido",
          "; ".join(vacios[:6]) + (" (%d textos repetidos)" % repetidos if repetidos else "")
          + ("" if len(notas) == 4 else " (hay %d viñetas, no 4)" % len(notas)))
    # 4. Fotos reales, con credito, sin repetirse; dos distintas en portada.
    faltan = [c for c in ["n%d" % (k + 1) for k in range(len(notas))] + ["polaroid", "fondo", "perspectiva", "latam"]
              if c not in fotos]
    sin_cred = [c for c, (_, cred) in fotos.items() if not cred]
    nombres = {"polaroid": "polaroid de portada", "fondo": "fondo de portada",
               "perspectiva": "¿Qué podría pasar?", "latam": "Latam"}
    punto(not faltan and not sin_cred, "Todas las fotos reales, con crédito y sin repetirse",
          ("faltan: " + ", ".join(nombres.get(c, "viñeta " + c[1:]) for c in faltan) if faltan else "")
          + ("; sin crédito: " + ", ".join(sin_cred) if sin_cred else ""))
    # 5. Cada subtitulo explicado en su cuerpo.
    flojos = []
    for k, n in enumerate(notas):
        sub = raices(n.get("subtitulo"))
        if sub and len(sub & raices(n.get("cuerpo"))) * 2 < len(sub):
            flojos.append("viñeta %d" % (k + 1))
    punto(not flojos, "Cada subtítulo está explicado en su cuerpo", ", ".join(flojos))
    # 6. Tres lentes, sin repetir el cuerpo.
    malos = []
    for k, n in enumerate(notas):
        lentes = n.get("lentes") or {}
        cuerpo = raices(n.get("cuerpo"))
        for c, nombre in LENTES:
            r = raices(lentes.get(c))
            if not r:
                malos.append("viñeta %d sin lente %s" % (k + 1, nombre.lower()))
            elif len(r & cuerpo) / len(r) > 0.6:
                malos.append("viñeta %d, lente %s repite el cuerpo" % (k + 1, nombre.lower()))
    punto(not malos, "Cada análisis tiene los 3 lentes, sin repetir el cuerpo", "; ".join(malos[:6]))
    # 7. Cifras con fuente y las mas recientes: el codigo solo puede ver que la
    #    fuente se nombre en el cuerpo.
    sin_fuente = [("viñeta %d" % (k + 1)) for k, n in enumerate(notas)
                  if n.get("medio") and n["medio"].split()[0].lower() not in (n.get("cuerpo") or "").lower()]
    out.append(("revisar", "Cifras con fuente y las más recientes",
                ("no se nombra el medio en: " + ", ".join(sin_fuente) + ". " if sin_fuente else "")
                + "Que cada cifra sea la última disponible lo tiene que confirmar una persona."))
    # 8. Economia en cifras: una sola fecha de corte.
    d = ed.get("datos", ed)
    corte = d.get("corte") or ""
    otras = [x.get("nombre", k) for k, x in (d.get("mercados") or {}).items()
             if isinstance(x, dict) and x.get("fecha") and corte and x["fecha"] != corte]
    punto(bool(corte) and not otras, "Economía en cifras con una sola fecha de corte",
          ("cierran en otra fecha: " + ", ".join(otras)) if otras else ("" if corte else "sin fecha de corte"))
    # 9. Cero guiones.
    con_guion = [c for c, v in campos + [("titular", tit)] +
                 [("evento %d" % (i + 1), e.get("nombre", "") + " " + e.get("descripcion", ""))
                  for i, e in enumerate(ed.get("eventos") or [])]
                 if GUION.search(str(v))]
    punto(not con_guion, "Cero guiones en todo el boletín", ", ".join(con_guion[:8]))
    # 10. Numeracion: las vinetas la pone el codigo; la agenda pide tres.
    n_ev = len(ed.get("eventos") or [])
    punto(n_ev == 3, "Agenda con 3 eventos de fecha confirmada",
          "" if n_ev == 3 else "hay %d; los demás no tenían fecha confirmada en su fuente" % n_ev)
    # Y los largos de la guia, que son las cajas de la plantilla.
    largos = []
    topes = [("titular", tit, 12)]
    for k, n in enumerate(notas):
        topes += [("viñeta %d título" % (k + 1), n.get("titulo"), 4),
                  ("viñeta %d subtítulo" % (k + 1), n.get("subtitulo"), 8),
                  ("viñeta %d cuerpo" % (k + 1), n.get("cuerpo"), 120)]
        topes += [("viñeta %d %s" % (k + 1, nombre.lower()), (n.get("lentes") or {}).get(c), 50) for c, nombre in LENTES]
    topes += [("escenario", ed.get("escenario"), 120), ("Latam conclusión", latam.get("conclusion"), 40)]
    topes += [("Latam punto %d" % (i + 1), x, 50) for i, x in enumerate(latam.get("puntos") or [])]
    topes += [("evento %d" % (i + 1), e.get("descripcion"), 25) for i, e in enumerate(ed.get("eventos") or [])]
    for nombre, texto, tope in topes:
        n = palabras_de(texto)
        if n > tope:
            largos.append("%s %d de %d" % (nombre, n, tope))
    punto(not largos, "Largos de la guía (palabras)", "; ".join(largos[:8]))
    return out


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


def fecha_sin_anio(iso):
    """«9 de octubre»: la guia pide fechas escritas, sin abreviar ni guiones."""
    if not iso:
        return ""
    a, m, d = iso[:10].split("-")
    return f"{int(d)} de {MESES[int(m) - 1]}"


def rango_semana(ed):
    """«del 5 al 11 de octubre de 2026», sin guiones (guia maestra, regla 1)."""
    s = ed.get("semana") or {}
    if not s.get("desde") or not s.get("hasta"):
        return ""
    a0, m0, d0 = s["desde"][:10].split("-")
    a1, m1, d1 = s["hasta"][:10].split("-")
    if a0 != a1:
        return "del %d de %s de %s al %d de %s de %s" % (int(d0), MESES[int(m0) - 1], a0,
                                                         int(d1), MESES[int(m1) - 1], a1)
    if m0 != m1:
        return "del %d de %s al %d de %s de %s" % (int(d0), MESES[int(m0) - 1], int(d1), MESES[int(m1) - 1], a1)
    return "del %d al %d de %s de %s" % (int(d0), int(d1), MESES[int(m1) - 1], a1)


def fecha_de_salida(ed):
    """«Lunes 12 de octubre de 2026»: el lunes en que sale la edicion, que es el
    dia siguiente al ultimo de la semana cubierta. Lo que va en la portada desde
    el 09/10/2026: Saul pidio quitar la semana y dejar solo la edicion y el lunes."""
    from datetime import timedelta
    s = ed.get("semana") or {}
    if s.get("lunes"):
        l = date.fromisoformat(s["lunes"][:10])
    elif s.get("hasta"):
        l = date.fromisoformat(s["hasta"][:10]) + timedelta(days=1)
    else:
        return ""
    return "Lunes %d de %s de %d" % (l.day, MESES[l.month - 1], l.year)


def flecha(v, dec=2):
    """Variacion de mercado con ▲ o ▼, nunca con guion ni signo menos (guia
    maestra, pagina 5): «7.354,02 ▼ 1,78%»."""
    if v is None:
        return "s/d"
    return ("▲ " if v >= 0 else "▼ ") + num(abs(v), dec) + "%"


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
    // En las cajas que envuelven se mira TAMBIEN el ancho: una palabra larga
    // no se parte y se sale por el lado aunque el alto quepa. Paso con el
    // subtitulo de cabecera, cuya caja llega justo al filo de la pagina.
    var ancha = function () { return modo === 'h' && el.scrollWidth > el.clientWidth + 1; };
    while ((mide() > max + 0.5 || ancha()) && fs > base * 0.5 && n < 80) {
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
            # El body con el color de la pagina: la escala deja una columna de
            # 1 px a la derecha y con fondo negro se veia una raya.
            + "</style></head><body style='background:%s'><div class='page' style='background:%s'>" % (fondo, fondo)
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


VERDE = "#003318"        # el verde de la plantilla de octubre de 2026
VERDE_NOCHE = "#0c1f0c"  # la banda baja de la portada y el titulo de Mercado bursatil
VERDE_NUM = "#132a13"    # los numeros de la agenda y una etiqueta de cifras


def lineas_dobles(top=82.30, color="#fff"):
    """La franja de dos lineas de arriba. En la portada es verde sobre verde
    (asi esta en la plantilla) y en la pagina de perspectivas va mas arriba."""
    return "<div class='a' style='%s'></div>" % caja(
        -112.18, top, 1793.90, 85.92, "border:3px solid %s;" % color)


def credito(texto, left, top, w, h, alinear="left"):
    """El credito de una foto, dentro de su caja, abajo.

    La plantilla no trae sitio para el credito, pero la guia lo exige en toda
    foto. Va en letra pequena sobre una sombra suave en la parte VISIBLE de la
    caja (las fotos de vineta y de Latam desbordan la pagina).
    """
    if not texto:
        return ""
    x0, x1 = max(left, 0), min(left + w, CW)
    y1 = min(top + h, CH)
    return ("<div class='a i' style='%s'>%s</div>" % (caja(
        x0, y1 - 46, x1 - x0, 46,
        "display:flex;align-items:flex-end;justify-content:%s;padding:0 18px 12px;"
        "font-size:18px;line-height:1.2;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        "background:linear-gradient(to top,rgba(0,0,0,.55),rgba(0,0,0,0));"
        % ("flex-end" if alinear == "right" else "flex-start")), esc(texto)))


def foto_o_mapa(foto, left, top, w, h):
    """La foto de una pagina con su credito, o el mapa de la plantilla si falta.

    SIN FOTO NO SE PRESTA LA DE OTRA NOTICIA: la guia maestra lo prohibe («una
    foto sin relacion con el texto»), y el hueco lo denuncia el chequeo antes de
    enviar. Mientras tanto queda el mapa de la plantilla sobre verde, que no
    finge ser la foto de la noticia.
    """
    if foto:
        ruta, cred = foto
        return ("<img class='a foto' src='%s' style='%s'>" % (uri(ruta), caja(left, top, w, h))
                + credito(cred, left, top, w, h))
    mx, my, mw, mh = en_unidades(MAPA)
    x0, x1 = max(left, 0), min(left + w, CW)
    y0, y1 = max(top, 0), min(top + h, CH)
    vw, vh = x1 - x0, y1 - y0
    esc_m = min(vw / mw, vh / mh) * 0.8
    return ("<div class='a' style='%s'><img src='%s' style='position:absolute;"
            "left:%.2fpx;top:%.2fpx;width:%.2fpx;opacity:0.55'></div>") % (
        caja(left, top, w, h, "background:%s;overflow:hidden;" % VERDE), uri(ASSETS / "mapa.png"),
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

# El logo SurE, sobre su silueta medida en la exportacion (px). Es el del sitio
# (sureconomics.com/brand/v2/sure-negativo.png): el de Canva solo se puede bajar
# a 200 px y se veia borroso.
LOGO = (984, 142, 288, 84)


def html_portada(ed, fotos, notas, latam):
    n = notas[0] if notas else {}
    px, py, pw, ph = en_unidades(PILA)
    lx, ly, lw, lh = en_unidades(LOGO)
    partes = []
    fondo = fotos.get("fondo")
    if fondo:
        # Medido sobre la exportacion: la foto va al 16 % de opacidad sobre el
        # verde (ajuste lineal por canal, error medio 1 sobre 255). La guia pide
        # ademas desenfoque; a esa opacidad apenas se nota, pero se respeta.
        partes.append("<img class='a foto' src='%s' style='%s'>" % (
            uri(fondo[0]), caja(-20, -20, CW + 40, CH + 40, "opacity:0.16;filter:blur(3px);")))
    partes.append(lineas_dobles(color=VERDE))
    partes.append("<img class='a' src='%s' style='%s'>" % (
        uri(ASSETS / "sure-negativo.png"), caja(lx, ly, lw, lh)))
    partes.append("<div class='a hg' data-fit='h:100' style='%s'>%s</div>" % (caja(
        158.75, 315.43, 1035.72, None,
        "font-size:42.57px;line-height:0.96;letter-spacing:0.072em;"),
        esc("Edición N.º %s · %s" % (ed.get("edicion", ""), fecha_de_salida(ed)))))
    partes.append("<div class='a i tt' style='%s'>Entorno en Viñetas</div>" % caja(
        153.91, 405.65, 1040.55, None, "font-size:191.76px;"))
    pila = recurso_privado("pila.png")
    if pila:
        partes.append("<img class='a' src='%s' style='%s'>" % (uri(pila), caja(px, py, pw, ph)))
    polaroid = fotos.get("polaroid")
    if polaroid:
        partes.append(
            "<svg class='a' style='%s' viewBox='0 0 1023.224 727.632'>"
            "<defs><clipPath id='marco'><path d='%s'/></clipPath></defs>"
            "<image href='%s' x='0' y='0' width='1023.224' height='727.632' "
            "preserveAspectRatio='xMidYMid slice' clip-path='url(#marco)'/></svg>"
            % (caja(551.57, 980.03, 562.42, 399.94, "opacity:0.9;"), MARCO, uri(polaroid[0])))
    partes.append("<div class='a' style='%s'></div>" % caja(0, 1666.28, 1652.75, 578.76,
                                                             "background:%s;" % VERDE_NOCHE))
    partes.append("<div class='a i18 b' style='%s'>Venezuela en tres lentes: economía, política y crecimiento.</div>"
                  % caja(158.75, 1743.70, 1107.30, None,
                         "font-size:75.88px;line-height:0.87;letter-spacing:-0.06em;"))
    partes.append("<div class='a i18' data-fit='h:152' style='%s'>%s</div>" % (caja(
        153.91, 1922.36, 1107.30, None, "font-size:74.55px;line-height:0.87;letter-spacing:-0.06em;"),
        esc(ed.get("titular") or n.get("titulo", ""))))
    partes.append("<div class='a hg' style='%s'>Cada lunes en tu correo · Suscríbete en sureconomics.com</div>"
                  % caja(130.02, 2096.96, 1327.35, None,
                         "font-size:39.90px;line-height:0.96;letter-spacing:0.072em;text-align:center;"))
    creds = " · ".join(c for c in ((polaroid or (0, ""))[1], (fondo or (0, ""))[1]) if c)
    if creds:
        partes.append("<div class='a i' style='%s'>%s</div>" % (caja(
            130.02, 2175, 1327.35, None, "font-size:18px;line-height:1.2;text-align:center;opacity:0.7;"),
            esc(creds)))
    return pagina("".join(partes), fondo=VERDE)


LENTES = (("economico", "Económico"), ("politico", "Político"), ("crecimiento", "Crecimiento"))


def analisis(n):
    """El bloque de analisis: tres vinetas, una por lente, con el nombre del
    lente en negrita (guia maestra). Una edicion vieja trae la «lectura» en
    vinetas sueltas: salen sin nombre de lente."""
    lentes = n.get("lentes") or {}
    if any(lentes.get(k) for k, _ in LENTES):
        return "<br>".join("▪ <b>%s:</b> %s" % (nombre, esc(lentes.get(k, "")))
                           for k, nombre in LENTES if lentes.get(k))
    lect = n.get("lectura") or []
    if isinstance(lect, str):
        lect = [lect]
    return "<br>".join("▪ " + esc(v) for v in list(lect)[:3] if v and v.strip())


def html_vineta(ed, fotos, notas, latam, k):
    n = notas[k]
    ps = parrafos(n.get("cuerpo", ""))
    cuerpo = "".join("<p style='margin-bottom:%s'>%s</p>" % ("0" if i == len(ps) - 1 else "1.4em", esc(p))
                     for i, p in enumerate(ps))
    partes = [
        "<div class='a' style='%s'></div>" % caja(-97.42, -54.62, 1782.23, 615.07, "background:%s;" % VERDE),
        lineas_dobles(),
        foto_o_mapa(fotos.get("n%d" % (k + 1)), -112.18, 619.44, 809.57, 809.57),
        "<div class='a i just' data-fit='h:843' style='%s'>%s</div>" % (caja(
            747.89, 624.24, 727.61, None, "font-size:32.43px;line-height:1.4;color:#000;"), cuerpo),
        # La franja verde de la izquierda y los tres lentes sobre blanco: asi
        # quedo el bloque de analisis en la plantilla de octubre.
        "<div class='a' style='%s'></div>" % caja(-122.72, 1586.36, 174.86, 530.46, "background:%s;" % VERDE),
        "<div class='a i just' data-fit='h:530' style='%s'>%s</div>" % (caja(
            115.39, 1586.36, 1356.61, None, "font-size:32.43px;line-height:1.4;color:%s;" % VERDE),
            analisis(n)),
        "<div class='a mo' style='%s'>SURECONOMICS</div>" % caja(
            1136.63, 106.46, 380.94, None, "font-size:33.33px;line-height:1.4;text-align:right;"),
        "<div class='a i tt' data-fit='h:290' style='%s'>%s</div>" % (caja(
            179.73, 252.91, 609.92, None, "font-size:121.64px;"), esc(n.get("titulo", ""))),
        "<div class='a i tt una girado' data-fit='w:267' style='%s'>%s</div>" % (caja(
            -16.76, 333.08, 266.52, 54.46,
            "font-size:46.16px;line-height:0.8;transform:rotate(-90deg);"), esc(n.get("tema", ""))),
        "<div class='a i tt sub' data-fit='h:170' style='%s'>%s</div>" % (caja(
            926.59, 379.66, 660.81, None, "font-size:63.40px;padding-right:69.8px;"),
            esc(n.get("subtitulo", ""))),
        # Blanco en las cuatro: en la plantilla el (02) es verde sobre verde y
        # no se ve, y la guia pide numeracion consecutiva y visible.
        "<div class='a i tt dcha' style='%s'>(%02d)</div>" % (caja(
            616.50, 203.37, 168.26, None, "font-size:73.07px;line-height:0.8;color:#fff;"), k + 1),
    ]
    return pagina("".join(partes), fondo="#fff")


# Las tres filas de la agenda: (caja del numero, titulo, descripcion y su ancho).
AGENDA = [
    ((122.62, 440.51), (326.32, 440.72), (326.32, 515.55, 976.09)),
    ((123.80, 736.27), (327.50, 736.48), (327.50, 811.31, 1021.97)),
    ((123.80, 1020.91), (327.50, 1021.12), (327.50, 1095.94, 1101.16)),
]


def html_perspectivas(ed, fotos, notas, latam):
    """Pagina 6: «¿Que estamos esperando?» arriba (la agenda de la semana que
    empieza) y «¿Que podria pasar?» abajo (el escenario sobre la vineta 01)."""
    partes = [
        "<div class='a' style='%s'></div>" % caja(-104.27, -24.40, 1733.82, 1362.37, "background:%s;" % VERDE),
        lineas_dobles(top=59.37),
        # En la plantilla, verde sobre verde: no se ve, pero esta.
        "<div class='a mo' style='%s'>SURECONOMICS</div>" % caja(
            1136.63, 106.46, 380.94, None, "font-size:33.33px;line-height:1.4;text-align:right;color:%s;" % VERDE),
        # La guia corrige la tilde de la plantilla («estámos») y el espacio
        # antes del cierre de interrogacion.
        "<div class='a i tt una' data-fit='w:1300' style='%s'>¿Qué estamos esperando?</div>" % caja(
            133.28, 272.42, None, None, "font-size:97.51px;"),
    ]
    eventos = (ed.get("eventos") or [])[:3]
    for i, ev in enumerate(eventos):
        (bx, by), (tx, ty), (dx, dy, dw) = AGENDA[i]
        partes.append("<div class='a' style='%s'></div>" % caja(bx, by, 170.48, 170.48,
                                                                 "background:#fff;border-radius:32px;"))
        # Numeracion consecutiva 01, 02, 03 (la plantilla salta 01, 03, 05).
        partes.append("<div class='a i tt' style='%s'>%02d</div>" % (caja(
            bx, by + 30.66, 170.48, None, "font-size:91.24px;text-align:center;color:%s;" % VERDE_NUM), i + 1))
        partes.append("<div class='a i b una' data-fit='w:1110' style='%s'>%s</div>" % (caja(
            tx, ty, None, None, "font-size:54.48px;line-height:0.98;letter-spacing:-0.036em;"),
            esc(ev.get("nombre", ""))))
        partes.append("<div class='a i just' data-fit='h:150' style='%s'>%s</div>" % (caja(
            dx, dy, dw, None, "font-size:28.50px;line-height:1.4;"), esc(ev.get("descripcion", ""))))
    # «¿Que podria pasar?»: cuatro piezas, como en la plantilla. El «¿» es un
    # «?» girado casi 180 grados.
    partes += [
        "<div class='a i tt una' style='%s'>Qué podría</div>" % caja(
            159.50, 1376.07, None, None, "font-size:103.62px;color:%s;" % VERDE),
        "<div class='a i tt una' style='%s'>pasar</div>" % caja(
            208.06, 1439.73, None, None, "font-size:142.55px;color:%s;" % VERDE),
        "<div class='a i tt' style='%s'>?</div>" % caja(
            624.72, 1382.58, 100.61, 248.79,
            "font-size:213.08px;color:%s;transform:rotate(9.32deg);" % VERDE),
        "<div class='a i tt' style='%s'>?</div>" % caja(
            83.32, 1369.02, 100.32, 248.09,
            "font-size:212.48px;color:%s;transform:rotate(-178.76deg);" % VERDE),
    ]
    ps = parrafos(ed.get("escenario", ""))
    partes.append("<div class='a i just' data-fit='h:485' style='%s'>%s</div>" % (caja(
        80.64, 1655.87, 924.08, None, "font-size:32.43px;line-height:1.4;color:%s;" % VERDE),
        "".join("<p style='margin-bottom:%s'>%s</p>" % ("0" if i == len(ps) - 1 else "1.4em", esc(p))
                for i, p in enumerate(ps))))
    partes.append(foto_o_mapa(fotos.get("perspectiva"), 1045.72, 1411.14, 775.74, 744.44))
    return pagina("".join(partes), fondo="#fff")


def linea(x0, x1, y):
    """Linea de 6 de grosor centrada en y, como las de la plantilla."""
    return "<div class='a' style='%s'></div>" % caja(x0, y - 3, x1 - x0, 6, "background:%s;" % VERDE)


def vertical(x, y0, y1):
    return "<div class='a' style='%s'></div>" % caja(x - 3, y0, 6, y1 - y0, "background:%s;" % VERDE)


def html_cifras(ed, fotos, notas, latam):
    """Economia en cifras: una sola fecha de corte (el cierre del viernes anterior
    al envio), variaciones semanales con ▲ y ▼, fechas escritas y la linea de
    fuentes real (guia maestra, pagina 5)."""
    d = ed.get("datos", ed)
    c, m, inf, ibc = d["cambiario"], d["mercados"], d["inflacion"], d["ibc"]
    corte = d.get("corte") or ""

    def val(k, dec=None):
        x = m.get(k) or {}
        if x.get("valor") is None:
            return "s/d"
        return num(x["valor"], dec if dec is not None else (0 if x.get("dec") == 0 else 2))

    def var(k):
        x = m.get(k) or {}
        return flecha(x.get("sem"))

    brecha = "s/d" if c.get("brecha") is None else num(c["brecha"], 2) + "%"
    et = "font-size:31.45px;line-height:0.96;letter-spacing:0.072em;"
    tasa = "font-family:Archivo Black,sans-serif;font-size:91.39px;line-height:0.97;color:%s;" % VERDE
    commodities = ["Petróleo Brent: US$ %s por barril %s" % (val("brent"), var("brent"))]
    if (m.get("merey") or {}).get("valor") is not None:
        commodities.append("Merey 16: US$ %s por barril %s" % (val("merey"), var("merey")))
    commodities.append("Oro: US$ %s por onza %s" % (val("oro"), var("oro")))
    fuentes = d.get("fuentes_cifras") or "BCV, ve.dolarapi.com, Yahoo Finance, Bolsa de Valores de Caracas"
    partes = [
        "<div class='a' style='%s'></div>" % caja(87.86, 158.74, 884.59, 499.58,
                                                  "background:%s;opacity:0.69;" % VERDE),
        linea(87.86, 972.45, 1369.90), linea(91.35, 975.94, 961.20), linea(87.86, 975.94, 1970.27),
        linea(969.13, 1473.37, 838.21), linea(968.95, 1473.19, 1467.64), linea(968.95, 1473.19, 577.25),
        vertical(972.45, 165.27, 2128.47), linea(87.86, 1468.25, 2131.99), linea(87.86, 1468.25, 161.74),
        vertical(87.86, 161.74, 2129.44), vertical(1469.70, 161.74, 2129.44), linea(87.86, 972.45, 658.32),
        "<div class='a pm' data-fit='h:100' style='%s'>Fuentes: %s. Corte: %s</div>" % (caja(
            153.96, 2025.34, 741.07, None, "font-size:20.46px;line-height:1.4;color:%s;" % VERDE),
            esc(fuentes), fecha_larga(corte) if corte else ""),
        "<div class='a i tt' style='%s'>ECONOMÍA EN<br>CIFRAS</div>" % caja(
            142.75, 212.67, 763.49, None, "font-size:125.39px;"),
        "<div class='a i18 b' style='%s'>DÓLAR</div>" % caja(
            998.66, 279.52, None, None, "font-size:73.02px;line-height:1.35;color:#1a1a1a;"),
        "<div class='a' style='%s'></div>" % caja(995.55, 387.09, 449.73, 154.73,
                                                  "background:#fff;border-radius:22px;"),
        "<div class='a i18' style='%s'>TASA DE<br>CAMBIO<br><b>PARALELA</b></div>" % caja(
            1032.43, 415.84, 188.64, None, et + "color:%s;" % VERDE_NUM),
        "<div class='a una' data-fit='w:175' data-sin-aviso='1' style='%s'>%s</div>" % (caja(
            1254.22, 410.13, None, 108.64, tasa + "display:flex;align-items:center;"), num(c.get("paralelo"))),
        "<div class='a' style='%s'></div>" % caja(996.87, 608.18, 448.41, 154.73,
                                                  "background:#fff;border-radius:22px;"),
        "<div class='a i18' style='%s'>TASA DE<br>CAMBIO<br><b>BCV</b></div>" % caja(
            1032.43, 635.53, 281.63, None, et + "color:#1a1a1a;"),
        "<div class='a una' data-fit='w:175' data-sin-aviso='1' style='%s'>%s</div>" % (caja(
            1254.22, 629.89, None, 108.64, tasa + "display:flex;align-items:center;"), num(c.get("bcv"))),
        "<div class='a' style='%s'></div>" % caja(968.03, 801.08, 1618.84, 59.65, "background:%s;" % VERDE),
        "<div class='a mo' style='%s'>BRECHA SEMANAL</div>" % caja(
            998.66, 810.55, None, None, "font-size:35.42px;line-height:1.4;letter-spacing:0.009em;"),
        "<div class='a i18' style='%s'>%s</div>" % (caja(
            1355.58, 806.60, 176.74, None,
            "font-size:40.50px;font-style:italic;line-height:1.4;letter-spacing:0.072em;text-align:center;"), brecha),
        "<div class='a i18 b' style='%s'>Devaluación acumulada del año</div>" % caja(
            1008.83, 911.33, 436.45, None, "font-size:54.90px;line-height:0.85;color:#000;"),
        "<div class='a i18 b una' data-fit='w:440' style='%s'>%s</div>" % (caja(
            1008.83, 1090.33, None, None, "font-size:109.29px;line-height:0.85;color:%s;" % VERDE),
            ("s/d" if c.get("devalYTD") is None else num(c["devalYTD"], 1) + "%")),
        "<div class='a i18 b' style='%s'>Inflación</div>" % caja(
            1013.08, 1538.77, None, None, "font-size:54.90px;line-height:0.85;color:#000;"),
        "<div class='a mo just' data-fit='h:330' style='%s'><b>IPC (%s):</b> %s mensual<br>"
        "<b>Inflación acumulada en el año:</b> %s</div>" % (caja(
            1020.90, 1632.21, 349.46, None,
            "font-size:35.42px;line-height:1.4;letter-spacing:0.009em;color:#1a1a1a;"),
            esc(inf.get("mes", "")), ("s/d" if inf.get("mensual") is None else num(inf["mensual"], 1) + "%"),
            ("s/d" if inf.get("acumulada") is None else num(inf["acumulada"], 1) + "%")),
        "<div class='a i18 b' style='%s'>Commodities</div>" % caja(
            136.63, 708.32, 876.46, None, "font-size:76.00px;line-height:1.35;color:#000;"),
        "<div class='a mo' data-fit='h:240' style='%s'>%s</div>" % (caja(
            136.63, 817.71, 800, None, "font-size:33.78px;line-height:1.4;letter-spacing:0.009em;color:#000;"),
            "<br>".join(esc(x) for x in commodities)),
        "<div class='a i18 b' style='%s'>Criptoactivos (al %s)</div>" % (caja(
            136.63, 1014.58, 724.64, None, "font-size:76.00px;line-height:1.09;color:#000;"),
            fecha_sin_anio(corte)),
        "<div class='a mo' style='%s'>BTC: US$ %s<br>ETH: US$ %s</div>" % (caja(
            136.63, 1219.83, 720, None, "font-size:33.78px;line-height:1.4;letter-spacing:0.009em;color:%s;" % VERDE),
            val("btc", 2), val("eth", 2)),
        "<div class='a i18 b' style='%s'>Mercado Bursátil</div>" % caja(
            136.63, 1431.75, 724.64, None, "font-size:76.00px;line-height:1.35;color:%s;" % VERDE_NOCHE),
        "<div class='a i18' style='%s'>(cierre del %s)</div>" % (caja(
            136.63, 1522.25, None, None, "font-size:43.97px;line-height:1.4;letter-spacing:0.009em;color:#1a1a1a;"),
            fecha_sin_anio(corte)),
        "<div class='a mo' data-fit='h:355' style='%s'>Dow Jones: %s %s<br>S&amp;P 500: %s %s"
        "<br>Nasdaq: %s %s<br>IBC (Bolsa de Caracas): %s %s</div>" % (caja(
            136.63, 1603.23, 780, None, "font-size:33.78px;line-height:1.4;letter-spacing:0.009em;color:#1a1a1a;"),
            val("dow"), var("dow"), val("sp500"), var("sp500"), val("nasdaq"), var("nasdaq"),
            num(ibc.get("valor")), flecha(ibc.get("sem"), 2)),
    ]
    return pagina("".join(partes), fondo="#fff")


def html_latam(ed, fotos, notas, latam):
    mx, my, mw, mh = en_unidades(MAPA)
    puntos = list(latam.get("puntos") or [])
    if latam.get("conclusion"):
        puntos.append(latam["conclusion"])
    puntos = puntos[:4]
    lista = "".join("<li style='margin-bottom:%s'>%s</li>" % ("0" if i == len(puntos) - 1 else "1.19em", esc(x))
                    for i, x in enumerate(puntos))
    partes = [
        "<img class='a' src='%s' style='%s'>" % (uri(ASSETS / "mapa.png"), caja(mx, my, mw, mh)),
        foto_o_mapa(fotos.get("latam"), 970.22, 879.81, 809.57, 1206.49),
        "<div class='a' style='%s'></div>" % caja(0, 879.81, 54.58, 1161.36, "background:#fff;"),
        "<div class='a i tt dcha' style='%s'>LATAM<br>ENLATADA</div>" % caja(
            566.86, 394.08, 934.35, None, "font-size:180.75px;line-height:0.8;color:#fff;"),
        # Sin numero: el (04) de la plantilla chocaba con la vineta 04 (guia
        # maestra; decision de Saul el 08/10/2026).
        "<ul class='a i just' data-fit='h:1161' style='%s'>%s</ul>" % (caja(
            80.29, 879.81, 754.05, None,
            "font-size:36.40px;line-height:1.19;padding-left:1.1em;list-style:disc;"), lista),
    ]
    return pagina("".join(partes), fondo=VERDE)


def laminas(notas):
    """(nombre, funcion) de cada lamina, en el orden de la guia maestra: portada,
    cuatro vinetas, perspectivas, Economia en cifras y Latam enlatada."""
    out = [("1-portada", html_portada)]
    for k in range(len(notas)):
        out.append(("%d-vineta-%d" % (2 + k, k + 1),
                    (lambda kk: lambda ed, f, n, l: html_vineta(ed, f, n, l, kk))(k)))
    b = 2 + len(notas)
    out += [("%d-perspectivas" % b, html_perspectivas), ("%d-cifras" % (b + 1), html_cifras),
            ("%d-latam" % (b + 2), html_latam)]
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
    completar_fotos(notas, latam, ed.get("titulares") or [])
    # Lo que la portada y Economia en cifras necesitan saber de la fecha, si el
    # Worker no lo trae: la semana cubierta, el numero de edicion y el corte de
    # los datos (el viernes anterior al lunes de envio).
    from datetime import timedelta
    hoy = date.fromisoformat(str(ed.get("hoy") or date.today().isoformat())[:10])
    d0, d1 = semana_cubierta(hoy)
    ed.setdefault("semana", {"desde": d0.isoformat(), "hasta": d1.isoformat()})
    if not ed.get("edicion"):
        ed["edicion"] = numero_de_edicion(hoy)
    datos = ed.get("datos", ed)
    datos.setdefault("corte", (lunes_objetivo(hoy) - timedelta(days=3)).isoformat())
    print(f"Edición N.º {ed['edicion']} · semana {rango_semana(ed)} · corte {datos['corte']}")
    print(f"{len(notas)} viñetas · Latam con {len(latam.get('puntos') or [])} puntos")
    fotos = repartir_fotos(ed, notas, latam, dest)
    for clave in ["n%d" % (k + 1) for k in range(len(notas))] + ["polaroid", "fondo", "perspectiva", "latam"]:
        if clave not in fotos:
            print(f"     aviso: {clave} sin foto")
    ed["chequeo"] = [list(x) for x in chequeo(ed, notas, latam, fotos)]
    print("CHEQUEO")
    for estado, nombre, detalle in ed["chequeo"]:
        print("  %-7s %s%s" % (estado, nombre, (": " + detalle) if detalle else ""))
    (dest / "edicion.json").write_text(json.dumps(ed, ensure_ascii=False, indent=1), encoding="utf-8")

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
