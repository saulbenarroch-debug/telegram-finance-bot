# Arquitectura

Cómo está armado Sureconomics, subsistema por subsistema. Para las reglas y
trampas, ver [../CLAUDE.md](../CLAUDE.md).

## Panorama

```
                       ┌─────────────────────────────┐
   cron-job.org ──────▶│ GitHub Actions (4 workflows)│──────▶ Telegram
   (el reloj)          └─────────────────────────────┘
                                                          ▲
   Telegram (webhook) ─▶┌─────────────────────────────┐    │
                        │ Cloudflare Worker + KV      │────┘
   cron del Worker ────▶│ (chat + newsletter)         │
                        └─────────────────────────────┘
```

Dos mitades que comparten el mismo bot de Telegram y el mismo `TELEGRAM_TOKEN`:

- **Lo programado** corre en GitHub Actions (Python). Necesita un reloj externo.
- **Lo interactivo** corre en un Cloudflare Worker (JavaScript), siempre
  despierto, con memoria en KV.

Un bot de Telegram puede difundir por API y recibir por webhook a la vez: no
interfieren.

## 1. Resumen dos veces al día — `bot.py`

**Flujo:** RSS → filtro por fecha → dedup por título → IA redacta → Telegram.

**Ventana de tiempo** (`lookback_hours`), para no repetir ni dejar huecos:
- Turno matutino (antes de 13:00 VET): últimas **18 h** (cubre la tarde/noche anterior).
- Turno vespertino: últimas **7 h** (cubre desde el envío de la mañana).

**Las 4 categorías** (`SOURCES`), en orden de prominencia:

| Categoría | Fuentes |
|---|---|
| 🌎 Suramérica: economía e inversión | búsqueda en Google News RSS (`_SURAMERICA_QUERY`) |
| 🤝 M&A en Latinoamérica | Google News RSS, dos consultas: ES + EN |
| 🇻🇪 Economía venezolana | elnacional.com/economia, descifrado.com |
| 🌍 Wall Street y global (**solo contexto, al final**) | CNBC (x2), MarketWatch, BBC Business, El País economía |

Máximo `MAX_PER_CATEGORY = 6` titulares por categoría llegan a la IA.

Los nichos sin RSS propio se resuelven con `google_news_rss(query)`, que arma un
feed a partir de una búsqueda. Las consultas excluyen ruido (`-fútbol
-deportes -selección -partido`).

**Salida:** encabezado + briefing bilingüe (ES, `———`, EN) + bloque "🔗 Fuentes"
con los titulares enlazados. Se parte en trozos de 4000 caracteres (el límite de
Telegram es 4096).

**Multi-destinatario:** `CHAT_ID` acepta varios ids separados por coma.
`send_message()` itera y un destinatario caído (bloqueó al bot) no detiene a los
demás.

## 2. Alertas de alto impacto — `breaking.py`

Corre **cada hora**. Importa `bot` y reutiliza sus fuentes.

1. **Ventana de 70 minutos** (`LOOKBACK_MINUTES`), algo mayor a 60 para solapar y
   no dejar huecos; la dedup por enlace evita repetir.
2. **Filtro barato previo:** solo llama a la IA si algún titular contiene una
   palabra de `HIGH_IMPACT_KEYWORDS` (desplome, default, sanciones, devaluación,
   crash, rate hike, megafusión…). Así las horas tranquilas **no gastan cuota**.
3. **Juicio de la IA:** Gemini decide si de verdad es un evento grande.
4. **Dedup persistente:** `breaking_state.json` guarda los últimos 500 enlaces
   avisados. El workflow lo commitea de vuelta al repo (necesita
   `permissions: contents: write`).

## 3. Bot conversacional — `cloudflare-worker/worker.js`

Desplegado como Cloudflare Worker: **https://sureconomics-bot.sureconomics.workers.dev**
(worker `sureconomics-bot`, subdominio `sureconomics`).

**Rutas (`fetch`):**

