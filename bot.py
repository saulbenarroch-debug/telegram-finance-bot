"""Bot de noticias financieras y economicas para Telegram.

Lee varias fuentes RSS, filtra las noticias recientes y le pide a Gemini que
redacte un resumen (briefing) en español e ingles, y lo envia a un chat de
Telegram. Pensado para correr dos veces al dia (10:00 y 16:00 hora Venezuela)
via GitHub Actions o el Programador de tareas de Windows.
"""

import html
import os
import re
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import feedparser
import requests
from dotenv import load_dotenv
from google import genai

load_dotenv()

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
CHAT_ID = os.environ.get("CHAT_ID", "").strip()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()

# Hora de Venezuela = UTC-4 (no usa horario de verano).
VET = timezone(timedelta(hours=-4))

# Maximo de titulares por categoria que se le pasan a la IA.
MAX_PER_CATEGORY = 8

# Modelo de Gemini. "flash" es rapido y entra en la capa gratuita.
GEMINI_MODEL = "gemini-2.5-flash"

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


# Consultas para el feed de M&A en Latinoamerica (una en español, una en ingles).
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

# Fuentes agrupadas por categoria. Cada categoria tiene un titulo (con emoji)
# y una lista de feeds RSS verificados.
SOURCES = {
    "wall_street": {
        "title": "\U0001F1FA\U0001F1F8 Wall Street / Mercados USA",
        "feeds": [
            "https://www.cnbc.com/id/100003114/device/rss/rss.html",
            "https://www.cnbc.com/id/20910258/device/rss/rss.html",
            "http://feeds.marketwatch.com/marketwatch/topstories/",
            "https://finance.yahoo.com/news/rssindex",
        ],
    },
    "global": {
        "title": "\U0001F30D Economia global",
        "feeds": [
            "http://feeds.bbci.co.uk/news/business/rss.xml",
            "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/economia/portada",
        ],
    },
    "venezuela": {
        "title": "\U0001F1FB\U0001F1EA Economia venezolana",
        "feeds": [
            "https://www.elnacional.com/economia/feed/",
            "https://www.descifrado.com/category/economia/feed/",
        ],
    },
    "latam_ma": {
        "title": "\U0001F91D M&A en Latinoamerica",
        "feeds": [
            google_news_rss(_MA_QUERY_ES),
            google_news_rss(_MA_QUERY_EN, hl="en-US", gl="US", ceid="US:en"),
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


def gemini_generate(prompt, config=None, max_retries=4):
    """Llama a Gemini reintentando ante errores temporales (503/429/500).

    Google a veces devuelve 503 ('high demand') de forma pasajera. En vez de
    caernos al primer intento, reintentamos con espera creciente.
    """
    client = genai.Client(api_key=GEMINI_API_KEY)
    delay = 5
    for attempt in range(1, max_retries + 1):
        try:
            return client.models.generate_content(
                model=GEMINI_MODEL, contents=prompt, config=config
            )
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            transient = any(
                s in msg for s in ("503", "429", "500", "UNAVAILABLE", "overloaded", "timeout")
            )
            if attempt < max_retries and transient:
                print(f"[warn] Gemini intento {attempt}/{max_retries} fallo; reintento en {delay}s")
                time.sleep(delay)
                delay *= 2
                continue
            raise


def write_briefing(by_category, turno, fecha):
    """Le pide a Gemini que redacte el resumen en español e ingles."""
    noticias = format_news_for_prompt(by_category)

    prompt = (
        "Eres un analista financiero que escribe para Sureconomics, un servicio "
        "que promueve la inversión en el sur, especialmente en Suramérica. Con "
        f"estos titulares (resumen {turno.lower()} del {fecha}, hora Venezuela), "
        "redacta un briefing breve y claro para un lector general.\n\n"
        "Instrucciones:\n"
        "- Escribe primero la versión en ESPAÑOL y luego la versión en INGLÉS, "
        "separadas por una línea con '———'.\n"
        "- Organiza cada versión en las mismas secciones que las noticias "
        "(Wall Street / Mercados USA, Economía global, Economía venezolana, "
        "M&A en Latinoamérica). Omite una sección si no tiene noticias.\n"
        "- En la sección de M&A, enfócate en operaciones corporativas reales "
        "(fusiones, adquisiciones, OPAs) en Latinoamérica; ignora compras no "
        "empresariales. Cuando sea pertinente, resalta con sobriedad las "
        "oportunidades y señales positivas de inversión en la región, SIN "
        "exagerar ni inventar.\n"
        "- 2 a 4 frases por sección, sintetizando lo importante; no inventes "
        "datos que no estén en los titulares ni cites cifras inexistentes.\n"
        "- Tono profesional y directo. Sin enlaces ni markdown de encabezados.\n"
        "- Usa <b>texto</b> de HTML para los títulos de sección (Telegram lo "
        "renderiza). No uses asteriscos ni '#'.\n\n"
        f"NOTICIAS:\n{noticias}"
    )

    resp = gemini_generate(prompt)
    return resp.text.strip()


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

    for chunk in chunks:
        resp = requests.post(
            url,
            data={
                "chat_id": CHAT_ID,
                "text": chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": "true",
            },
            timeout=30,
        )
        if not resp.ok:
            raise RuntimeError(f"Telegram respondio {resp.status_code}: {resp.text}")
        print(f"[ok] enviado bloque de {len(chunk)} caracteres")


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
