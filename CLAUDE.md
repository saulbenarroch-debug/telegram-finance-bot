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
| 4 | "Entorno en Viñetas" (newsletter semanal + 8 láminas) | `worker.js` + `entorno/` | Worker + Actions `entorno.yml` | **a pedido**; se prearma los lunes |
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
- **Un solo sitio habla con la API de Actions** (`dispararWorkflow`). Hay
  cuatro workflows que disparar: `nota.yml` a petición, `diario.yml` por reloj,
  `subir_borrador.yml` cuando alguien toca «Subirla igual» y `post.yml` cuando
  toca «Solo el post».
- **`/post` no redacta nada.** Dibuja la lámina de Instagram de una pieza **ya
  publicada**: la lee del panel y la dibuja, sin escribir, sin auditar y sin
  crear borrador. Existe porque pedir `/nota` de algo ya publicado ofrecía un
  solo botón —«Escribirla igual»— que rehace la pieza entera y deja un borrador
  duplicado que nadie quería, solo para conseguir el post.
  **El botón manda el `id` y no el `slug`**: en `callback_data` caben 64 bytes
  y los slugs del sitio llegan a 89 caracteres.
  Junto al enlace se puede escribir `titular:`, `bajada:` y `categoría:`, una
  por renglón, y mandarlo como pie de una imagen para imponer el fondo.
- **Una foto con pie `/post` NO es una captura de noticia**, y por eso se mira
  antes de `comandoCaptura`. Es lo contrario: no dice qué escribir, sino con
  qué imagen dibujar la lámina de algo que ya existe. Sin esa rama, el motor se
  ponía a buscar de qué noticia era la foto.

## La plantilla del Entorno en Viñetas

`entorno/render.py` es un clon en código del Canva **«entorno en viñetas»**
(`DAHOniEgyiw`), y desde el 24/09/2026 de su versión de **ocho páginas**:
portada, índice, cuatro noticias, economía en cifras y Latam enlatada. El
encargo del dueño fue literal: *«no quites nada, tu trabajo es añadir las fotos
y la información, no cambiar la plantilla»*. Así que **nada de ese archivo se
estima a ojo**:

- **La geometría sale de la API de Canva**, en las unidades de su lienzo
  (1587,4 × 2245). Cada página se maqueta en esas unidades y se escala a
  1414 px al final, para copiar los números tal cual.
- **Las tipografías salen del PDF exportado**, que incrusta el nombre real de
  cada fuente: Inter, Host Grotesk Light, Montserrat, IBM Plex Mono y Nourd
  Heavy. Nourd no es libre y se sustituye por Archivo Black (solo en las dos
  tasas). Las demás están en `assets/fonts/` con su `OFL.txt`.
- **Se comparó renglón a renglón** con la exportación: todos los textos caen a
  0-2 px de la plantilla.

**La plantilla la sigue editando Edición, y hay que volver a leerla cuando
cambia.** El mismo 24/09/2026 quitó de las páginas de noticia el segundo bloque
(el subtítulo repetido abajo con su párrafo) y dejó en la franja negra **tres
viñetas «▪»**. El modelo ahora escribe la lectura en tres puntos (`LECTURA`
llega como lista) y `render.py` sigue aceptando ediciones viejas, con la lectura
en un solo texto más el `texto2`, que salen como dos viñetas. Para ver qué
cambió: leer el diseño por la API (geometría), exportar la página a
`assets/referencia/` y comparar.

### Tres diferencias entre CSS y Canva que ya costaron una tarde

1. **Dónde cae la primera línea.** CSS reparte el interlineado mitad arriba y
   mitad abajo, también en la primera línea; Canva la pega al borde de la caja.
   Con interlineado menor que 1 CSS subía el bloque entero: 0,105 em con 0,98 y
   0,199 em con 0,8. Las dos medidas cuadran con `(1,194 − interlineado) / 2`,
   y el guion de cada página lo corrige con la métrica de cada familia
   (`ALTO_NATURAL`). Si se añade una tipografía, hay que darle la suya.
2. **Espaciado negativo en textos alineados a la derecha.** CSS lo aplica
   también detrás de la última letra y el texto se sale ~16 unidades de su caja
   («LATAM ENLATADA», los números rojos). La clase `.dcha` lo compensa.
