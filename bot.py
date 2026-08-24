"""Bot de noticias financieras y economicas para Telegram.

Lee varias fuentes RSS, filtra las noticias recientes y le pide a Gemini que
redacte un resumen (briefing) en español e ingles, y lo envia a un chat de
Telegram. Pensado para correr dos veces al dia (10:00 y 16:00 hora Venezuela)
via GitHub Actions o el Programador de tareas de Windows.
"""

import html
import os
import re
import socket
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import feedparser
import requests
from dotenv import load_dotenv
from google import genai

load_dotenv()

# Tiempo limite global de red: feedparser/urllib NO traen timeout y una fuente
# que deja la conexion colgada trababa el proceso ~15 min (regla de oro #3).
socket.setdefaulttimeout(25)

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
CHAT_ID = os.environ.get("CHAT_ID", "").strip()
# Permite varios destinatarios separados por coma, ej. "123,456".
CHAT_IDS = [c.strip() for c in CHAT_ID.split(",") if c.strip()]
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
# Proveedor de respaldo (opcional). Si esta definido y Gemini se agota, se usa Groq.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()

# Hora de Venezuela = UTC-4 (no usa horario de verano).
VET = timezone(timedelta(hours=-4))

# Maximo de titulares por categoria que se le pasan a la IA.
MAX_PER_CATEGORY = 6

# Modelos de Gemini en orden de preferencia. Cada modelo tiene su propia cuota
# gratuita diaria, asi que si uno se agota (429), probamos el siguiente
# automaticamente. flash-lite primero (mas cuota); flash da mejor prosa de respaldo.
# Los 2.5 dejaron de estar disponibles para proyectos NUEVOS: dan 404 con el
# mensaje "no longer available to new users". La clave antigua los seguia usando
# por herencia, asi que el fallo solo aparecio al migrar a la cuenta de la
# empresa (24/08/2026). Si algun dia hay que crear otro proyecto, esto vuelve a
# pasar: comprobar primero con client.models.list().
GEMINI_MODELS = [
    "gemini-3.5-flash-lite",  # mas cuota gratis; primera opcion
    "gemini-3.5-flash",       # respaldo (cuota diaria separada)
]

# Modelo de Groq (respaldo gratis, API compatible con OpenAI).
GROQ_MODEL = "llama-3.3-70b-versatile"

# User-Agent de navegador: algunas fuentes bloquean el agente por defecto.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

def google_news_rss(query, hl="es-419", gl="US", ceid="US:es-419"):
    """Crea un feed RSS de Google News para una busqueda concreta.

    Util para nichos sin RSS propio (ej. M&A en Latinoamerica): Google News
    arma un feed con los resultados de la busqueda que le pasemos.
    """
    return (
        "https://news.google.com/rss/search?q="
        + urllib.parse.quote(query)
        + f"&hl={hl}&gl={gl}&ceid={ceid}"
    )


# --- Consultas de Google News (nichos sin RSS propio) ---
# Economia e inversion en Suramerica (excluye ruido deportivo).
_SURAMERICA_QUERY = (
    '(economía OR PIB OR inversión OR "banco central" OR fiscal OR déficit OR '
    "crecimiento OR reforma OR dólar OR bonos OR exportaciones) "
    '("América del Sur" OR Suramérica OR Brasil OR Argentina OR Chile OR Colombia '
    "OR Perú OR Uruguay OR Bolivia OR Paraguay OR Ecuador) "
    "-fútbol -deportes -selección -partido"
)
# M&A en Latinoamerica (una consulta en español y otra en ingles).
_MA_QUERY_ES = (
    '("fusiones y adquisiciones" OR "adquiere" OR "adquirió" OR "compra la" OR '
    '"OPA" OR "toma el control de" OR "fusión con") (empresa OR compañía OR grupo '
    "OR banco OR petrolera OR Latinoamérica OR Sudamérica OR Brasil OR México OR "
    "Colombia OR Chile OR Argentina OR Perú)"
)
_MA_QUERY_EN = (
    '(M&A OR merger OR acquisition OR acquires) ("Latin America" OR "South America" '
    "OR Brazil OR Mexico OR Colombia OR Chile OR Argentina OR Peru)"
)

# Fuentes agrupadas por categoria (orden = prominencia). El centro es Suramerica;
# lo global/Wall Street queda al final como contexto.
SOURCES = {
    "suramerica": {
        "title": "\U0001F30E Suramerica: economia e inversion",
        "feeds": [google_news_rss(_SURAMERICA_QUERY)],
    },
    "latam_ma": {
        "title": "\U0001F91D M&A en Latinoamerica",
        "feeds": [
            google_news_rss(_MA_QUERY_ES),
            google_news_rss(_MA_QUERY_EN, hl="en-US", gl="US", ceid="US:en"),
        ],
    },
    "venezuela": {
        "title": "\U0001F1FB\U0001F1EA Economia venezolana",
        "feeds": [
            "https://www.elnacional.com/economia/feed/",
            "https://www.descifrado.com/category/economia/feed/",
        ],
    },
    "global": {
        "title": "\U0001F30D Wall Street y global (contexto)",
        "feeds": [
            "https://www.cnbc.com/id/100003114/device/rss/rss.html",
            "https://www.cnbc.com/id/20910258/device/rss/rss.html",
            "http://feeds.marketwatch.com/marketwatch/topstories/",
            "http://feeds.bbci.co.uk/news/business/rss.xml",
            "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/economia/portada",
        ],
    },
}


