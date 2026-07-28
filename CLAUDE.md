# Sureconomics — guía del proyecto

Contexto para Claude Code y para cualquier persona del equipo que trabaje en este
repo. Si cambias algo estructural (una fuente, un horario, un secreto, un
despliegue), **actualiza este archivo en el mismo commit**.

## Qué es

**Sureconomics** es un servicio de noticias económicas por Telegram centrado en
**Venezuela y Suramérica**. Su tesis editorial: promover la inversión en el sur
con criterio propio. Un mismo bot de Telegram hace de todo (difunde por cron y
responde por webhook; no interfieren entre sí).

Objetivo a futuro: abrirlo al público (multiusuario, bilingüe).

## Los 5 subsistemas

| # | Qué | Código | Dónde corre | Cuándo |
|---|---|---|---|---|
| 1 | Resumen 2x/día (ES+EN) | `bot.py` | GitHub Actions `news.yml` | 10:00 y 16:00 VET |
| 2 | Alertas de alto impacto | `breaking.py` | Actions `breaking.yml` | cada hora |
| 3 | Bot conversacional | `cloudflare-worker/worker.js` | Cloudflare Worker | webhook + cron 3h |
| 4 | "Entorno en Viñetas" (newsletter semanal + 4 láminas) | `worker.js` + `entorno/` | Worker + Actions `entorno.yml` | **a pedido** |
| 5 | "Al Cierre" (láminas diarias de cierre, Rendigroup) | `al-cierre/` | Actions `al-cierre.yml` | 5:30 pm VET |

Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) para el detalle de cada uno.

## Reglas de oro (no negociables)

1. **Nunca inventar cifras.** Las cifras las calcula el código; la IA solo
   redacta prosa. Esto es explícito en el newsletter (`bloqueCifras` en
   `worker.js`) y va en todos los prompts. Si un dato no está en la fuente, no
   se escribe.
2. **Secretos solo en `.env` (local) y GitHub Secrets / bindings del Worker.**
   Nunca en el código, nunca pegados en un chat. Si un token se expone, se
   revoca primero y se rota después.
3. **Degradación suave.** Si la IA falla, el mensaje sale igual con titulares y
   enlaces. Si una fuente RSS cae, no tumba a las demás. Si un destinatario
   bloqueó al bot, los otros siguen recibiendo. Mantener ese patrón.
4. **Nada de `schedule:` de GitHub Actions.** Llegaba tarde y se saltaba
   corridas. Todos los workflows son `workflow_dispatch` y los dispara
   cron-job.org. No "arregles" esto volviendo a poner `schedule`.
5. **No hay envío programado del newsletter**, por decisión del dueño del
   proyecto. El cron del viernes solo prearma la edición en caché.

## Voz editorial (Sureconomics)

Está codificada en `write_briefing()` (`bot.py`) y `promptEntorno()`
(`worker.js`). Si tocas un prompt, respeta:

- **Primera persona plural** con criterio propio.
- Cada tema = hechos + una línea **"Nuestra lectura:"** (EN: *"Our take:"*).
- **Pragmático y no partidista**: se celebra lo bueno venga de quien venga.
- Pro-inversión en el sur pero **honesto con las fragilidades** (dependencia
  petrolera, presión cambiaria, riesgo institucional).
- Secciones con carácter (ej. *"Tierra de Gracia"* = Venezuela).
- Sin tono publicitario, sin asteriscos ni `#`: Telegram usa `<b>HTML</b>`.

## IA: cadena de respaldo

`gemini-2.5-flash-lite` → `gemini-2.5-flash` → `groq/llama-3.3-70b-versatile`.

- Cada modelo de Gemini tiene **cuota diaria propia**, así que el fallback
  multiplica el margen. En este proyecto: `2.5-flash` ≈ 20 req/día gratis,
  `2.5-flash-lite` más alta, y **los `2.0-*` tienen límite 0 (inservibles)**.
- Lógica: `gemini_generate()` / `ai_generate()` en `bot.py`, `aiAnswer()` en
  `worker.js`. Manejan 429 (cuota → siguiente modelo) y 503/500 (temporal →
  reintento con espera creciente).
- **El newsletter invierte el orden** (`2.5-flash` primero): es 1 llamada
  semanal y la calidad importa más que la cuota.
- `breaking.py` filtra por palabras clave (`HIGH_IMPACT_KEYWORDS`) **antes** de
  llamar a la IA, para no gastar cuota en horas tranquilas.

## Comandos

