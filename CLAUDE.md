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
| 3 | Bot conversacional **y reloj del medio** | `cloudflare-worker/worker.js` | Cloudflare Worker | webhook + cron 3h + tandas 8:00 y 14:00 VET |
| 4 | "Entorno en Viñetas" (newsletter semanal + 4 láminas) | `worker.js` + `entorno/` | Worker + Actions `entorno.yml` | **a pedido**; se prearma los lunes |
| 5 | "Al Cierre" (láminas diarias de cierre, Rendigroup) | `al-cierre/` | Actions `al-cierre.yml` | 5:30 pm VET |
| 6 | **Puerta de la redacción de SurEconomics** | `worker.js` | Worker | a petición |

Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) para el detalle de cada uno.

## La puerta del medio (subsistema 6)

Este bot es por donde la redacción le pide piezas al **motor**, que vive en otro
repo (`C:\Users\saulb\sureconomics-medio`, con su propio CLAUDE.md). Aquí solo
está la puerta: entender qué se pide y disparar el workflow. **Nada se redacta en
este repo.**

**Quién puede.** Solo los chat id de `REDACCION_IDS` (`enLaRedaccion()`). Sin eso,
cualquiera que dé con el bot gasta cuota de IA y crea borradores en el panel, y
en Telegram cualquier miembro de un grupo puede añadir a otro.

**Qué entiende.** `/nota` acepta un enlace, un tema escrito a mano, una captura
de pantalla o un enlace de X o de Instagram. Y también se pide hablando:

```
redáctame un artículo sobre el acuerdo petrolero
redacta una columna de Óscar Doval sobre el crudo
hazme un reportaje del litio
```

Tres piezas hacen eso, y el ORDEN entre ellas importa:

1. `tipoDelPedido()` — la palabra ("artículo", "columna", "reportaje") sale de
   `TIPOS_PEDIDO`, que es la misma tabla de la que se construye el patrón: así
   añadir un tipo no puede dejarlos desincronizados.
2. `autorDelPedido()` — va **después**, porque el tipo decide si un «de Fulano»
   es la firma o el tema.
3. `temaDelPedido()` — sobre lo que queda, ya sin el verbo ni la firma.

### Lo que hay que saber antes de tocarlo

- **El patrón es estrecho a propósito.** Exige un verbo en imperativo pegado a la
  palabra del tipo. Con algo más suelto se dispararía una corrida de Actions cada
  vez que alguien pregunte «¿qué noticias hay de Chevron?», que es la pregunta
  más común que recibe el bot. Falso negativo: la persona escribe `/nota`. Falso
  positivo: se gasta una corrida y aparece un borrador que nadie pidió.
- **Se compara sin tildes, pero se recorta sobre el original.** El primer patrón
  no reconocía «redáctame», que es literalmente como se pidió. Y las tildes se
  conservan en lo que viaja: «Maria Corina Machado» sin tilde busca peor, y una
  firma se publica.
- **«De» no basta como señal de autoría.** «Una noticia de Nicolás Maduro» habría
  firmado la pieza como Maduro: en español «de» introduce igual al autor que al
  tema. El «de» suelto solo cuenta en los tipos que van firmados (Opinión,
  Investigación); para el resto hace falta «firma: X». Y se exigen dos palabras
  en mayúscula: con una sola, «una columna de Venezuela» firmaba como
  «Venezuela».
- **`autor` y `quien` no son lo mismo.** `quien` es quien encarga y solo sale en
  el correo interno; `autor` es quien FIRMA en el sitio.
- **El enlace no cabe en `callback_data`** (64 bytes), así que los botones llevan
  solo un número y el Worker recupera la dirección del propio mensaje. Así no hay
  estado que caduque ni que limpiar. **Hay dos sitios de donde sacarla y los dos
  hacen falta:** las líneas `/nota <url>` del texto, para los avisos con varios
  candidatos numerados donde el orden importa; y `entities[].url`, porque
  Telegram manda la dirección de un `<a href>` ahí y **no** dentro de `text`. Lo
  segundo es lo que permite que el aviso de «repetida» pase la fuente sin enseñar
  ningún comando: la persona ve dos botones y ya.