def lookback_hours(now_vet):
    """Ventana de tiempo segun el turno, para evitar repetir y no dejar huecos.

    - Turno manana (antes de las 13:00 VET): mira las ultimas 18h
      (cubre todo lo de la tarde/noche anterior).
    - Turno tarde: mira las ultimas 7h (cubre desde el envio de la manana).
    """
    return 18 if now_vet.hour < 13 else 7


def entry_datetime(entry):
    """Devuelve la fecha de publicacion del item como datetime UTC, o None."""
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    return datetime.fromtimestamp(time.mktime(parsed), tz=timezone.utc)


def clean_summary(raw):
    """Quita etiquetas HTML y espacios sobrantes de la descripcion del feed."""
    text = re.sub(r"<[^>]+>", " ", raw or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:400]


def fetch_category(feeds, cutoff_utc):
    """Descarga los feeds de una categoria y devuelve noticias recientes."""
    seen_titles = set()
    items = []
    for url in feeds:
        try:
            parsed = feedparser.parse(url, agent=USER_AGENT)
        except Exception as exc:  # noqa: BLE001 - una fuente caida no detiene el resto
            print(f"[warn] fallo al leer {url}: {exc}")
            continue

        for entry in parsed.entries:
            title = (entry.get("title") or "").strip()
            link = (entry.get("link") or "").strip()
            if not title or not link:
                continue

            published = entry_datetime(entry)
            # Si no hay fecha, igual lo dejamos pasar (algunos feeds no la traen).
            if published is not None and published < cutoff_utc:
                continue

            key = title.lower()
            if key in seen_titles:
                continue
            seen_titles.add(key)
            summary = clean_summary(entry.get("summary") or entry.get("description"))
            items.append((published, title, link, summary))

    # Mas recientes primero; los sin fecha al final.
    items.sort(key=lambda x: x[0] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return items[:MAX_PER_CATEGORY]


def collect_news(cutoff_utc):
    """Recopila las noticias recientes agrupadas por categoria."""
    by_category = {}
    total = 0
    for key, cat in SOURCES.items():
        items = fetch_category(cat["feeds"], cutoff_utc)
        if items:
            by_category[cat["title"]] = items
            total += len(items)
    return by_category, total


def format_news_for_prompt(by_category):
    """Arma el texto crudo de titulares + descripcion que recibe la IA."""
    blocks = []
    for title, items in by_category.items():
        lines = [f"## {title}"]
        for _published, headline, _link, summary in items:
            if summary:
                lines.append(f"- {headline} — {summary}")
            else:
                lines.append(f"- {headline}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def gemini_generate(prompt, config=None, max_retries=2):
    """Llama a Gemini con fallback automatico entre modelos.

    - Si un modelo agota su cuota diaria (429), pasa al siguiente de GEMINI_MODELS
      (cada modelo tiene su propia cuota gratis, asi multiplicamos el margen).
    - Si el error es temporal (503 'high demand', 500, timeout), reintenta con
      espera creciente en el mismo modelo y, si sigue fallando, pasa al siguiente.
    - Solo un error no recuperable (400, autenticacion, etc.) detiene todo.
    """
    client = genai.Client(api_key=GEMINI_API_KEY)
    last_exc = None
    for model in GEMINI_MODELS:
        delay = 5
        for attempt in range(1, max_retries + 1):
            try:
                return client.models.generate_content(
                    model=model, contents=prompt, config=config
                )
            except Exception as exc:  # noqa: BLE001
                msg = str(exc)
                last_exc = exc
                quota = "429" in msg or "RESOURCE_EXHAUSTED" in msg
                transient = any(
                    s in msg for s in ("503", "500", "UNAVAILABLE", "overloaded", "timeout")
                )
                if quota:
                    print(f"[warn] {model}: cuota agotada; paso al siguiente modelo")
                    break  # siguiente modelo
                if transient:
                    if attempt < max_retries:
                        print(f"[warn] {model} intento {attempt}/{max_retries} fallo; reintento en {delay}s")
                        time.sleep(delay)
                        delay *= 2
                        continue
                    print(f"[warn] {model}: sigue caido (temporal); paso al siguiente modelo")
                    break  # siguiente modelo
                raise  # error no recuperable
    raise last_exc


def groq_generate(prompt, json_mode=False):
    """Genera texto con Groq (respaldo gratis, API compatible con OpenAI)."""
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": GROQ_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.4,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    resp = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers=headers,
        json=body,
        timeout=60,
    )
    if not resp.ok:
        raise RuntimeError(f"Groq respondio {resp.status_code}: {resp.text[:200]}")
    return resp.json()["choices"][0]["message"]["content"]


def ai_generate(prompt, json_mode=False):
    """Genera texto con Gemini y, si se agota o cae del todo, con Groq de respaldo."""
    config = {"response_mime_type": "application/json"} if json_mode else None
    try:
        return gemini_generate(prompt, config=config).text
    except Exception as exc:  # noqa: BLE001
        if GROQ_API_KEY:
            print(f"[warn] Gemini no disponible ({str(exc)[:80]}); uso Groq de respaldo")
            return groq_generate(prompt, json_mode=json_mode)
        raise


def cargar_perfil(nombre):
    """Lee un perfil editorial de perfiles/<nombre>.md.

    La voz vive en un archivo y no en el codigo porque ahora hay dos productos
    con voces distintas: este bot (pragmatico y NO partidista) y el medio
    SurEconomics (linea progresista). Mismo motor, perfiles separados: cambiar
    la voz de uno no puede tocar al otro. Ademas, asi la edita quien manda en
    la voz sin abrir Python.
    """
    ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "perfiles", f"{nombre}.md")
    with open(ruta, encoding="utf-8") as f:
        return f.read()