```bash
python bot.py                  # resumen 2x/día (envía de verdad)
python breaking.py             # chequeo de alertas
python get_chat_id.py          # descubrir un chat id (solo sin webhook activo)
python scripts/deploy_worker.py  # desplegar/actualizar el Worker
python entorno/render.py       # láminas del newsletter -> entorno/out/<fecha>/
python entorno/render.py --html  # solo HTML, para inspeccionar en el navegador
python al-cierre/daily.py      # Al Cierre completo: datos + láminas + Telegram
```

Ojo: `bot.py`, `breaking.py` y los `send_telegram.py` **envían mensajes reales**
a los destinatarios de `CHAT_ID`. Para probar sin molestar a nadie, pon tu
propio chat id en `CHAT_ID` de tu `.env` local.

Sin Python global en Windows: hay un runtime portátil en `.pyruntime/`
(ignorado por git) porque el instalador normal falló con error 1603.

## Convenciones de código

- **Español** en comentarios, docstrings, mensajes de commit y nombres de
  funciones nuevas del Worker (`bloqueCifras`, `seleccionarNoticias`,
  `puntuar`). El código existente mezcla: no lo renombres masivamente.
- Los comentarios explican **por qué**, no qué. Buena parte de este repo son
  decisiones aprendidas a golpes (ver "Trampas conocidas"); si quitas un
  comentario así, se repite el error.
- Sin dependencias nuevas salvo necesidad real: `requirements.txt` tiene 4
  paquetes y el Worker es JS puro sin bundler.
- No hay tests automatizados. Se prueba corriendo el script y mirando el
  resultado en Telegram, o con los endpoints de depuración del Worker.

## Trampas conocidas (leer antes de depurar)

1. **Propagación del Worker:** tras subirlo tarda ~10-20 s. Si pruebas de
   inmediato responde la versión **anterior** y parece que tu cambio no
   funcionó. Espera y vuelve a probar.
2. **`.env` con BOM:** nunca escribas `.env` con `Set-Content -Encoding utf8`
   en PowerShell 5.1; mete BOM y `python-dotenv` deja de leer la primera clave.
   Usa `[System.IO.File]::WriteAllText` con `UTF8Encoding($false)`.
3. **`get_chat_id.py` no sirve con el webhook activo** (`getUpdates` queda
   vacío). Para agregar destinatarios, que la persona escriba `/id` al bot.
4. **Sufijo " - Medio" en titulares:** hay que quitarlo (`sinMedio()`) antes de
   puntuar. Si no, "Financial Times" cuela cualquier titular por la palabra
   "Financia".
5. **Google News repite el titular en `<description>`:** `resumenUtil()` lo
   descarta. No des por bueno el campo sin filtrar.
6. **Las láminas se cortan en silencio** si la IA escribe largo. Por eso
   `altura_bloque()` le pregunta el `scrollHeight` a Chrome y reescala. No
   quites ese paso.
7. **`al-cierre` hay que correrlo después del cierre de NY (4:00 pm VET)**;
   antes, los índices USA dan valores intradía.
8. **Fuentes que no responden** (403/TLS desde fuera): bancaynegocios,
   finanzasdigital, lapatilla, eleconomista.com.mx, portafolio.co, y el feed de
   sección de El Cronista (404). No las vuelvas a agregar sin verificar.

## Vencimientos y mantenimiento

- **`GITHUB_PAT` vence ~28 de julio de 2027** (creado 2026-07-27, 366 días).
  Cuando venza, el bot sigue mandando el texto del newsletter y avisa "no pude
  disparar el render de las láminas". Hay que regenerarlo (fine-grained,
  Actions read/write) y volver a desplegar el Worker.
- El PAT que usa cron-job.org también es fine-grained con Actions read/write:
  revisar su vencimiento.
- El IPC del BCV no tiene API: se actualiza a mano por chat con
  `/ipc 13,8 129,8 junio 2026`.
- Las bases anuales del newsletter viven en la constante `BASES` de `worker.js`
  y se pueden pisar por KV (`entorno:bases`). **Actualizarlas cada enero.**

## Pendientes conocidos

- Probar de punta a punta el último salto del newsletter (Actions → álbum de
  láminas al chat que lo pidió).
- Rediseño de la plantilla del newsletter (previsto por el dueño). El texto está
  desacoplado del render a propósito: si el render falla, el newsletter escrito
  llega igual.
- Multiusuario de verdad: preferencia de idioma por usuario, alta/baja de
  suscriptores sin editar `CHAT_ID`.
- Filtrar "solo medios verificados" con lista blanca.