3. **Comillas dentro de `style='…'`.** `font-family:'Archivo Black'` cerraba el
   atributo y las dos tasas desaparecieron de la lámina sin ningún error. Los
   nombres de familia van sin comillas en los estilos en línea.

### Las fotos: cinco donde antes había una, y solo si son de su noticia

- Salen del `og:image` del artículo fuente de cada noticia y de Latam. **Un
  enlace de Google News no sirve**: es un redirector que solo salta con
  JavaScript y no tiene foto. `enlaceDirecto()` busca la misma noticia en el
  historial del KV, que sí trae enlaces del propio medio.
- **Nunca se rellena con la foto de otro titular.** Sin foto, la página lleva
  el mapa de puntos de la propia plantilla en el hueco. Una foto ajena encima
  de una noticia ya dio, en el medio, un derrame petrolero ilustrando un
  acuerdo energético.
- **Cuántas páginas salen con foto depende de Tavily.** Sus búsquedas son las
  que traen enlaces directos de medios venezolanos; con Tavily sin crédito, en
  la primera prueba solo 1 de 5 páginas tuvo foto. Recargarlo mejora esto.

### Lo que la plantilla trae de relleno y NO se publica como dato

- **«Extensión de dolarización informal: 76 %»** es texto de ejemplo: el
  sistema no tiene esa cifra y sale **s/d** hasta que se decida su fuente.
  `render.py` ya lee `datos.dolarizacion.valor` si algún día existe.
- Los «8» de las tasas, el «90 %», las fechas y la línea de «Fuente: Condor
  Ferries» se sustituyen por los datos y las fuentes reales.

### Recursos que no pueden estar en este repo (que es público)

- **La pila de papeles de la portada es una foto de stock de Canva.** Usarla
  dentro del diseño está permitido; publicarla como archivo suelto, no. Vive en
  el KV del Worker (`recurso:pila.png`), la sirve `/recurso` con la misma clave
  que la edición y `render.py` la guarda en `assets/privado/` (en .gitignore).
- **Las referencias** (`assets/referencia/`) llevan las fotos de stock de
  ejemplo. Se regeneran exportando el Canva a PNG de 1414 de ancho.
- En Canva quedó una copia de trabajo, **«BORRABLE - recursos del render de
  Entorno en Viñetas»**, de la que se extrajeron la pila y el mapa con fondo
  transparente. Se puede borrar.

### Si se arma en frío, ya no se arma en el chat

Con cuatro noticias el modelo escribe el doble y hay cinco fotos que buscar:
armarla ya no cabe en los ~30 s de `ctx.waitUntil()` (trampa 10). Así que en
frío `enviarEntorno()` lanza `entorno.yml` con `con_texto=1`, y es `render.py`
quien pide la edición **por HTTP** —una petición no tiene ese corte mientras el
cliente espere—; luego `send_telegram.py --con-texto` manda texto y láminas.

### El botón «Subir al boletín»

Debajo del álbum de láminas, **solo en los chats de `REDACCION_IDS`**, sale un
botón que sube el Entorno al **boletín del sitio** y lo deja **activo**: el
lunes a las 9:00 el sitio lo manda solo por correo a toda la lista. Es de lo
poco de este bot que acaba publicado, y por eso tiene cuatro cerrojos:

1. **Solo lo ve la redacción** (`send_telegram.ofrecer_boletin`) y el Worker lo
   vuelve a comprobar al tocarlo, por si el mensaje se reenvía: `/entorno` lo
   puede pedir cualquiera que hable con el bot.
2. **Se quita en cuanto se toca** (`quitarBotones`), y `boletin.yml` va con
   `concurrency`: dos toques no suben dos veces.
3. **No se pisa nada.** El equipo crea los números de antemano, vacíos y en
   borrador. `subir_boletin.py` rellena el del próximo lunes si está vacío; si
   ya tiene páginas o ya está activo, no lo toca y lo dice.
4. **Activo, no «Enviar ahora».** El panel permite mandarlo en el acto, a la
   lista real y sin vuelta atrás; eso no se usa. Activo deja hasta el lunes
   para arrepentirse: basta con volverlo a borrador en el panel → Boletín.

**Se suben las láminas que se vieron, no otras**: el botón lleva el número de
la corrida de `entorno.yml` que las dibujó y `boletin.yml` se baja su artefacto
(dura 30 días). Van a 1080 px en JPG, que es lo que pide el panel para el correo
(170-260 KB cada una), y la contraportada se usa como texto de vista previa.

