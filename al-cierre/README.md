# Al Cierre — Generador automático de láminas

Genera las 4 láminas diarias de "Al Cierre" (Rendigroup) con los valores de
cierre de los mercados, listas para publicar (PNG 1080×1920, mismo diseño que
la plantilla de Canva).

## Flujo diario — 100% automático

Una tarea programada de Windows (**"Al Cierre Telegram"**) corre `daily.py`
de lunes a viernes a las **5:30 pm**: busca los datos, genera las láminas y
las envía por Telegram (álbum de 4 fotos) a los chats configurados en el
`.env` del bot de noticias. Si algo falla, manda una alerta ⚠️ por Telegram.

También se puede correr a mano, todo o por partes:

```
py daily.py         # flujo completo (datos + láminas + Telegram)
py fetch_data.py    # solo datos (23 valores: Yahoo Finance, BCV, Investing.com)
py render.py        # solo láminas -> out/<fecha>/
py send_telegram.py # solo envío de las láminas de hoy
```

O pedírselo a Claude: **"genera las láminas de al cierre"**.

Administrar la tarea programada:
`schtasks /run /tn "Al Cierre Telegram"` (probar ya) ·
`schtasks /change /tn "Al Cierre Telegram" /st 17:30` (cambiar hora) ·
`schtasks /delete /tn "Al Cierre Telegram"` (eliminar).
El registro de cada corrida queda en `daily.log`.

## Salida

`out/AAAA-MM-DD/1-tasas.png, 2-usa.png, 3-europa-asia.png, 4-latam.png`

## Fuentes de datos

| Grupo | Fuente | Detalle |
|---|---|---|
| EUR/USD, índices USA/Europa/Asia/Latam, Oro, Brent, BTC | Yahoo Finance (API JSON) | 19 instrumentos |
| VES/USD y VES/EUR | bcv.org.ve (tasa oficial) | la variación % se calcula contra el histórico guardado en `bcv_history.json` |
| Colcap, IBC Caracas | Investing.com | vía curl (mismos valores que usa el equipo) |

## Correcciones manuales

Si algún valor falla o quieres pisarlo, crea/edita `overrides.json`:

```json
{ "ibc": { "value": 5478.02, "change": -4.35 } }
```

y vuelve a correr `py render.py` (no hace falta re-descargar datos).

## Archivos

- `daily.py` — orquestador (datos → láminas → Telegram, con alertas)
- `send_telegram.py` — envía las 4 láminas como álbum (token/chats del `.env` de telegram-finance-bot)
- `fetch_data.py` — descarga valores → `data.json` (+ histórico BCV)
- `render.py` — `data.json` → HTML → PNG (Chrome headless)
- `assets/` — logo, banderas (extraídos de la plantilla original) y fuentes
- `referencia/` — exportación de la plantilla original de Canva (para comparar)
- `extract_assets.py`, `download_fonts.py` — utilidades de preparación (una sola vez)

## Notas

- Ejecutar **después del cierre de NY (4:00 pm hora Venezuela)**; antes de esa
  hora los índices USA muestran valores intradía.
- La fecha de la lámina es la del día en que se ejecuta.
- El diseño clon vive en el HTML dentro de `render.py` (colores y geometría
  medidos de la plantilla original de Canva).
- En Canva existe una copia de trabajo de 4 páginas "Rendi Group (AL CIERRE)"
  (id DAHOLZfsFgw) que puede editarse por API (textos/fechas/valores), como
  alternativa parcial.