| Ruta | Qué hace |
|---|---|
| `POST /` | webhook de Telegram (valida `X-Telegram-Bot-Api-Secret-Token`) |
| `GET /` | "Sureconomics bot activo ✅" (chequeo de vida) |
| `GET /ingest?key=…` | puebla el historial de noticias a mano |
| `GET /entorno?key=…` | devuelve el newsletter en texto |
| `GET /entorno?key=…&force=1` | rearma la edición ignorando la caché |
| `GET /entorno?key=…&datos=1` | solo las cifras, en JSON |
| `GET /entorno?key=…&formato=json` | lo que consume `entorno/render.py` |

**Comandos de chat:** `/start`, `/help`, `/id` (devuelve tu chat id — así se
agregan destinatarios, porque `getUpdates` no sirve con webhook activo),
`/entorno`, `/ipc 13,8 129,8 junio 2026`.

**Cómo responde una pregunta** (`handleUpdate`): en paralelo busca el historial
del chat, Google News, la web vía Tavily y el archivo de noticias en KV; mezcla
(`mergeNews`), detecta el tema (`searchQueryFor` → M&A / Suramérica /
Venezuela), y le pasa todo a la IA con la voz Sureconomics.

**Memoria (Cloudflare KV, namespace `sureconomics-kv`, binding `KV`):**

| Clave | Contenido |
|---|---|
| `articles` | ~300 noticias con título, fuente, autor, fecha, categoría |
| `chat:<id>` | últimos 8 mensajes de ese usuario, TTL 7 días |
| `hist:bcv`, `hist:par`, `hist:ibc` | históricos propios de tasas e IBC |
| `entorno:last` | última edición armada del newsletter (caché 6 h) |
| `entorno:bases` | pisa las bases anuales de la constante `BASES` |

**Crons del Worker:**
- `0 */3 * * *` — ingiere noticias y registra tasas al historial.
- `0 12 * * 5` — viernes 8:00 a.m. VET: **prearma** el newsletter en caché.
  **No lo envía a nadie** (decisión del dueño del proyecto).

**Búsqueda web con Tavily:** `fetchWebNews` (`topic=news`, `days=21`) rastrea
todo internet, no solo Google News. Se activa si existe `TAVILY_API_KEY`; sin
ella el bot funciona igual con Google News + RSS.

Fuentes premium de pago (Mergermarket, LatinFinance, BNamericas Pro) **no** son
accesibles; no se intentó integrarlas.

## 4. Entorno en Viñetas — newsletter semanal

Formato calcado del PDF de referencia (Óscar Doval / Mundo Económico):
contraportada + noticia principal (nicho, titular, subtítulo, 3 párrafos) +
economía en cifras + 4 ítems "Latam enlatada".

### Las cifras las calcula el código, no la IA

Regla de diseño central. `bloqueCifras` arma los números y la IA solo redacta la
prosa alrededor: así no hay cifras inventadas.

| Dato | Fuente |
|---|---|
| Dólar BCV y paralelo | `ve.dolarapi.com` (un solo JSON, TLS válido). Respaldo: `bcv.org.ve` |
| IBC (Bolsa de Caracas) | `bolsadecaracas.com`, leído del slug `cerro-en-X-puntos-23jul` |
| Índices, Brent, oro, BTC, ETH | Yahoo Finance chart API (no bloquea a los Workers) |
| Variación semanal de BCV / paralelo / IBC | **históricos propios en KV** — ninguna fuente publica esa variación |
| Bases anuales 2026 | constante `BASES` (BCV 301,37 del 1-ene; IBC 2.082,26 cierre 2025) |
| IPC | **a mano**, comando `/ipc` — el BCV no tiene API |

### Selección de noticias (afinada en dos pasadas)

Lo que más subió la calidad, en orden:

1. **Pasar los resúmenes al modelo, no solo titulares.** `parseRss` extrae
   `<description>` (campo `s`) y Tavily su `content`; se le entregan a la IA con
   "→" para las 14 mejores. De ahí salen cifras concretas (una decisión de tasa,
   la fecha de un dato, el monto de una adquisición) en vez de prosa vaga.
2. **Feeds de sección, no de sitio completo.** El RSS general de El Cronista
   traía recetas, horóscopos y ANSES. Se usa Bloomberg Línea
   `/rss/category/economia/` y `/category/mercados/` (100 ítems cada uno), más
   tres fuentes venezolanas verificadas: efectococuyo.com/economia/feed,
   talcualdigital.com/category/economia/feed, elestimulo.com/feed.
