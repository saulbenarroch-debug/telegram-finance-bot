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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot

# Archivo de estado: enlaces ya avisados (se versiona en el repo en GitHub).
STATE_FILE = "breaking_state.json"

# Ventana de revision. Algo mayor a 60 min para solapar y no dejar huecos;
# la deduplicacion por enlace evita repetir.
LOOKBACK_MINUTES = 70

# Cuantos enlaces recordar como maximo (para que el archivo no crezca infinito).
MAX_REMEMBERED = 500

# Filtro barato previo: solo llamamos a la IA (que consume cuota) si algun titular
# contiene una senal fuerte de alto impacto. Asi la mayoria de las horas tranquilas
# NO gastan cuota de Gemini. Debe ser en minusculas.
HIGH_IMPACT_KEYWORDS = [
    # español
    "desplome", "desploma", "se hunde", "se hunden", "colapso", "colapsa", "crac",
    "quiebra", "bancarrota", "insolvencia", "default", "cesación de pagos", "impago",
    "sanciones", "sancion", "embargo", "devaluación", "devalúa", "maxidevaluación",
    "hiperinflación", "recesión", "rescate", "expropia", "expropiación", "nacionaliza",
    "sube las tasas", "baja las tasas", "recorta las tasas", "sube tasas", "recorta tasas",
    "congela", "corralito", "moratoria", "rebaja de calificación",
    # ingles
    "crash", "plunge", "plummet", "collapse", "sinks", "tumbles", "bankruptcy",
    "insolvency", "sanctions", "embargo", "devaluation", "hyperinflation", "recession",
    "bailout", "rate hike", "rate cut", "raises rates", "cuts rates", "nationalizes",
    "expropriat", "downgrade", "default",
    # M&A grande
    "miles de millones", "mil millones", "billion", "mega fusión", "megafusión",
]


def has_high_impact_signal(candidates):
    """True si algun titular/resumen contiene una palabra clave de alto impacto."""
    blob = " ".join(
        (c["headline"] + " " + (c["summary"] or "")).lower() for c in candidates
    )
    return any(kw in blob for kw in HIGH_IMPACT_KEYWORDS)


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
    listado = "\n".join(
        f"{i}. [{c['category']}] {c['headline']} — {c['summary']}"
        for i, c in enumerate(candidates)
    )
    prompt = (
        "Eres un editor financiero MUY exigente. De la lista de titulares, marca "
        "SOLO los que merecen interrumpir el dia de alguien con una alerta urgente. "
        "El umbral es altisimo: la mayoria de los dias la respuesta correcta es que "
        "NO hay ninguno.\n\n"
        "SI alerta (eventos grandes y consumados, no rumores ni expectativas):\n"
        "- Crash o desplome fuerte de un mercado importante (caida brusca de varios %).\n"
        "- Default o reestructuracion de deuda soberana o de una gran empresa.\n"
        "- Sanciones economicas importantes nuevas (o su levantamiento).\n"
        "- Devaluacion o salto cambiario fuerte (sobre todo del bolivar venezolano).\n"
        "- Decision YA TOMADA de cambio de tasas de un banco central importante (Fed, BCE).\n"
        "- Quiebra de una institucion sistemica o un shock geopolitico que mueva mercados.\n"
        "- Operacion de M&A (fusion/adquisicion) MUY grande en Suramerica (miles de millones o "
        "que redefina un sector).\n\n"
        "NO alerta (esto es ruido, IGNORALO):\n"
        "- Reportes rutinarios de precios ('petroleo hoy', 'el dolar cotiza a...').\n"
        "- Datos economicos menores, informes, encuestas, previsiones o expectativas.\n"
        "- Articulos de opinion, analisis, 'lo que significa para ti', consejos.\n"
        "- Movimientos pequenos o normales de mercado; anticipos de algo que aun no pasa.\n\n"
        "Regla de oro: ante la MINIMA duda, NO lo incluyas. Es mejor no alertar de "
        "algo mediano que alertar de mas.\n\n"
        "Responde SOLO un JSON con esta forma: "
        '{"alertas": [{"indice": <numero>, "motivo": "<frase corta en español>"}]}. '
        'Si no hay ninguna verdaderamente grande, responde {"alertas": []}.\n\n'
        f"TITULARES:\n{listado}"
    )
    resp = bot.gemini_generate(prompt, config={"response_mime_type": "application/json"})
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

    # Filtro barato: si no hay ninguna senal fuerte, ni siquiera llamamos a la IA
    # (asi no gastamos cuota de Gemini en horas tranquilas).
    if not has_high_impact_signal(candidates):
        print("[ok] sin senales de alto impacto; no se consulta a la IA")
        return

    try:
        alertas = classify_high_impact(candidates)
    except Exception as exc:  # noqa: BLE001 - si Gemini esta caido, omitir sin fallar
        print(f"[warn] Gemini no disponible ({exc}); se omite esta corrida")
        return
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
