"""Alerta de noticias economicas de alto impacto para Telegram.

Corre cada hora via GitHub Actions. Revisa las noticias de la ultima hora,
le pide a Gemini que identifique SOLO eventos realmente grandes (crash o
desplome de mercados, default, sanciones, devaluacion, cambios de politica
monetaria de gran calado, etc.) y, si hay alguno nuevo, envia una alerta.
Guarda en breaking_state.json los enlaces ya avisados para no repetir.
"""

import html
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from google import genai

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot

# Archivo de estado: enlaces ya avisados (se versiona en el repo en GitHub).
STATE_FILE = "breaking_state.json"

# Ventana de revision. Algo mayor a 60 min para solapar y no dejar huecos;
# la deduplicacion por enlace evita repetir.
LOOKBACK_MINUTES = 70

# Cuantos enlaces recordar como maximo (para que el archivo no crezca infinito).
MAX_REMEMBERED = 500


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f).get("alerted_links", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_state(links):
    trimmed = links[-MAX_REMEMBERED:]
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"alerted_links": trimmed}, f, ensure_ascii=False, indent=2)


def gather_candidates(cutoff_utc, already):
    """Noticias recientes que aun no se han avisado."""
    by_category, _ = bot.collect_news(cutoff_utc)
    candidates = []
    for title, items in by_category.items():
        for _published, headline, link, summary in items:
            if link in already:
                continue
            candidates.append(
                {"category": title, "headline": headline, "link": link, "summary": summary}
            )
    return candidates


def classify_high_impact(candidates):
    """Pide a Gemini que devuelva SOLO los titulares de alto impacto."""
    client = genai.Client(api_key=bot.GEMINI_API_KEY)
    listado = "\n".join(
        f"{i}. [{c['category']}] {c['headline']} — {c['summary']}"
        for i, c in enumerate(candidates)
    )
    prompt = (
        "Eres un analista financiero. De la siguiente lista de titulares, "
        "identifica SOLO los de ALTO IMPACTO economico/financiero: eventos "
        "realmente grandes como crash o desplome de mercados, default de deuda, "
        "sanciones economicas relevantes, devaluacion o cambios cambiarios "
        "fuertes, decisiones de politica monetaria de gran calado, quiebras "
        "sistemicas o medidas economicas de gobierno de gran alcance. "
        "Ignora noticias rutinarias, de opinion o de impacto menor. "
        "Se MUY exigente: si dudas, NO lo incluyas.\n\n"
        "Responde SOLO un JSON con esta forma: "
        '{"alertas": [{"indice": <numero>, "motivo": "<frase corta en español>"}]}. '
        'Si no hay ninguna de alto impacto, responde {"alertas": []}.\n\n'
        f"TITULARES:\n{listado}"
    )
    resp = client.models.generate_content(
        model=bot.GEMINI_MODEL,
        contents=prompt,
        config={"response_mime_type": "application/json"},
    )
    try:
        return json.loads(resp.text).get("alertas", [])
    except json.JSONDecodeError:
        print("[warn] la IA no devolvio JSON valido; se omite esta corrida")
        return []


def main():
    if not bot.TELEGRAM_TOKEN or not bot.CHAT_ID:
        raise SystemExit("Faltan TELEGRAM_TOKEN o CHAT_ID.")
    if not bot.GEMINI_API_KEY:
        raise SystemExit("Falta GEMINI_API_KEY.")

    already = load_state()
    cutoff_utc = datetime.now(timezone.utc) - timedelta(minutes=LOOKBACK_MINUTES)
    candidates = gather_candidates(cutoff_utc, already)
    if not candidates:
        print("[ok] sin noticias nuevas que evaluar")
        return

    alertas = classify_high_impact(candidates)
    if not alertas:
        print("[ok] nada de alto impacto en esta corrida")
        return

    fecha = datetime.now(bot.VET).strftime("%d/%m/%Y %H:%M")
    lines = [f"<b>\U0001F6A8 ALERTA — Noticia de alto impacto</b>  •  {fecha} (VET)", ""]
    new_links = []
    for a in alertas:
        idx = a.get("indice")
        if not isinstance(idx, int) or not (0 <= idx < len(candidates)):
            continue
        c = candidates[idx]
        safe = html.escape(c["headline"])
        lines.append(f"• <a href=\"{c['link']}\">{safe}</a>")
        motivo = (a.get("motivo") or "").strip()
        if motivo:
            lines.append(f"  <i>{html.escape(motivo)}</i>")
        new_links.append(c["link"])

    if not new_links:
        print("[ok] nada de alto impacto valido")
        return

    bot.send_message("\n".join(lines))
    save_state(already + new_links)
    print(f"[ok] alerta enviada con {len(new_links)} noticia(s)")


if __name__ == "__main__":
    main()
