# -*- coding: utf-8 -*-
"""
Al Cierre - Genera las 4 laminas PNG (1080x1920) a partir de data.json.
Uso:
  py render.py            -> genera HTML y PNG en out/<fecha>/
  py render.py --html     -> solo genera los HTML (para inspeccion)
Si existe overrides.json, sus valores pisan a los de data.json
(util para Colcap/IBC o correcciones manuales):
  {"ibc": {"value": 5478.02, "change": -4.35}}
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

BASE = Path(__file__).parent
ASSETS = BASE / "assets"
CHROME = (
    os.environ.get("CHROME_BIN")
    or shutil.which("google-chrome")
    or shutil.which("chromium-browser")
    or r"C:\Program Files\Google\Chrome\Application\chrome.exe"
)

# ---------------------------------------------------------------- formato

def fmt_num(v, dec=2):
    """171688.61 -> '171.688,61' (formato es-VE)."""
    if v is None:
        return "s/d"
    s = f"{v:,.{dec}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def fmt_pct(ch):
    if ch is None:
        return "(s/d)"
    return f"({'+' if ch >= 0 else '-'}{fmt_num(abs(ch))}%)"


def up(ch):
    return ch is not None and ch >= 0


# ---------------------------------------------------------------- estilo

CSS = """
@font-face { font-family:'Poppins'; font-weight:500; src:url('__ASSETS__/fonts/Poppins-500.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-weight:600; src:url('__ASSETS__/fonts/Poppins-600.woff2') format('woff2'); }
@font-face { font-family:'Poppins'; font-weight:700; src:url('__ASSETS__/fonts/Poppins-700.woff2') format('woff2'); }
@font-face { font-family:'Archivo Black'; font-weight:400; src:url('__ASSETS__/fonts/ArchivoBlack-400.woff2') format('woff2'); }
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1080px; height:1920px; }
.page { position:relative; width:1080px; height:1920px; background:#0B173D; overflow:hidden;
        font-family:'Poppins',sans-serif; color:#EBECF0; }
.abs { position:absolute; }
.logo { left:454px; top:90px; width:172px; }
.title { font-family:'Archivo Black'; font-size:86px; letter-spacing:1px; text-align:center; line-height:1.15; }
.subtitle { font-weight:500; font-size:44px; text-align:center; line-height:1.25; }
.date { font-weight:600; font-size:38px; text-align:center; letter-spacing:1px; }
.dash { top:1806px; width:123px; height:10px; border-radius:5px; background:#FFFFFF; }
.dash.active { background:#029937; }
.pill { border-radius:200px; border:4px solid;
        -webkit-mask-image:linear-gradient(to right, black 58%, rgba(0,0,0,0.45) 82%, transparent 99%);
        mask-image:linear-gradient(to right, black 58%, rgba(0,0,0,0.45) 82%, transparent 99%); }
.pill.up   { border-color:#029937; }
.pill.down { border-color:#FF3131; }
.pill-bg { background:linear-gradient(to right, #6B7389 0%, #4A536F 45%, #3B4563 62%, rgba(59,69,99,0.25) 88%, rgba(59,69,99,0) 100%); }
.circle { border-radius:50%; display:flex; align-items:center; justify-content:center; }
.circle.up   { background:#046443; }
.circle.down { background:#A02635; }
.label { font-weight:600; font-size:38px; line-height:1.18; color:#FFFFFF; }
.pct { font-weight:600; font-size:62px; color:#EBECF0; text-align:center; white-space:nowrap; }
.flag { border-radius:10px; }
.box { border:3px solid #8C93A8; border-radius:28px; }
.tag { font-family:'Poppins'; font-weight:700; font-size:38px; color:#FFFFFF; background:#029937;
       border-radius:14px; padding:2px 30px; letter-spacing:2px; }
"""

ARROW_UP = """<svg width="%(w)s" height="%(h)s" viewBox="0 0 24 24" fill="none">
<path d="M7 17 L17 7 M9 7 H17 V15" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>"""
ARROW_DOWN = """<svg width="%(w)s" height="%(h)s" viewBox="0 0 24 24" fill="none">
<path d="M17 7 L7 17 M7 9 V17 H15" stroke="white" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>"""


def arrow(is_up, w=52, h=52):
    return (ARROW_UP if is_up else ARROW_DOWN) % {"w": w, "h": h}


def circle(x, y, is_up, w=117, h=87):
    cls = "up" if is_up else "down"
    return (f'<div class="abs circle {cls}" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px">'
            f"{arrow(is_up)}</div>")


def page(body, assets_uri):
    return ("<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
            + CSS.replace("__ASSETS__", assets_uri)
            + "</style></head><body><div class='page'>" + body + "</div></body></html>")


def header(subtitle, assets_uri, title_top=277, sub_top=399, full=False):
    left, width = (177, 738) if not full else (0, 1080)
    return (
        f'<img class="abs logo" src="{assets_uri}/logo.png">'
        f'<div class="abs title" style="left:{left}px;top:{title_top}px;width:{width}px">AL CIERRE</div>'
        f'<div class="abs subtitle" style="left:{left}px;top:{sub_top}px;width:{width}px">{subtitle}</div>'
    )


def footer(fecha, active_idx):
    dashes = "".join(
        f'<div class="abs dash{" active" if i == active_idx else ""}" style="left:{x}px"></div>'
        for i, x in enumerate([269, 405, 541, 677])
    )
    return (f'<div class="abs date" style="left:171px;top:1730px;width:738px">({fecha})</div>' + dashes)


# ---------------------------------------------------------------- laminas

def slide_tasas(q, fecha, assets_uri):
    rows = [
        # (top_pill, x_pill, w_pill, flag, label_html, quote, top_label, top_pct, top_circle)
        (638, 243, 632, "flag_usa.png", "EUR/USD: ${v}", "eurusd", 688, 669, 663),
        (810, 243, 656, "flag_ven.png", "VES/USD (BCV): <br>{v}", "ves_usd", 841, 846, 842),
        (982, 245, 639, "flag_eur.png", "VES/EUR: <br>{v}", "ves_eur", 1005, 1009, 1009),
    ]
    flags_y = [676, 831, 1005]
    body = header("Tasas de cambio", assets_uri)
    for i, (top, x, w, flag, label, key, ly, py_, cy) in enumerate(rows):
        d = q[key]
        isup = up(d["change"])
        cls = "up" if isup else "down"
        dec = 2
        body += f'<div class="abs pill pill-bg {cls}" style="left:{x}px;top:{top}px;width:{w}px;height:140px"></div>'
        body += f'<img class="abs flag" src="{assets_uri}/{flag}" style="left:91px;top:{flags_y[i]}px;width:133px">'
        body += (f'<div class="abs label" style="left:281px;top:{ly}px">'
                 + label.format(v=fmt_num(d["value"], dec)) + "</div>")
        body += (f'<div class="abs pct" style="left:585px;top:{py_}px;width:330px">'
                 + fmt_pct(d["change"]) + "</div>")
        body += circle(910, cy, isup)
    body += footer(fecha, 0)
    return page(body, assets_uri)


def slide_usa(q, fecha, assets_uri):
    rows = [
        ("Dow Jones:", "dowjones", 585, 615, 610),
        ("S&amp;P500:", "sp500", 760, 793, 785),
        ("Nasdaq:", "nasdaq", 937, 973, 962),
        ("Oro:", "oro", 1112, 1143, 1137),
        ("Petroleo Brent:", "brent", 1288, 1321, 1308),
        ("BTC/USD:", "btc", 1465, 1499, 1493),
    ]
    body = header("Cierre de índices bursatiles <br>y valores USA", assets_uri,
                  title_top=269, sub_top=387, full=True)
    for name, key, top, pct_top, lbl_top in rows:
        d = q[key]
        isup = up(d["change"])
        cls = "up" if isup else "down"
        body += f'<div class="abs pill pill-bg {cls}" style="left:235px;top:{top}px;width:746px;height:140px"></div>'
        body += (f'<div class="abs label" style="left:294px;top:{lbl_top}px">'
                 f'{name}<br>{fmt_num(d["value"])}</div>')
        body += (f'<div class="abs pct" style="left:597px;top:{pct_top}px;width:335px">'
                 + fmt_pct(d["change"]) + "</div>")
        body += circle(91, top + 30, isup)
    body += footer(fecha, 1)
    return page(body, assets_uri)


def euro_asia_entry(x, y, name, d, pct_dx, pct_dy):
    """Entrada compacta: nombre+valor, y debajo flecha pequenya + porcentaje."""
    isup = up(d["change"])
    cls = "up" if isup else "down"
    html = (f'<div class="abs label" style="left:{x}px;top:{y}px;font-size:33px">'
            f'{name}<br>{fmt_num(d["value"])}</div>')
    html += (f'<div class="abs circle {cls}" '
             f'style="left:{x + pct_dx}px;top:{y + pct_dy}px;width:90px;height:64px">'
             + arrow(isup, 40, 40) + "</div>")
    html += (f'<div class="abs pct" style="left:{x + pct_dx + 100}px;top:{y + pct_dy - 6}px;'
             f'font-size:56px;text-align:left">' + fmt_pct(d["change"]) + "</div>")
    return html


def slide_europa_asia(q, fecha, assets_uri):
    body = header("Cierre de índices bursatiles <br>y valores", assets_uri)
    # caja Europa
    body += '<div class="abs box" style="left:83px;top:607px;width:917px;height:555px"></div>'
    body += '<div class="abs tag" style="left:762px;top:558px">EUROPA</div>'
    body += euro_asia_entry(152, 639, "Euro Stoxx 50 (zona euro):", q["stoxx50"], 0, 78)
    body += euro_asia_entry(572, 723, "CAC 40 (Francia):", q["cac40"], 0, 76)
    body += euro_asia_entry(152, 823, "Dax (Alemania):", q["dax"], 0, 76)
    body += euro_asia_entry(573, 907, "iBEX 35 (España):", q["ibex35"], 0, 78)
    body += euro_asia_entry(154, 977, "FTSE 100 (Reino Unido):", q["ftse100"], 0, 78)
    # caja Asia
    body += '<div class="abs box" style="left:74px;top:1282px;width:921px;height:374px"></div>'
    body += '<div class="abs tag" style="left:462px;top:1233px">ASIA</div>'
    body += euro_asia_entry(128, 1334, "Hang Seng (Hong Kong):", q["hangseng"], 0, 90)
    body += euro_asia_entry(619, 1334, "Nikkei 225 (Japón):", q["nikkei"], 0, 90)
    body += euro_asia_entry(400, 1488, "CSI 300 (China):", q["csi300"], 0, 92)
    body += footer(fecha, 2)
    return page(body, assets_uri)


def slide_latam(q, fecha, assets_uri):
    rows = [
        ("Bovespa <br>(IBOV – Sao Pablo):", "bovespa", 599, 258, 621, 145, 638, 615, 614),
        ("S&amp;P BMV IPC (México):", "ipc", 776, 258, 621, 145, 824, 811, 802),
        ("S&amp;P IPSA (Chile):", "ipsa", 955, 266, 662, 124, 988, 975, 961),
        ("S&amp;P Merval (Argentina):", "merval", 1114, 265, 662, 124, 1142, 1144, 1133),
        ("Colcap (Colombia):", "colcap", 1274, 267, 662, 124, 1302, 1304, 1290),
        ("IBC (Venezuela):", "ibc", 1444, 267, 662, 124, 1473, 1467, 1459),
    ]
    body = header("Cierre de índices bursatiles <br>y valores Latinoamericanas", assets_uri)
    for name, key, top, x, w, h, pct_top, lbl_top, circ_top in rows:
        d = q[key]
        isup = up(d["change"])
        cls = "up" if isup else "down"
        fsize = 30 if "<br>" in name else 32
        body += f'<div class="abs pill pill-bg {cls}" style="left:{x}px;top:{top}px;width:{w}px;height:{h}px"></div>'
        body += (f'<div class="abs label" style="left:315px;top:{lbl_top}px;font-size:{fsize}px">'
                 f'{name}<br>{fmt_num(d["value"])}</div>')
        body += (f'<div class="abs pct" style="left:665px;top:{pct_top}px;width:300px;font-size:52px">'
                 + fmt_pct(d["change"]) + "</div>")
        body += circle(108, circ_top, isup)
    body += footer(fecha, 3)
    return page(body, assets_uri)


# ---------------------------------------------------------------- main

def main():
    html_only = "--html" in sys.argv

    data = json.loads((BASE / "data.json").read_text(encoding="utf-8"))
    q = data["quotes"]
    ov_file = BASE / "overrides.json"
    if ov_file.exists():
        for key, v in json.loads(ov_file.read_text(encoding="utf-8")).items():
            q.setdefault(key, {}).update(v)

    # Si falta algun valor, la lamina sale con "s/d" en vez de romperse
    expected = [
        "eurusd", "ves_usd", "ves_eur",
        "dowjones", "sp500", "nasdaq", "oro", "brent", "btc",
        "stoxx50", "cac40", "dax", "ibex35", "ftse100",
        "hangseng", "nikkei", "csi300",
        "bovespa", "ipc", "ipsa", "merval", "colcap", "ibc",
    ]
    for key in expected:
        q.setdefault(key, {"value": None, "change": None})
        q[key].setdefault("value", None)
        q[key].setdefault("change", None)

    today = date.today()
    fecha = f"{today.day}/{today.month:02d}/{today.year}"

    out_dir = BASE / "out" / today.isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    assets_uri = ASSETS.as_uri()

    slides = [
        ("1-tasas", slide_tasas),
        ("2-usa", slide_usa),
        ("3-europa-asia", slide_europa_asia),
        ("4-latam", slide_latam),
    ]
    for name, fn in slides:
        html_path = out_dir / f"{name}.html"
        html_path.write_text(fn(q, fecha, assets_uri), encoding="utf-8")
        print("HTML", html_path)
        if html_only:
            continue
        png_path = out_dir / f"{name}.png"
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=1", "--window-size=1080,1920",
             f"--screenshot={png_path}", html_path.as_uri()],
            check=True, capture_output=True, timeout=120,
        )
        print("PNG ", png_path)


if __name__ == "__main__":
    main()