**El boletín del panel no es un formato de post**: son números, uno por lunes,
hechos de páginas que son imágenes. La API se sacó del propio panel el
25/09/2026 y está en la cabecera de `subir_boletin.py`. Corre en ESTE repo, que
es público, y no en el del medio, que va justo de minutos de Actions; por eso
aquí están también los secretos `SURECONOMICS_USUARIO` y `SURECONOMICS_CLAVE`.

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
   proyecto. El cron del **lunes** (10:00 UTC) solo prearma la edición en caché.
   Lo que sí sale por correo es el boletín del sitio, y solo si alguien de la
   redacción toca «Subir al boletín» (ver más arriba).
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

**Dos cuentas de Gemini desde el 25/09/2026** (`GEMINI_API_KEY` y
`GEMINI_API_KEY_RESERVA`, las mismas del motor), y el embudo va **primero por
modelo y luego por cuenta** (`embudoGemini` en `worker.js`):

- **Entorno en Viñetas:** flash principal → flash reserva → flash-lite
  principal → flash-lite reserva → Groq. Si el flash falla por saturación (5xx)
  en las dos cuentas, espera 30 s y lo reintenta antes de bajar: es una llamada
  por semana y es lo que se publica. `escrita_por` queda en la edición.
- **Chat:** flash-lite primero, como siempre (muchas preguntas cortas), ahora
  con la segunda cuenta en cada escalón y sin esperas.

Antes el Worker usaba solo la principal: cuando se agotaba su flash, el Entorno
lo escribía flash-lite con el flash de la reserva intacto. **Las dos cuentas son
las mismas que usa el motor**, así que la cuota diaria es compartida. Por eso
el Entorno se prearma los lunes a las **10:00 UTC** (6:00 VET) y no a las 12:00:
a esa hora coincidía con la tanda de la mañana, que le gastaba el flash antes.
La cuota se renueva a las 07:00 UTC.

La cadena del bot de resúmenes (`bot.py`) sigue siendo:
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
10. **El Worker muere sin excepción si `ctx.waitUntil()` pasa de ~30 s, y eso
    no deja rastro en ningún sitio.** No salta el `catch`, no hay mensaje de
    error, no hay log: la persona ve el "dame unos segundos" y silencio para
    siempre. Armar el newsletter tarda **26 s medidos**, más enviar cinco
    mensajes, más disparar las láminas. Se pasaba.

    Lo que lo destapó: `entorno.yml`, que se dispara al FINAL del flujo, llevaba
    once días sin correr. Si algo que va al final no ocurre nunca, sospecha del
    tiempo antes que del código.

    **Los crons no tienen ese problema** —Cloudflare les da quince minutos, no
    treinta segundos—, así que la regla es: lo pesado lo arma el cron y lo deja
    en KV; el chat solo sirve lo que ya está armado.
11. **Un TTL más corto que su cron es una bomba de relojería.** `ENTORNO_TTL`
    estaba en 6 horas y el cron que prearma el newsletter corre los lunes: el
    newsletter funcionaba de 12:00 a 18:00 del lunes y el resto de la semana
    intentaba rearmarse de cero y moría. `ENTORNO_MAX_EDAD`, que avisa a los 8
    días, siempre dio por hecho que la edición del lunes valía la semana; el TTL
    decía otra cosa. **Si tocas uno, mira el otro.**
12. **`sendMessage()` no manda `parse_mode`**: un `<b>` sale a la vista. El HTML
    va por `sendHtml()`, que es por donde viaja el newsletter.
13. **"The job was not acquired by Runner" + "Internal server error" NO es bug
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
- **Fuente de la «extensión de dolarización informal»** de la lámina de cifras:
  sale «s/d» hasta que el dueño diga de dónde se saca.
- **El Worker no tiene el embudo de dos cuentas de Gemini** del motor: el
  newsletter usa solo la principal y, cuando flash se agota, escribe flash-lite,
  que obedece peor los topes de caracteres y repite hechos entre noticias.
- Multiusuario de verdad: preferencia de idioma por usuario, alta/baja de
  suscriptores sin editar `CHAT_ID`.
- Filtrar "solo medios verificados" con lista blanca.
