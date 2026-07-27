# -*- coding: utf-8 -*-
"""
Envia las laminas de "Entorno en Vinetas" del dia como album de fotos a los
chats del bot. Usa el .env del repo (o las variables de entorno en Actions).
Uso: py send_telegram.py [AAAA-MM-DD]
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date
from pathlib import Path

BASE = Path(__file__).parent
OUT = BASE / "out"
ORDEN = ["1-portada", "2-noticia", "3-cifras", "4-latam"]


def load_env():
    env = {}
    p = BASE.parent / ".env"
    if p.exists():
        for linea in p.read_text(encoding="utf-8-sig").splitlines():
            if "=" in linea and not linea.strip().startswith("#"):
                k, v = linea.split("=", 1)
                env[k.strip()] = v.strip()
    for k in ("TELEGRAM_TOKEN", "CHAT_ID"):
        if os.environ.get(k):
            env[k] = os.environ[k].strip()
    for k in ("TELEGRAM_TOKEN", "CHAT_ID"):
        if not env.get(k):
            raise SystemExit(f"falta {k} (.env o variable de entorno)")
    return env


def post_multipart(url, campos, archivos):
    """multipart/form-data a mano: sin dependencias, igual que en al-cierre."""
    lim = "----------" + uuid.uuid4().hex
    cuerpo = b""
    for k, v in campos.items():
        cuerpo += (f"--{lim}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                   f"{v}\r\n").encode("utf-8")
    for nombre, ruta in archivos.items():
        cuerpo += (f"--{lim}\r\nContent-Disposition: form-data; name=\"{nombre}\"; "
                   f"filename=\"{ruta.name}\"\r\nContent-Type: image/png\r\n\r\n").encode("utf-8")
        cuerpo += ruta.read_bytes() + b"\r\n"
    cuerpo += f"--{lim}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        url, data=cuerpo,
        headers={"Content-Type": f"multipart/form-data; boundary={lim}"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def enviar(token, chat, laminas, pie):
    media, archivos = [], {}
    for i, ruta in enumerate(laminas):
        clave = f"foto{i}"
        item = {"type": "photo", "media": f"attach://{clave}"}
        if i == 0:
            item["caption"] = pie
        media.append(item)
        archivos[clave] = ruta
    return post_multipart(
        f"https://api.telegram.org/bot{token}/sendMediaGroup",
        {"chat_id": chat, "media": json.dumps(media, ensure_ascii=False)},
        archivos,
    )


def main():
    env = load_env()
    fecha = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
    dest = OUT / fecha
    laminas = [dest / f"{n}.png" for n in ORDEN if (dest / f"{n}.png").exists()]
    if not laminas:
        raise SystemExit(f"no hay laminas en {dest}; corre primero render.py")

    pie = f"📰 Entorno en Viñetas — resumen semanal ({fecha})"
    fallos = 0
    for chat in [c.strip() for c in env["CHAT_ID"].split(",") if c.strip()]:
        try:
            r = enviar(env["TELEGRAM_TOKEN"], chat, laminas, pie)
            print("OK  chat", chat, "->", len(r.get("result", [])), "fotos")
        except urllib.error.HTTPError as e:
            fallos += 1
            print("ERR chat", chat, e.code, e.read()[:300])
        except Exception as e:
            fallos += 1
            print("ERR chat", chat, e)
    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
