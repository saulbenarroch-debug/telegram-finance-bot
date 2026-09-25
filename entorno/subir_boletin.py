# -*- coding: utf-8 -*-
"""
Sube el Entorno en Vinetas al BOLETIN del sitio y lo deja ACTIVO: el lunes sale
solo, por correo, a toda la lista de suscriptores.

Uso:
  py subir_boletin.py <carpeta-con-las-laminas> [--chat 123] [--prueba]

Lo dispara el boton "Subir al boletin" que send_telegram.py pone debajo del
album de laminas (via el Worker y boletin.yml). Nadie lo corre a mano salvo
para probar, y para eso esta --prueba: sube y deja el numero en BORRADOR.

EL BOLETIN DEL PANEL ES OTRA COSA QUE LAS PIEZAS. No es un formato de post: son
NUMEROS, uno por lunes, y cada numero es una lista de PAGINAS, que son imagenes
("las que disenaron en Canva, en el orden en que se leen"). El correo las manda
una debajo de otra. Estados: draft (no sale), ready ("Activo": el lunes a las
9:00 sale solo), sending, sent. La API se saco del propio panel el 25/09/2026:
  GET  /admin/boletin/lunes                  los lunes y el numero de cada uno
  POST /admin/boletin/numeros                {send_on, subject}
  POST /admin/boletin/numeros/{id}/paginas   {media_id}
  PATCH /admin/boletin/numeros/{id}          {status, cover_media_id, preheader}
  POST /admin/media/image                    la imagen, en multipart

POR QUE ACTIVO Y NO BORRADOR, al reves que todo lo del motor: lo pidio el dueno
("no como borrador") y aqui SI hay una persona decidiendo, la que toca el boton
despues de ver el album. Lo que NO se hace es "Enviar ahora", que el panel
tambien permite: sale en el acto a la lista real y no se puede deshacer. Activo
deja hasta el lunes para arrepentirse: basta con volverlo a borrador en el panel.

NO SE PISA NADA. El equipo crea los numeros de antemano (vacios, en borrador).
Si el del proximo lunes esta vacio, se rellena. Si ya tiene paginas, es que
alguien lo monto: no se toca y se avisa. Si ya esta activo o enviado, tampoco.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = (os.environ.get("SURECONOMICS_API", "").strip()
        or "https://sureconomics-backend.onrender.com").rstrip("/")
# El panel pide "unos 1080 px de ancho": las laminas salen a 1414 y en el correo
# van a lo ancho del mensaje. Reducidas pesan un tercio y el correo carga antes.
ANCHO_CORREO = 1080
ORDEN = re.compile(r"^(\d+)-")


class Panel:
    """Lo minimo para hablar con el panel. Es el mismo protocolo que
    subir.Panel en el repo del medio: login con la cuenta de servicio, token
    Bearer y un reintento si caduca a mitad de camino."""

    def __init__(self):
        self.usuario = os.environ.get("SURECONOMICS_USUARIO", "").strip()
        self.clave = os.environ.get("SURECONOMICS_CLAVE", "")
        if not self.usuario or not self.clave:
            raise SystemExit("Faltan SURECONOMICS_USUARIO y SURECONOMICS_CLAVE (secretos del repo).")
        self.token = None
        self.entrar()

    def entrar(self):
        r = self._crudo("/auth/login", "POST", {"email": self.usuario, "password": self.clave}, token=False)
        d = r.get("data", r)
        self.token = d.get("access_token") or d.get("token")
        if not self.token:
            raise SystemExit("El login del panel respondio sin token.")

    def _crudo(self, ruta, metodo="GET", cuerpo=None, token=True, datos=None, tipo=None):
        cab = {"User-Agent": "EntornoBoletin/1.0"}
        if datos is None and cuerpo is not None:
            datos = json.dumps(cuerpo).encode()
            cab["Content-Type"] = "application/json"
        if tipo:
            cab["Content-Type"] = tipo
        if token and self.token:
            cab["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(BASE + ruta, data=datos, method=metodo, headers=cab)
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode() or "{}")

    def llamar(self, ruta, metodo="GET", cuerpo=None, **kw):
        try:
            r = self._crudo(ruta, metodo, cuerpo, **kw)
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise SystemExit("HTTP %s en %s %s: %s" % (e.code, metodo, ruta, e.read().decode()[:300]))
            self.entrar()
            r = self._crudo(ruta, metodo, cuerpo, **kw)
        return r.get("data", r)

    def subir_imagen(self, ruta):
        limite = "----" + uuid.uuid4().hex
        tipo = "image/jpeg" if ruta.suffix.lower() in (".jpg", ".jpeg") else "image/png"
        cuerpo = (("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                   "Content-Type: %s\r\n\r\n") % (limite, ruta.name, tipo)).encode()
        cuerpo += ruta.read_bytes() + ("\r\n--%s--\r\n" % limite).encode()
        return self.llamar("/admin/media/image", "POST", datos=cuerpo,
                           tipo="multipart/form-data; boundary=" + limite)


def laminas_de(carpeta):
    """Las laminas en orden de lectura (1-portada ... 8-latam), donde esten.

    El artefacto de Actions las trae dentro de una carpeta con la fecha de la
    edicion, asi que se buscan en profundidad y se ordenan por su numero.
    """
    pngs = [p for p in Path(carpeta).rglob("*.png") if ORDEN.match(p.name)]
    return sorted(pngs, key=lambda p: int(ORDEN.match(p.name).group(1)))


def para_correo(ruta):
    """La lamina a 1080 px en JPG, si Pillow esta; si no, la original tal cual."""
    try:
        from PIL import Image
    except ImportError:
        return ruta
    im = Image.open(ruta).convert("RGB")
    if im.width > ANCHO_CORREO:
        im = im.resize((ANCHO_CORREO, round(im.height * ANCHO_CORREO / im.width)), Image.LANCZOS)
    salida = ruta.with_suffix(".correo.jpg")
    im.save(salida, "JPEG", quality=88, optimize=True, progressive=True)
    return salida


def avisar(chat, texto):
    token = os.environ.get("TELEGRAM_TOKEN", "").strip()
    if not (token and chat):
        print(texto)
        return
    cuerpo = json.dumps({"chat_id": chat, "text": texto, "parse_mode": "HTML",
                         "disable_web_page_preview": True}).encode()
    try:
        urllib.request.urlopen(urllib.request.Request(
            "https://api.telegram.org/bot%s/sendMessage" % token, data=cuerpo,
            headers={"Content-Type": "application/json"}), timeout=30).read()
        # Marca para boletin.yml: si esto ya le dijo algo a la persona, su
        # aviso generico de fallo ("no se envio nada") sobra y puede ser falso.
        Path("avisado.flag").touch()
    except Exception as e:
        print("no pude avisar al chat:", e)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    chat = sys.argv[sys.argv.index("--chat") + 1] if "--chat" in sys.argv else ""
    if chat in args:
        args.remove(chat)
    prueba = "--prueba" in sys.argv
    # Solo para probar: elegir un lunes concreto en vez del proximo, para no
    # tocar los numeros que el equipo ya tiene preparados.
    forzar_lunes = sys.argv[sys.argv.index("--lunes") + 1] if "--lunes" in sys.argv else ""
    if forzar_lunes in args:
        args.remove(forzar_lunes)
    if not args:
        raise SystemExit("Falta la carpeta con las laminas.")
    laminas = laminas_de(args[0])
    if not laminas:
        avisar(chat, "⚠️ No encontré las láminas de esa edición, así que no subí nada al boletín.")
        return 1
    edicion = next(Path(args[0]).rglob("edicion.json"), None)
    ed = json.loads(edicion.read_text(encoding="utf-8")) if edicion else {}
    print(f"{len(laminas)} láminas: {', '.join(p.name for p in laminas)}")

    panel = Panel()
    lunes = (panel.llamar("/admin/boletin/lunes") or {}).get("lunes") or []
    # El primer lunes que todavia puede salir. Uno que ya se esta enviando o se
    # envio no cuenta: ese correo ya lo recibieron.
    lunes = [x for x in lunes if x.get("status") not in ("sending", "sent")]
    if not lunes:
        avisar(chat, "⚠️ El panel no me da ningún lunes libre para el boletín. No subí nada.")
        return 1
    destino = next((x for x in lunes if x["fecha"] == forzar_lunes), None) if forzar_lunes else lunes[0]
    if not destino:
        raise SystemExit("Ese lunes no está en la lista del panel: %s" % forzar_lunes)
    fecha, cuando = destino["fecha"], destino.get("texto") or destino["fecha"]

    if destino.get("numero_id"):
        numero = panel.llamar("/admin/boletin/numeros/%s" % destino["numero_id"])
        if numero.get("status") != "draft":
            avisar(chat, "ℹ️ El boletín del <b>%s</b> ya está activo en el panel. No lo toqué." % cuando)
            return 0
        if numero.get("paginas"):
            avisar(chat, "ℹ️ El boletín del <b>%s</b> ya tiene %s páginas subidas, así que no lo "
                         "piso: puede haberlo montado alguien a mano. Si hay que cambiarlas, se "
                         "hace en el panel → Boletín." % (cuando, numero["paginas"]))
            return 0
    else:
        numero = panel.llamar("/admin/boletin/numeros", "POST",
                              {"send_on": fecha, "subject": "Entorno en Viñetas · %s" % cuando})
    ident = numero["id"]

    medios = []
    for p in laminas:
        m = panel.subir_imagen(para_correo(p))
        medios.append(m["id"])
        panel.llamar("/admin/boletin/numeros/%s/paginas" % ident, "POST", {"media_id": m["id"]})
        print("  página %s subida" % p.name)

    cambios = {"cover_media_id": medios[0]}
    if not (numero.get("preheader") or "").strip():
        # El texto que el correo enseña al lado del asunto. Sale de la
        # contraportada de la edicion, que es justo el gancho de la semana.
        gancho = ((ed.get("secciones") or {}).get("CONTRAPORTADA") or "").strip()
        if gancho:
            cambios["preheader"] = gancho[:150].rsplit(" ", 1)[0] + ("…" if len(gancho) > 150 else "")
    if not prueba:
        cambios["status"] = "ready"
    panel.llamar("/admin/boletin/numeros/%s" % ident, "PATCH", cambios)

    final = panel.llamar("/admin/boletin/numeros/%s" % ident)
    subidas, estado = final.get("paginas"), final.get("status")
    print(f"número {ident}: {subidas} páginas, estado {estado}")
    if subidas != len(laminas) or estado != ("draft" if prueba else "ready"):
        avisar(chat, "⚠️ Subí el boletín del <b>%s</b> pero el panel dice %s páginas y estado «%s». "
                     "Revísalo en el panel → Boletín antes del lunes." % (cuando, subidas, estado))
        return 1
    if prueba:
        avisar(chat, "🧪 Boletín del <b>%s</b> subido en BORRADOR (prueba): %s páginas." % (cuando, subidas))
    else:
        avisar(chat, "📤 <b>Subido al boletín.</b> Sale solo el <b>%s a las 9:00</b> a %s suscriptores, "
                     "con las %s láminas.\n\nSi hay que pararlo, en el panel → Boletín se vuelve a "
                     "borrador; hasta el lunes no sale nada."
               % (cuando, final.get("suscriptores") or "todos los", subidas))
    return 0


if __name__ == "__main__":
    sys.exit(main())