def write_briefing(by_category, turno, fecha):
    """Le pide a Gemini que redacte el resumen en español e ingles."""
    noticias = format_news_for_prompt(by_category)

    # Sustitucion por token literal en vez de str.format(): el perfil lo editan
    # personas de edicion y una llave suelta en el texto no puede romper el bot.
    voz = (cargar_perfil("bot-telegram")
           .replace("{{turno}}", turno.lower())
           .replace("{{fecha}}", fecha))
    prompt = voz.rstrip() + f"\n\nNOTICIAS:\n{noticias}"

    return ai_generate(prompt).strip()

def build_sources_block(by_category):
    """Lista los titulares como enlaces, agrupados por categoria."""
    lines = ["<b>\U0001F517 Fuentes</b>"]
    for title, items in by_category.items():
        lines.append("")
        lines.append(f"<b>{title}</b>")
        for _published, headline, link, _summary in items:
            safe = html.escape(headline)
            lines.append(f"• <a href=\"{link}\">{safe}</a>")
    return "\n".join(lines)


def build_message(now_vet):
    cutoff_utc = datetime.now(timezone.utc) - timedelta(hours=lookback_hours(now_vet))
    turno = "Matutino" if now_vet.hour < 13 else "Vespertino"
    fecha = now_vet.strftime("%d/%m/%Y %H:%M")

    header = f"<b>\U0001F4F0 Resumen {turno}</b>  •  {fecha} (VET)"

    by_category, total = collect_news(cutoff_utc)
    if total == 0:
        return f"{header}\n\nSin novedades relevantes en esta franja horaria."

    try:
        briefing = write_briefing(by_category, turno, fecha)
    except Exception as exc:  # noqa: BLE001 - si la IA falla, igual mandamos los titulares
        print(f"[warn] no se pudo generar el resumen IA: {exc}")
        briefing = "<i>(El resumen con IA no esta disponible ahora. Te dejo los titulares.)</i>"
    sources = build_sources_block(by_category)
    return f"{header}\n\n{briefing}\n\n{sources}"


def send_message(text):
    """Envia el mensaje a Telegram, partiendolo si supera el limite de 4096."""
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    limit = 4000  # margen por debajo del limite real (4096)

    chunks = []
    while len(text) > limit:
        split_at = text.rfind("\n", 0, limit)
        if split_at == -1:
            split_at = limit
        chunks.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    chunks.append(text)

    for chat_id in CHAT_IDS:
        for chunk in chunks:
            try:
                resp = requests.post(
                    url,
                    data={
                        "chat_id": chat_id,
                        "text": chunk,
                        "parse_mode": "HTML",
                        "disable_web_page_preview": "true",
                    },
                    timeout=30,
                )
                if not resp.ok:
                    # Un destinatario caido (ej. bloqueo al bot) no detiene a los demas.
                    print(f"[warn] fallo enviar a {chat_id}: {resp.status_code} {resp.text[:120]}")
                    break
                print(f"[ok] {chat_id}: bloque de {len(chunk)} caracteres")
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] error enviando a {chat_id}: {exc}")
                break


def main():
    if not TELEGRAM_TOKEN or not CHAT_ID:
        raise SystemExit(
            "Faltan TELEGRAM_TOKEN o CHAT_ID. Definelos en un archivo .env "
            "(local) o como secrets en GitHub Actions."
        )
    if not GEMINI_API_KEY:
        raise SystemExit(
            "Falta GEMINI_API_KEY. Obten una gratis en aistudio.google.com y "
            "definela en .env (local) o como secret en GitHub Actions."
        )

    now_vet = datetime.now(VET)
    message = build_message(now_vet)
    send_message(message)


if __name__ == "__main__":
    main()
