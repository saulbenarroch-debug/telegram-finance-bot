# -*- coding: utf-8 -*-
"""
Al Cierre - Flujo diario completo: datos -> laminas -> Telegram.
Pensado para la tarea programada de las 5:30 pm.
Si algo falla, avisa por Telegram en vez de quedarse callado.
"""
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).parent
LOG = BASE / "daily.log"


def log(msg):
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {msg}"
    print(line)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def run(script):
    r = subprocess.run(
        [sys.executable, str(BASE / script)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=600,
    )
    log(f"{script} -> exit {r.returncode}")
    if r.stdout:
        log(r.stdout.strip())
    if r.returncode != 0:
        raise RuntimeError(f"{script} fallo (exit {r.returncode}):\n{r.stderr[-800:]}")
    return r


def alert(text):
    """Aviso de error por Telegram al primer chat configurado."""
    try:
        sys.path.insert(0, str(BASE))
        from send_telegram import load_env, send_text
        env = load_env()
        chat = env["CHAT_ID"].split(",")[0].strip()
        send_text(env["TELEGRAM_TOKEN"], chat, f"⚠️ Al Cierre fallo hoy:\n{text[:3500]}")
    except Exception:
        log("no se pudo enviar la alerta por Telegram")


def main():
    log("=== inicio flujo Al Cierre ===")
    try:
        # fetch_data devuelve exit 1 si algun valor fallo, pero data.json
        # queda escrito; seguimos y avisamos al final.
        fetch_warn = None
        try:
            run("fetch_data.py")
        except RuntimeError as e:
            fetch_warn = str(e)
            log("fetch con errores parciales; se continua con lo disponible")

        run("render.py")
        run("send_telegram.py")

        if fetch_warn:
            alert("Las laminas se enviaron, pero algunos valores fallaron:\n" + fetch_warn)
        log("=== fin OK ===")
    except Exception as e:
        log("ERROR: " + str(e))
        log(traceback.format_exc())
        alert(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