3. **Puntaje en vez de pasa/no pasa** (`puntuar()`): premia macro fuerte,
   cifras/%/US$, medios reconocidos, resumen útil y frescura; castiga clickbait.
4. **Cupos:** 10 Venezuela + 14 Latam (**máximo 2 por país**) + 5 global. Sin el
   tope por país, una semana argentina se come la sección.
5. **Dedup por solapamiento de palabras** (`dedupTitulos`, Jaccard > 0,5): la
   misma noticia llega de cinco medios con URL distinta.

Palancas que quedan si hace falta más calidad: selección en dos pasos (una
llamada que elige y otra que redacta), bajar el cuerpo de los 3-4 mejores
artículos, y un modo "solo medios de la whitelist".

### Las láminas — `entorno/`

`render.py` genera **4 PNG de 1414×2000** (A4 vertical, ratio 0,707): `1-portada`,
`2-noticia`, `3-cifras`, `4-latam`. Misma tubería que Al Cierre:
**HTML/CSS → Chrome headless → PNG → álbum por Telegram**.

- El diseño es un clon del Canva "entorno en viñetas" (id `DAHOniEgyiw`).
  La paleta y la geometría se **midieron** sobre la exportación PNG de la
  plantilla con Pillow, no se estimaron a ojo: fondo `#000000`, gris de tarjeta
  `#313131`, coral `#E8524C`, texto blanco.
- No hay brand templates en la cuenta de Canva, así que el autofill por API está
  descartado.
- **Auto-ajuste:** `altura_bloque()` le pregunta el `scrollHeight` a Chrome vía
  `--dump-dom` y reescala si no cabe. Sin eso, la semana que la IA escriba largo
  la lámina se corta en silencio.
- **Las fotos** salen del `og:image` del artículo fuente: la IA devuelve
  `###FUENTE` con el número del titular y el Worker prueba hasta 4 candidatas con
  `BROWSER_UA` (Infobae y otros dan 403 al User-Agent de bot).

### Envío a pedido

No hay envío programado. Cuando alguien escribe `/entorno` (o una frase con
"viñetas"), el Worker:

1. manda el **texto** al instante, y
2. dispara `entorno.yml` por la API de GitHub pasándole el chat que preguntó
   (input `chat`), así el álbum de láminas vuelve **a ese mismo chat**.

El texto está desacoplado del render **a propósito**: si el render falla, el
newsletter escrito llega igual. Requiere `GITHUB_PAT` (fine-grained, Actions
read/write) como binding del Worker.

## 5. Al Cierre — `al-cierre/`

Láminas diarias de cierre de mercados para Rendigroup. Es un proyecto distinto
que vive en este repo por comodidad de despliegue.

`daily.py` orquesta: `fetch_data.py` (23 valores → `data.json`) → `render.py`
(HTML → 4 PNG 1080×1920) → `send_telegram.py` (álbum). Si algo falla, avisa por
Telegram en vez de quedarse callado.

Detalle completo, fuentes y overrides manuales en
[../al-cierre/README.md](../al-cierre/README.md).

## Por qué estas decisiones

| Decisión | Razón |
|---|---|
| Gemini en vez de Claude para redactar | capa gratuita suficiente para este volumen; clave sin tarjeta |
| Groq como respaldo | gratis y generoso; respaldo *cross-provider*, no solo otro modelo del mismo proveedor |
| GitHub Actions para lo programado | no depende de tener el PC encendido |
| cron-job.org como reloj | el `schedule:` de Actions llegaba tarde y se saltaba corridas |
| Cloudflare Worker para el chat | siempre despierto, gratis, sin servidor que mantener |
| Despliegue del Worker por API | el botón Deploy del panel estaba bugueado en la cuenta nueva |
| HTML + Chrome headless para las láminas | control total del diseño; Canva por API no alcanzaba sin brand templates |
| `og:image` del artículo para las fotos | imagen real y pertinente, sin banco de imágenes ni licencias |
