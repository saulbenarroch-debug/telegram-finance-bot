"""Descubre tu CHAT_ID de Telegram.

Pasos:
 1. Abre Telegram y escribele cualquier mensaje a tu bot (ej: "hola").
 2. Ejecuta:  python get_chat_id.py
 3. Copia el chat_id que aparece y ponlo en tu archivo .env
"""

import os

import requests
from dotenv import load_dotenv

load_dotenv()

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()


def main():
    if not TELEGRAM_TOKEN:
        raise SystemExit("Define TELEGRAM_TOKEN en tu archivo .env primero.")

    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
    resp = requests.get(url, timeout=30)
    data = resp.json()

    if not data.get("ok"):
        raise SystemExit(f"Telegram respondio con error: {data}")

    updates = data.get("result", [])
    if not updates:
        print(
            "No hay mensajes todavia. Escribele algo a tu bot en Telegram "
            "y vuelve a ejecutar este script."
        )
        return

    vistos = {}
    for upd in updates:
        msg = upd.get("message") or upd.get("channel_post") or {}
        chat = msg.get("chat", {})
        chat_id = chat.get("id")
        if chat_id is None:
            continue
        nombre = chat.get("title") or chat.get("first_name") or chat.get("username") or "?"
        vistos[chat_id] = nombre

    if not vistos:
        print("No se encontro ningun chat. Escribele a tu bot e intenta de nuevo.")
        return

    print("Chats encontrados:")
    for chat_id, nombre in vistos.items():
        print(f"  CHAT_ID = {chat_id}   ({nombre})")


if __name__ == "__main__":
    main()
