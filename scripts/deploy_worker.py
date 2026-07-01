"""Despliega/actualiza el bot conversacional (Cloudflare Worker) por la API.

Reutilizable: cada vez que edites cloudflare-worker/worker.js, corre este script
para actualizarlo. Es idempotente (crea el KV y el WEBHOOK_SECRET solo una vez).

Lee de .env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_TOKEN,
GEMINI_API_KEY, GROQ_API_KEY, y WEBHOOK_SECRET (se genera y guarda si falta).
"""

import json
import os
import secrets

import requests
from dotenv import load_dotenv

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BASE, ".env")
WORKER_JS = os.path.join(BASE, "cloudflare-worker", "worker.js")
NAME = "sureconomics-bot"
KV_TITLE = "sureconomics-kv"
CRON = "0 */3 * * *"  # cada 3 horas: ingiere noticias al historial

load_dotenv(ENV_PATH)
CF_TOKEN = os.environ["CLOUDFLARE_API_TOKEN"].strip()
CF_ACCT = os.environ["CLOUDFLARE_ACCOUNT_ID"].strip()
TG = os.environ["TELEGRAM_TOKEN"].strip()
GEM = os.environ.get("GEMINI_API_KEY", "").strip()
GROQ = os.environ.get("GROQ_API_KEY", "").strip()

API = "https://api.cloudflare.com/client/v4"
H = {"Authorization": f"Bearer {CF_TOKEN}"}


def main():
    # WEBHOOK_SECRET: reutiliza el de .env o crea uno y lo guarda.
    wh = os.environ.get("WEBHOOK_SECRET", "").strip()
    if not wh:
        wh = secrets.token_hex(16)
        with open(ENV_PATH, "a", encoding="utf-8") as f:
            f.write(f"\nWEBHOOK_SECRET={wh}\n")
        print("[ok] WEBHOOK_SECRET generado y guardado en .env")

    # KV namespace: reutiliza si existe, si no lo crea.
    r = requests.get(
        f"{API}/accounts/{CF_ACCT}/storage/kv/namespaces?per_page=100", headers=H, timeout=30
    )
    kv_id = None
    for ns in r.json().get("result") or []:
        if ns.get("title") == KV_TITLE:
            kv_id = ns.get("id")
            break
    if not kv_id:
        r = requests.post(
            f"{API}/accounts/{CF_ACCT}/storage/kv/namespaces",
            headers=H,
            json={"title": KV_TITLE},
            timeout=30,
        )
        kv_id = (r.json().get("result") or {}).get("id")
        print("[ok] KV creado:", bool(kv_id))
    print("[ok] KV listo")

    # Subdominio de la cuenta.
    r = requests.get(f"{API}/accounts/{CF_ACCT}/workers/subdomain", headers=H, timeout=30)
    sub = (r.json().get("result") or {}).get("subdomain")

    # Subir el Worker con secretos + binding de KV.
    script = open(WORKER_JS, encoding="utf-8").read()
    meta = {
        "main_module": "worker.js",
        "compatibility_date": "2024-11-01",
        "bindings": [
            {"type": "secret_text", "name": "TELEGRAM_TOKEN", "text": TG},
            {"type": "secret_text", "name": "GEMINI_API_KEY", "text": GEM},
            {"type": "secret_text", "name": "GROQ_API_KEY", "text": GROQ},
            {"type": "secret_text", "name": "WEBHOOK_SECRET", "text": wh},
            {"type": "kv_namespace", "name": "KV", "namespace_id": kv_id},
        ],
    }
    r = requests.put(
        f"{API}/accounts/{CF_ACCT}/workers/scripts/{NAME}",
        headers=H,
        data={"metadata": json.dumps(meta)},
        files={"worker.js": ("worker.js", script, "application/javascript+module")},
        timeout=60,
    )
    print("[ok] subir worker:", r.status_code, r.json().get("success"), str(r.json().get("errors"))[:200])

    # Activar la URL publica.
    requests.post(
        f"{API}/accounts/{CF_ACCT}/workers/scripts/{NAME}/subdomain",
        headers=H,
        json={"enabled": True},
        timeout=30,
    )

    # Cron para ingerir noticias.
    r = requests.put(
        f"{API}/accounts/{CF_ACCT}/workers/scripts/{NAME}/schedules",
        headers=H,
        json=[{"cron": CRON}],
        timeout=30,
    )
    print("[ok] cron:", r.status_code, r.json().get("success"))

    # Webhook de Telegram.
    url = f"https://{NAME}.{sub}.workers.dev"
    r = requests.post(
        f"https://api.telegram.org/bot{TG}/setWebhook",
        json={"url": url, "secret_token": wh, "drop_pending_updates": True},
        timeout=30,
    )
    print("[ok] setWebhook:", r.status_code, r.json().get("ok"))
    print("URL:", url)
    return url, wh


if __name__ == "__main__":
    main()
