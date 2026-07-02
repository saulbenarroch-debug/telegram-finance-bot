# -*- coding: utf-8 -*-
"""
Al Cierre - Obtiene los valores de cierre de mercados para las laminas diarias.
Fuentes: Yahoo Finance (API JSON), BCV (tasas oficiales VES).
Salida: data.json con valor de cierre y variacion % de cada instrumento.
Uso: py fetch_data.py
"""
import json
import re
import ssl
import sys
import urllib.request
from datetime import date
from pathlib import Path

BASE = Path(__file__).parent
HISTORY_FILE = BASE / "bcv_history.json"
OUTPUT_FILE = BASE / "data.json"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

# (clave, ticker Yahoo, nombre para la lamina)
YAHOO_TICKERS = [
    # Tasas / USA
    ("eurusd",   "EURUSD=X",  "EUR/USD"),
    ("dowjones", "^DJI",      "Dow Jones"),
    ("sp500",    "^GSPC",     "S&P500"),
    ("nasdaq",   "^IXIC",     "Nasdaq"),
    ("oro",      "GC=F",      "Oro"),
    ("brent",    "BZ=F",      "Petroleo Brent"),
    ("btc",      "BTC-USD",   "BTC/USD"),
    # Europa
    ("stoxx50",  "^STOXX50E", "Euro Stoxx 50 (Zona Euro)"),
    ("cac40",    "^FCHI",     "CAC 40 (Francia)"),
    ("dax",      "^GDAXI",    "DAX (Alemania)"),
    ("ibex35",   "^IBEX",     "IBEX 35 (Espana)"),
    ("ftse100",  "^FTSE",     "FTSE 100 (Reino Unido)"),
    # Asia
    ("hangseng", "^HSI",      "Hang Seng (Hong Kong)"),
    ("nikkei",   "^N225",     "Nikkei 225 (Japon)"),
    ("csi300",   "000300.SS", "CSI 300 (China)"),
    # Latam
    ("bovespa",  "^BVSP",     "Bovespa (IBOV - Sao Pablo)"),
    ("ipc",      "^MXX",      "S&P BMV IPC (Mexico)"),
    ("ipsa",     "^IPSA",     "S&P IPSA (Chile)"),
    ("merval",   "^MERV",     "S&P Merval (Argentina)"),
]

# Indices sin datos en Yahoo -> Investing.com
INVESTING = [
    ("colcap", "https://www.investing.com/indices/colcap", "Colcap (Colombia)"),
]


def http_get(url, insecure=False):
    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        return r.read().decode("utf-8", errors="replace")


def yahoo_quote(ticker):
    """Devuelve (ultimo_cierre, variacion_pct) usando la API chart de Yahoo."""
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.request.quote(ticker)
        + "?interval=1d&range=10d"
    )
    data = json.loads(http_get(url))
    result = data["chart"]["result"][0]
    meta = result["meta"]
    closes = result["indicators"]["quote"][0].get("close") or []
    closes = [c for c in closes if c is not None]

    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose")
    # Preferimos los dos ultimos cierres de la serie diaria
    if len(closes) >= 2:
        price = closes[-1]
        prev = closes[-2]
    if price is None or prev in (None, 0):
        raise ValueError(f"sin datos para {ticker}")
    change = (price - prev) / prev * 100.0
    return price, change


