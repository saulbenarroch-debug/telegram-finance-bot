# -*- coding: utf-8 -*-
"""
Al Cierre - Envia las 4 laminas del dia por Telegram (album).
Reutiliza TELEGRAM_TOKEN y CHAT_ID del .env del bot de noticias.
Uso: py send_telegram.py [ruta_carpeta_png]   (por defecto out/<hoy>)
"""
import sys
from datetime import date
from pathlib import Path

import requests

BASE = Path(__file__).parent
ENV_FILE = Path(r"C:\Users\saulb\telegram-finance-bot\.env")


def load_env():
    """Credenciales: variables de entorno (GitHub Actions) o .env del bot (local)."""
    import os

    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    for key in ("TELEGRAM_TOKEN", "CHAT_ID"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


def send_album(token, chat_id, pngs, caption):
    media = []
    files = {}
    for i, png in enumerate(pngs):
        key = f"photo{i}"
        files[key] = (png.name, png.read_bytes(), "image/png")
        item = {"type": "photo", "media": f"attach://{key}"}
        if i == 0:
            item["caption"] = caption
        media.append(item)
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendMediaGroup",
        data={"chat_id": chat_id, "media": __import__("json").dumps(media)},
        files=files,
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


def send_text(token, chat_id, text):
    requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data={"chat_id": chat_id, "text": text},
        timeout=30,
    )


def main():
    env = load_env()
    token = env["TELEGRAM_TOKEN"]
    chat_ids = [c.strip() for c in env["CHAT_ID"].split(",") if c.strip()]

    today = date.today()
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE / "out" / today.isoformat()
    pngs = sorted(folder.glob("*.png"))
    if len(pngs) != 4:
        raise SystemExit(f"Se esperaban 4 PNG en {folder}, hay {len(pngs)}")

    caption = f"📊 Al Cierre — {today.day}/{today.month:02d}/{today.year}"
    for chat_id in chat_ids:
        send_album(token, chat_id, pngs, caption)
        print(f"Enviado a {chat_id}")


if __name__ == "__main__":
    main()