- **`subir:<corrida>` no redacta nada.** Dispara `subir_borrador.yml` en el repo
  del medio, que se baja el artefacto de aquella corrida y sube el texto **exacto**
  que la persona ya leyó. Es distinto de `forzar:N`, que reescribe desde cero y
  devuelve un texto parecido pero no el que aprobó. El número de corrida sí cabe
  en `callback_data`: son once dígitos.
- **El asistente de consultas ve los enlaces de las noticias.** Antes no se los
  pasábamos y, cuando alguien pedía «dame la fuente para el /nota», no podía
  darla: no la había visto. Es justo el caso en que un modelo se inventa una URL
  con buena pinta.
- **Un solo sitio habla con la API de Actions** (`dispararWorkflow`). Hay tres
  workflows que disparar: `nota.yml` a petición, `diario.yml` por reloj y
  `subir_borrador.yml` cuando alguien toca «Subirla igual».

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
4. **El reloj nunca es `schedule:` de GitHub Actions.** Llega tarde y no poco:
   medido el 01/09/2026, el cron de las 12:00 UTC llegó a las 16:22 y el de las
   18:00 a las 20:53; el 04/09 el de las 18:00 apareció a las 20:37. Para algo
   que se titula "la tanda de la mañana", cuatro horas tarde no es un retraso.

   Los workflows son `workflow_dispatch` y los dispara un reloj de fuera:
   - **Este repo:** cron-job.org (configurado a mano en su web, sin API).
   - **El medio (`sureconomics-medio`):** el **cron del propio Worker**
     (`DIARIO_CRON` en `worker.js`, desplegado por `CRONS` en
     `scripts/deploy_worker.py`). Se eligió sobre cron-job.org porque el Worker
     ya tenía el `GITHUB_PAT`, ya sabía hablar con la API de Actions y ya corría
     crons: cero cuentas nuevas y cero credenciales que mantener.

   `diario.yml` **sí conserva su `schedule:`, y a propósito**: su job `guardia`
   corre siempre ante un disparo pedido y salta el del reloj si esa tanda ya
   salió. Si Cloudflare falla, el de GitHub llega tarde pero llega; si
   Cloudflare funciona, el de GitHub se descarta solo. Eso no es volver a poner
   `schedule` como reloj: es dejarlo de red.
5. **No hay envío programado del newsletter**, por decisión del dueño del
   proyecto. El cron del **lunes** solo prearma la edición en caché.
   Se movió de viernes a lunes el 08/09/2026, cuando el newsletter pasó a
   publicarse los lunes: prearmarlo el viernes lo dejaba con tres días
   encima, que en economía es media vida.

## Voz editorial (Sureconomics)

**La voz del resumen 2x/día vive en `perfiles/bot-telegram.md`, no en el código.**
`write_briefing()` la carga con `cargar_perfil()` y solo sustituye `{{turno}}` y
`{{fecha}}`. Para cambiar la voz se edita ese archivo; no hay que abrir Python.

Se sacó del código porque ahora hay **dos productos con voces distintas**: este
bot (*pragmático y NO partidista*) y el medio **SurEconomics**
(`C:\Users\saulb\sureconomics-medio`, línea *progresista sin extremos*, decisión
del dueño). Mismo motor, perfiles separados: **cambiar la voz del medio no puede
tocar la de este bot**. Si algún día se unifican, es una decisión editorial, no
un efecto colateral de un refactor.

- La sustitución usa `.replace()` con tokens `{{...}}` y **no** `str.format()`:
  el perfil lo edita gente de edición y una llave suelta en el texto no puede
  tumbar el bot.
- `promptEntorno()` (`worker.js`) **todavía tiene su voz incrustada**. El Worker
  es JS sin bundler y no puede leer un archivo del repo en ejecución; cuando se
  migre, hay que inyectar el perfil al desplegar (`scripts/deploy_worker.py`).

Si tocas un prompt, respeta:

- **Primera persona plural** con criterio propio.
- Cada tema = hechos + una línea **"Nuestra lectura:"** (EN: *"Our take:"*).
- **Pragmático y no partidista**: se celebra lo bueno venga de quien venga.
- Pro-inversión en el sur pero **honesto con las fragilidades** (dependencia
  petrolera, presión cambiaria, riesgo institucional).
- Secciones con carácter (ej. *"Tierra de Gracia"* = Venezuela).
- Sin tono publicitario, sin asteriscos ni `#`: Telegram usa `<b>HTML</b>`.

## IA: cadena de respaldo

`gemini-3.5-flash-lite` → `gemini-3.5-flash` → `openai/gpt-oss-120b` (Groq).

> Revisado contra `/models` el 28/08/2026. Este apartado decía
> `groq/llama-3.3-70b-versatile`, que **Groq apagó el 16 de agosto de 2026**.
> El código ya se había migrado (ver el comentario de `GROQ_MODEL` en `bot.py`),
> pero la guía seguía nombrando un modelo muerto como red de seguridad, que es
> justo lo que alguien lee con prisa cuando algo se cae.

- Cada modelo de Gemini tiene **cuota diaria propia**, así que el fallback
  multiplica el margen. Los `2.0-*` tenían límite 0 y eran inservibles; la
  familia `3.5` es la vigente.
- **Los modelos de imagen de Gemini tienen límite 0 en el plan gratuito**
  (comprobado el 28/08/2026: aparecen en la cuenta y devuelven 429 con
  `limit: 0`). Generar imágenes exige facturación activada.
- **Groq bloquea las IP de VPN y de centros de datos.** Desde la máquina del
  dueño siempre da 403, que parece una caída sin serlo. Se comprueba con el
  workflow `Comprobar Groq`, que corre desde una IP limpia.
- **El modo JSON nativo de Groq (`response_format: json_object`) sigue dando
  400** en todos los modelos probados. Por eso el respaldo pide el JSON dentro
  del prompt. No lo "arregles" pensando que ya funciona.
- Lógica: `gemini_generate()` / `ai_generate()` en `bot.py`, `aiAnswer()` en
  `worker.js`. Manejan 429 (cuota → siguiente modelo) y 503/500 (temporal →
  reintento con espera creciente).
- **El newsletter invierte el orden** (`3.5-flash` primero): es 1 llamada
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
8. **Fuentes que no responden** (403/TLS desde fuera): finanzasdigital,
   lapatilla, portafolio.co, y el feed de sección de El Cronista (404). No las
   vuelvas a agregar sin verificar.

   **Y hay que probar el RSS y el ARTÍCULO por separado**, porque no siempre
   caen juntos. `bancaynegocios.com` estaba en esta lista y era media verdad: su
   feed sí está muerto (`/feed/` y `/rss` cierran la conexión), pero sus
   artículos se leen sin problema, y con esa entrada nos perdimos la única
   cobertura de las licencias de la OFAC sobre minería. En el motor está en
   `REFERENCIA` —se busca, no se sindica— y no en `MEDIOS`. Lo mismo pasa con
   `eleconomista.com.mx`, que hoy se lee bien.
9. **Feedparser/urllib NO traen timeout:** una fuente que acepta la conexión y
   luego **no responde** (no un 403, un cuelgue) trababa el job ~15 min y lo
   hacía fallar. `bot.py` fija `socket.setdefaulttimeout(25)` y los workflows
   tienen `timeout-minutes`. No quites ninguno de los dos.
10. **"The job was not acquired by Runner" + "Internal server error" NO es bug
    del código:** es GitHub que no asigna runner, casi siempre por **minutos de
    Actions agotados** (repo privado = 2.000 min/mes gratis; con presupuesto $0 y
    "stop usage" se bloquean las corridas). La corrida dura ~15 min "intentando"
    y falla. **El repo es PÚBLICO** justo por esto: Actions gratis e ilimitado.
    Antes de diagnosticar el código, revisa Billing → Actions.

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
