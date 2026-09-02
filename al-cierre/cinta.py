r"""Extrae de Al Cierre los datos que SI se pueden publicar en la web.

    .pyruntime\python.exe al-cierre/cinta.py

Lee data.json (que ya generó fetch_data.py) y escribe cinta.json, que es lo que
consume el cintillo de sureconomics.com.

POR QUE SOLO TRES DE LOS VEINTITRES

Al Cierre trae 23 datos. Veinte salen de raspar query1.finance.yahoo.com, que es
un endpoint interno de Yahoo y no un API con términos que podamos cumplir.
Mandarlos a un Telegram interno es uso interno; ponerlos en la portada de un
medio comercial es redistribución, y eso no lo cubre ninguna licencia
individual, ni siquiera las de pago. Que el dato sea de cierre y no en tiempo
real NO cambia esto: el precio lo fija el derecho de display, no la latencia.
Verificado en agosto de 2026 contra Massive, Finnhub y Twelve Data.

Los tres que quedan vienen del emisor oficial y son publicables:

    ves_usd, ves_eur  ->  BCV, que publica su propia tasa. Es un acto
                          administrativo público.
    ibc               ->  Bolsa de Caracas, que publica su propio índice.

Y son justo los que ningún proveedor internacional cubre, así que son los que
de verdad aportan algo que nadie más tiene.

Los veinte globales los sirve el widget de TradingView directamente al navegador
del lector, bajo la licencia de TradingView. Ver cinta/LEEME.md.
"""

import json
import pathlib
import sys
from datetime import datetime, timezone

AQUI = pathlib.Path(__file__).resolve().parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Lo que se publica, y por qué cada uno. Añadir algo aquí es una decisión de
# licencia, no de diseño: si el dato no viene del emisor, no entra.
PUBLICABLES = {
    "ves_usd": {"etiqueta": "BCV USD", "unidad": "Bs",
                "fuente": "Banco Central de Venezuela",
                "url": "https://www.bcv.org.ve/"},
    "ves_eur": {"etiqueta": "BCV EUR", "unidad": "Bs",
                "fuente": "Banco Central de Venezuela",
                "url": "https://www.bcv.org.ve/"},
    "ibc": {"etiqueta": "IBC", "unidad": "pts",
            "fuente": "Bolsa de Valores de Caracas",
            "url": "https://www.bolsadecaracas.com/"},
}


def main():
    origen = AQUI / "data.json"
    if not origen.exists():
        print("No hay data.json. Corre fetch_data.py primero.")
        return 1

    datos = json.loads(origen.read_text(encoding="utf-8"))
    quotes = datos.get("quotes", {})

    valores, faltan = [], []
    for clave, ficha in PUBLICABLES.items():
        q = quotes.get(clave)
        if not q or q.get("value") is None:
            faltan.append(clave)
            continue
        valores.append({
            "clave": clave,
            "etiqueta": ficha["etiqueta"],
            "valor": round(float(q["value"]), 2),
            "variacion": round(float(q.get("change") or 0.0), 2),
            "unidad": ficha["unidad"],
            "fuente": ficha["fuente"],
            "url_fuente": ficha["url"],
        })

    # Se escribe aunque falte alguno: media cinta es mejor que ninguna, y el
    # sitio ya sabe pintar los que lleguen. Pero queda anotado cual falto.
    salida = {
        "actualizado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fecha_cierre": datos.get("fecha", ""),
        "valores": valores,
        "faltan": faltan,
        "nota": ("Solo datos de emisor oficial venezolano. Los indices globales "
                 "los sirve TradingView en el navegador del lector."),
    }
    destino = AQUI / "cinta.json"
    destino.write_text(json.dumps(salida, ensure_ascii=False, indent=2),
                       encoding="utf-8")

    print("cinta.json: %d de %d valores" % (len(valores), len(PUBLICABLES)))
    for v in valores:
        print("  %-9s %12s %s   %+.2f %%" % (
            v["etiqueta"], "{:,.2f}".format(v["valor"]).replace(",", "."),
            v["unidad"], v["variacion"]))
    if faltan:
        print("  faltan: %s" % ", ".join(faltan))
    return 0


if __name__ == "__main__":
    sys.exit(main())