def investing_quote(url):
    """Devuelve (ultimo, variacion_pct) raspando una pagina de Investing.com via curl."""
    import subprocess

    r = subprocess.run(
        ["curl", "-s", "--max-time", "30", "-A", UA["User-Agent"], url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    html = r.stdout
    m_last = re.search(r'data-test="instrument-price-last"[^>]*>([\d.,]+)<', html)
    m_pct = re.search(r'data-test="instrument-price-change-percent"[^>]*>[^<%]*?([+-]?[\d.,]+)%', html)
    if not m_last:
        raise ValueError(f"no se encontro el precio en {url}")
    price = float(m_last.group(1).replace(",", ""))
    change = float(m_pct.group(1).replace(",", "")) if m_pct else None
    return price, change


def ibc_caracas():
    """IBC directo de bolsadecaracas.com.

    La web publica cada cierre como noticia con slug
    'indice-bursatil-caracas-cerro-en-5-48236-puntos-2jul'. Tomamos los dos
    ultimos cierres distintos y calculamos la variacion nosotros mismos
    (Investing.com muestra este indice congelado/desactualizado).
    """
    html = http_get("https://www.bolsadecaracas.com/", insecure=True)
    matches = re.findall(
        r"cerro-en-([0-9-]+)-puntos-([0-9]{1,2}[a-z]{3})", html
    )
    closes = []  # [(fecha_slug, valor)] en orden de aparicion (mas reciente primero)
    for digits, fecha in matches:
        value = int(digits.replace("-", "")) / 100.0
        if not any(f == fecha for f, _ in closes):
            closes.append((fecha, value))
        if len(closes) == 2:
            break
    if not closes:
        raise ValueError("no se encontraron cierres del IBC en bolsadecaracas.com")
    value = closes[0][1]
    change = None
    if len(closes) == 2 and closes[1][1]:
        change = (value - closes[1][1]) / closes[1][1] * 100.0
    return value, change


def bcv_rates():
    """Devuelve {'usd': tasa, 'eur': tasa} desde bcv.org.ve (certificado invalido -> insecure)."""
    html = http_get("https://www.bcv.org.ve/", insecure=True)
    rates = {}
    for cur_id, key in (("dolar", "usd"), ("euro", "eur")):
        m = re.search(
            r'id="%s".*?<strong[^>]*>\s*([\d.,]+)\s*</strong>' % cur_id,
            html,
            re.S,
        )
        if not m:
            raise ValueError(f"no se encontro la tasa {key} en bcv.org.ve")
        rates[key] = float(m.group(1).replace(".", "").replace(",", "."))
    return rates


def bcv_with_change(rates):
    """Calcula variacion % vs. la ultima tasa guardada en bcv_history.json."""
    history = {}
    if HISTORY_FILE.exists():
        history = json.loads(HISTORY_FILE.read_text())
    today = date.today().isoformat()
    out = {}
    for key, rate in rates.items():
        prev_rate = None
        # ultima fecha anterior a hoy con esta moneda
        for d in sorted(history.keys(), reverse=True):
            if d < today and key in history[d]:
                prev_rate = history[d][key]
                break
        change = None
        if prev_rate:
            change = (rate - prev_rate) / prev_rate * 100.0
        out[key] = {"value": rate, "change": change}
    history.setdefault(today, {}).update(rates)
    HISTORY_FILE.write_text(json.dumps(history, indent=2))
    return out


def main():
    out = {"fecha": date.today().isoformat(), "quotes": {}, "errores": []}

    for key, ticker, name in YAHOO_TICKERS:
        try:
            price, change = yahoo_quote(ticker)
            out["quotes"][key] = {
                "name": name,
                "ticker": ticker,
                "value": price,
                "change": change,
            }
            print(f"OK  {name:35s} {price:>14,.2f}  {change:+.2f}%")
        except Exception as e:
            out["errores"].append({"key": key, "ticker": ticker, "error": str(e)})
            print(f"ERR {name:35s} {ticker}: {e}")

    for key, url, name in INVESTING:
        try:
            price, change = investing_quote(url)
            out["quotes"][key] = {"name": name, "value": price, "change": change}
            ch = f"{change:+.2f}%" if change is not None else "s/d"
            print(f"OK  {name:35s} {price:>14,.2f}  {ch}")
        except Exception as e:
            out["errores"].append({"key": key, "error": str(e)})
            print(f"ERR {name:35s}: {e}")

    # IBC: web oficial de la Bolsa de Caracas, variacion calculada por nosotros
    try:
        price, change = ibc_caracas()
        out["quotes"]["ibc"] = {"name": "IBC (Venezuela)", "value": price, "change": change}
        ch = f"{change:+.2f}%" if change is not None else "s/d"
        print(f"OK  {'IBC (Venezuela)':35s} {price:>14,.2f}  {ch}")
    except Exception as e:
        out["errores"].append({"key": "ibc", "error": str(e)})
        print(f"ERR IBC (Venezuela): {e}")

    try:
        rates = bcv_with_change(bcv_rates())
        usd, eur = rates["usd"], rates["eur"]
        out["quotes"]["ves_usd"] = {"name": "VES/USD (BCV)", **usd}
        out["quotes"]["ves_eur"] = {"name": "VES/EUR", **eur}
        for label in ("ves_usd", "ves_eur"):
            q = out["quotes"][label]
            ch = f"{q['change']:+.2f}%" if q["change"] is not None else "s/d"
            print(f"OK  {q['name']:35s} {q['value']:>14,.2f}  {ch}")
    except Exception as e:
        out["errores"].append({"key": "bcv", "error": str(e)})
        print(f"ERR BCV: {e}")

    OUTPUT_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\nGuardado en {OUTPUT_FILE}")
    return 1 if out["errores"] else 0


if __name__ == "__main__":
    sys.exit(main())
