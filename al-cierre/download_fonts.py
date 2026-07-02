# -*- coding: utf-8 -*-
"""Descarga las fuentes (Google Fonts) usadas por la plantilla a assets/fonts."""
import re
import urllib.request
from pathlib import Path

FONTS_DIR = Path(__file__).parent / "assets" / "fonts"
FONTS_DIR.mkdir(parents=True, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"}

CSS_URL = (
    "https://fonts.googleapis.com/css2"
    "?family=Poppins:wght@500;600;700"
    "&family=Archivo+Black"
    "&display=swap"
)

req = urllib.request.Request(CSS_URL, headers=UA)
css = urllib.request.urlopen(req, timeout=30).read().decode()

# bloques @font-face -> familia/peso/url; el subset latin es el ultimo de cada familia/peso
blocks = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)
fonts = {}
for b in blocks:
    fam = re.search(r"font-family:\s*'([^']+)'", b).group(1)
    weight = re.search(r"font-weight:\s*(\d+)", b).group(1)
    url = re.search(r"url\((\S+?)\)", b).group(1)
    name = f"{fam.replace(' ', '')}-{weight}.woff2"
    fonts[name] = url

for name, url in fonts.items():
    out = FONTS_DIR / name
    urllib.request.urlretrieve(url, out)
    print("OK", name, out.stat().st_size, "bytes")
