# -*- coding: utf-8 -*-
"""
Envia las laminas de "Entorno en Vinetas" del dia como album de fotos a los
chats del bot. Usa el .env del repo (o las variables de entorno en Actions).
Uso: py send_telegram.py [AAAA-MM-DD] [--con-texto]

--con-texto manda antes el texto de la edicion (edicion.json, que deja
render.py). Se usa cuando la edicion se armo en frio desde Actions: el chat no
la tenia en cache, asi que no mando nada, y el texto tiene que salir de aqui.
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
# EL ORDEN LO DA EL NUMERO DEL NOMBRE, no una lista fija. Con la plantilla de
# septiembre de 2026 son ocho laminas (1-portada ... 8-latam), pero una edicion
# con menos noticias trae menos; con la lista fija, cualquier nombre nuevo se
# quedaba sin enviar sin que nada avisara.
def ordenadas(dest):
    return sorted(dest.glob("[0-9]*-*.png"), key=lambda p: int(p.name.split("-")[0]))


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


def enviar_texto(token, chat, partes):
    """El texto de la edicion, una parte por mensaje y en HTML, como lo manda
    el Worker (sendHtml). Una parte que falle no corta las demas."""
    for p in partes:
        cuerpo = json.dumps({"chat_id": chat, "text": p, "parse_mode": "HTML",
                             "disable_web_page_preview": True}).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage", data=cuerpo,
            headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            print("ERR texto chat", chat, e.code, e.read()[:200])


def main():
    env = load_env()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    con_texto = "--con-texto" in sys.argv
    if args:
        dest = OUT / args[0]
    else:
        # La carpeta la nombra render.py con la fecha DE LA EDICION, que no es
        # la de hoy si se sirvio una de cache: se coge la mas reciente.
        carpetas = sorted(p for p in OUT.glob("20*") if p.is_dir())
        dest = carpetas[-1] if carpetas else OUT / date.today().isoformat()
    fecha = dest.name
    laminas = ordenadas(dest)
    if not laminas:
        raise SystemExit(f"no hay laminas en {dest}; corre primero render.py")

    pie = f"📰 Entorno en Viñetas — resumen semanal ({fecha})"
    fallos = 0
    for chat in [c.strip() for c in env["CHAT_ID"].split(",") if c.strip()]:
        if con_texto and (dest / "edicion.json").exists():
            partes = json.loads((dest / "edicion.json").read_text(encoding="utf-8")).get("parts") or []
            enviar_texto(env["TELEGRAM_TOKEN"], chat, partes)
            print("OK  chat", chat, "->", len(partes), "mensajes de texto")
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
