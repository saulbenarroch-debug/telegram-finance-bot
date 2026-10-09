// Sureconomics — bot conversacional con memoria (Cloudflare Worker + KV)
// Bindings necesarios: TELEGRAM_TOKEN, GEMINI_API_KEY (y GEMINI_API_KEY_RESERVA / _RESERVA_2,
// opcional: la segunda cuenta del embudo), GROQ_API_KEY,
//                      WEBHOOK_SECRET, y KV (namespace de Cloudflare KV).

// Los 2.5 dan 404 en proyectos nuevos ("no longer available to new users").
// Se descubrio al migrar la clave a la cuenta de la empresa (24/08/2026).
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
// Groq retiro la familia llama-3.3 (404 "does not exist"). El respaldo
// llevaba tiempo roto sin que se notara, porque solo se activa cuando
// Gemini falla. Comprobado el 24/08/2026 desde Actions.
const GROQ_MODEL = "openai/gpt-oss-120b";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; SureconomicsBot/1.0)" };
// Para bajar la portada de un medio hay que parecer navegador, no bot.
const BROWSER_UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "es-419,es;q=0.9",
};

const GN = (q, hl = "es-419", gl = "US", ceid = "US:es-419") =>
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(q) +
  `&hl=${hl}&gl=${gl}&ceid=${ceid}`;

const SURAMERICA_Q =
  '(economía OR PIB OR inversión OR "banco central" OR fiscal OR déficit OR ' +
  "crecimiento OR reforma OR dólar OR bonos OR exportaciones) " +
  '("América del Sur" OR Suramérica OR Brasil OR Argentina OR Chile OR Colombia ' +
  "OR Perú OR Uruguay OR Bolivia OR Paraguay OR Ecuador) " +
  "-fútbol -deportes -selección -partido";
const MA_Q_ES =
  '("fusiones y adquisiciones" OR "adquiere" OR "adquirió" OR "compra la" OR ' +
  '"OPA" OR "toma el control de" OR "fusión con") (empresa OR compañía OR grupo ' +
  "OR banco OR petrolera OR Latinoamérica OR Sudamérica OR Brasil OR México OR " +
  "Colombia OR Chile OR Argentina OR Perú)";
const MA_Q_EN =
  '(M&A OR merger OR acquisition OR acquires) ("Latin America" OR "South America" ' +
  "OR Brazil OR Mexico OR Colombia OR Chile OR Argentina OR Peru)";

// Fuentes que el cron ingiere al historial guardado.
const FEEDS = [
  { cat: "Suramérica", url: GN(SURAMERICA_Q) },
  { cat: "M&A", url: GN(MA_Q_ES) },
  { cat: "M&A", url: GN(MA_Q_EN, "en-US", "US", "US:en") },
  { cat: "Venezuela", url: "https://www.elnacional.com/economia/feed/" },
  { cat: "Venezuela", url: "https://www.descifrado.com/category/economia/feed/" },
  { cat: "Venezuela", url: "https://efectococuyo.com/economia/feed/" },
  { cat: "Venezuela", url: "https://talcualdigital.com/category/economia/feed/" },
  { cat: "Venezuela", url: "https://elestimulo.com/feed/" },
  // Fuentes de nicho de LatAm (negocios, M&A, VC, fintech). Se usan los feeds de
  // SECCIÓN de Bloomberg Línea, no el del sitio completo: el generalista (y el de
  // El Cronista, ya retirado) traía recetas y horóscopos que ensuciaban todo.
  { cat: "Suramérica", url: "https://www.bloomberglinea.com/arc/outboundfeeds/rss/category/economia/?outputType=xml" },
  { cat: "Suramérica", url: "https://www.bloomberglinea.com/arc/outboundfeeds/rss/category/mercados/?outputType=xml" },
  { cat: "M&A", url: "https://latamlist.com/feed/" },
  { cat: "Suramérica", url: "https://iupana.com/feed/" },
  { cat: "Global", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { cat: "Global", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
];

// La ayuda tiene que nombrar lo que el bot sabe hacer HOY. Hasta el 02/09/2026
// seguia describiendo solo el asistente de consultas, sin mencionar /nota ni
// las capturas, que es la mitad del trabajo que hace ahora. Si alguien nuevo
// escribe /start y no ve una funcion, esa funcion no existe para esa persona.
const WELCOME =
  "👋 Soy el asistente de SurEconomics. Hago dos cosas.\n\n" +
  "<b>1. Respondo preguntas</b> sobre economía de Venezuela, Suramérica, " +
  "fusiones y adquisiciones o mercados. Guardo historial, así que puedo " +
  "comentar también lo de días anteriores:\n" +
  "• ¿Qué está pasando con el dólar en Venezuela?\n" +
  "• Busca noticias de litio en Argentina\n\n" +
  "<b>2. Escribo notas para el panel</b>, si estás en la redacción. Todo lo " +
  "que escribo queda en BORRADOR: publicar lo hace una persona.\n" +
  "• <code>/nota &lt;enlace&gt;</code> — la escribo desde esa fuente\n" +
  "• <code>/nota &lt;tema&gt;</code> — sin enlace: busco quién lo cuenta en la " +
  "lista de medios y cruzo hasta tres\n" +
  "• <code>/nota &lt;enlace&gt; hazla editorial</code> — lo que escribas " +
  "detrás es una instrucción de edición\n" +
  "• <code>/nota &lt;enlace&gt; igual</code> — la escribo aunque ya esté publicada\n" +
  "• <b>Mándame una captura</b> de una noticia y busco el original para " +
  "escribirla. Si me dices «súbela con esta imagen», la uso de portada\n\n" +
  "<b>3. Hago el post de Instagram</b> de algo YA publicado, sin reescribirlo.\n" +
  "• <code>/post &lt;enlace&gt;</code> — la lámina de esa pieza\n" +
  "• Escribe debajo <code>titular:</code>, <code>bajada:</code> o " +
  "<code>categoría:</code> para poner tú el texto\n" +
  "• Mándalo como pie de una imagen y la uso de fondo\n\n" +
  "📰 Newsletter semanal: pídeme «dame el entorno en viñetas» (o /entorno). " +
  "Se arma solo los lunes a las 8:00 a.m.\n\n" +
  "Tu chat ID, por si te piden dar de alta: /id";

// ---------------------------------------------------------------------------
// ENTORNO EN VIÑETAS — newsletter semanal (contraportada, noticia principal,
// economía en cifras y Latam enlatada). Regla de oro: las CIFRAS las calcula
// este código a partir de fuentes duras; la IA solo redacta la prosa.
// ---------------------------------------------------------------------------
// LUNES, no viernes, desde el 08/09/2026. El newsletter pasó a publicarse los
// lunes y el prearmado seguía siendo del viernes: la edición llegaba con tres
// días encima, que en economía es media vida. Misma hora, otro día.
// LUNES 10:00 UTC = 6:00 a.m. VET, DESDE EL 25/09/2026. Antes era a las 12:00 y
// coincidia con la tanda de la manana (DIARIO_CRON): las dos tiran de la misma
// cuota diaria de flash de las mismas dos cuentas de Gemini, que se renueva a
// las 07:00 UTC, y la tanda la gastaba antes que el Entorno. A las 10:00 el
// Entorno llega primero con la cuota recien renovada. No se envia a nadie:
// solo queda armado para cuando lo pidan.
// OJO CON LOS DIAS: EN CLOUDFLARE EL 1 ES EL DOMINGO, no el lunes como en el
// cron de GitHub o de Linux (documentado: «1 = Sunday to 7 = Saturday»). Hasta
// el 28/09/2026 aqui ponia "1" y "1-5" creyendo que era lunes y lunes-viernes:
// el Entorno se prearmaba el DOMINGO, las tandas y la vigilancia corrian de
// domingo a jueves, y el viernes no salia nada por el Worker (las tandas de los
// viernes las salvaba el schedule de GitHub, con horas de retraso). Se vio
// porque el 27/09, domingo, hubo dos tandas y una edicion del Entorno. Lunes = 2,
// lunes a viernes = 2-6.
const ENTORNO_CRON = "0 10 * * 2";
// Las dos tandas del medio, de lunes a viernes:
//   12:00 UTC = 8:00 a.m. VET   18:00 UTC = 2:00 p.m. VET
// Van en UNA sola expresion y no en dos para no gastar dos disparadores de los
// cinco que da el plan gratuito de Cloudflare.
const DIARIO_CRON = "0 12,18 * * 2-6";

// LA VIGILANCIA, CADA CUARTO DE HORA Y EN HORARIO DE REDACCION.
//
// Estaba en el `schedule:` de GitHub pidiendo una ronda cada hora, y lo que
// hacia de verdad era esto (medido del 16 al 18/09/2026):
//
//   tocaba 17:00 -> corrio 17:56     tocaba 23:00 -> corrio 00:53
//   tocaba 14:00 -> corrio 14:41     tocaba 23:00 -> corrio 00:57
//
// O sea: de veinte minutos a casi dos horas tarde, y dos rondas llegando
// pasada la medianoche, fuera ya de la franja en la que alguien lee el grupo.
// Una vigilancia con dos horas de retraso no es una vigilancia.
//
// De 11:00 a 23:00 UTC = 7:00 a 19:00 en Venezuela, la misma franja que tenia.
// Fuera de ahi no hay nadie mirando y un aviso que nadie ve solo sirve para que
// el siguiente se ignore tambien.
//
// NO CUESTA CUOTA DE IA: vigilar.py no llama ni a Gemini ni a Tavily, puntua con
// criterio.py, que es codigo. Son 52 rondas al dia y cada medio recibe una
// peticion cada cuarto de hora, que es sondeo normal de RSS.
// OJO A LA LISTA EXPLICITA EN VEZ DE "*/15". Se desplego primero como
// "*/15 11-23 * * 1-5", Cloudflare lo acepto y lo registro, el codigo
// desplegado tenia la cadena identica... y no disparo ninguna de las cuatro
// ventanas siguientes (19:00, 19:15, 19:30 y 19:45 del 18/09/2026). Los tres
// crones que si funcionan usan paso solo en el campo de la HORA
// ("0 */3 * * *"); ninguno lo usaba en el de los minutos.
//
// No esta demostrado que esa sea la causa -tambien pudo ser que un cron recien
// creado tarde en activarse-, y por eso queda escrito: si algun dia esto vuelve
// a fallar, empieza por aqui en vez de repetir la investigacion entera.
// CADA CUARTO DE HORA OTRA VEZ DESDE EL 28/09/2026: el repo del medio paso a
// PUBLICO y alli Actions no cobra minutos. Si vuelve a privado, VOLVER A
// "0,30 ...": lo de abajo sigue valiendo para ese caso.
// Estuvo CADA MEDIA HORA DESDE EL 24/09/2026, Y NO CADA CUARTO: por los minutos de
// Actions. vigilancia.yml corre en sureconomics-medio, que es PRIVADO y tiene
// 2.000 minutos gratis al mes. Cada cuarto de hora eran 52 rondas al dia y unos
// 1.600 minutos al mes solo de vigilancia: con las tandas y los /nota, el mes
// de septiembre llego al 90 % el dia 24. Cada media hora son ~800. Decision del
// dueno "por ahora": si se paga el exceso ($0,006 el minuto), se puede volver
// a cada cuarto de hora sabiendo que son unos $6 al mes.
const VIGILANCIA_CRON = "0,15,30,45 11,12,13,14,15,16,17,18,19,20,21,22,23 * * 2-6";
// Repo donde vive el workflow que dibuja las laminas (Chrome headless no corre
// en un Worker, asi que el render se delega a GitHub Actions).
const GITHUB_REPO = "saulbenarroch-debug/telegram-finance-bot";
// El medio vive en otro repositorio. El mismo PAT llega a los dos.
const REPO_MEDIO = "saulbenarroch-debug/sureconomics-medio";
// CUÁNTO SE REUSA UNA EDICIÓN YA ARMADA. Es un newsletter SEMANAL: la edición
// del lunes es la de la semana, y darla el jueves no es servir algo viejo, es
// servir la que toca. ENTORNO_MAX_EDAD, que avisa a los 8 días, siempre dio por
// hecho eso; el TTL decía 6 horas y se contradecían.
//
// LO QUE COSTABA, medido el 14/09/2026: el cron prearma la edición los lunes a
// las 12:00 UTC, así que con 6 horas el newsletter estaba servible entre las
// 12:00 y las 18:00 del lunes y NADA MÁS. El resto de la semana cada petición
// intentaba rearmarlo de cero, y eso tarda 26 segundos.
//
// Veintiséis segundos no caben donde corre esto. Por Telegram el armado va en
// ctx.waitUntil(), o sea DESPUÉS de haber contestado "ok", y ese contexto lo
// corta Cloudflare a los ~30 s. Sumando el armado más enviar cinco mensajes más
// disparar las láminas, se pasa: el Worker muere SIN LANZAR EXCEPCIÓN, así que
// no salta el catch y no se manda ni el texto ni el aviso de error. Desde el
// chat se ve como "Armando el Entorno en Viñetas…" y silencio para siempre.
// Encaja con que entorno.yml, que se dispara al final del todo, llevara once
// días sin correr.
//
// El cron SÍ puede con los 26 s -los disparadores cron de Cloudflare tienen
// quince minutos, no treinta segundos-, y por eso la solución es que lo que
// arma el lunes dure la semana entera y nadie tenga que rearmarlo a mano.
const ENTORNO_TTL = 7 * 24 * 60 * 60; // una semana: lo que dura una edición
const ENTORNO_MAX_EDAD = 8 * 24 * 60 * 60 * 1000; // ms antes de avisar que está vieja

// Bases de comparación anual (editables por KV: entorno:bases).
const BASES = {
  bcv: 301.37, // tasa BCV del 1-ene-2026
  ibc: 2082.26, // cierre del IBC en 2025
};

// Último IPC publicado por el BCV (editable por chat con /ipc).
const IPC_DEFAULT = { mes: "junio 2026", mensual: 13.8, acumulada: 129.8 };

// Semillas del histórico: permiten calcular variación semanal desde el día 1.
const SEED_BCV = { "2026-07-21": 737.2321, "2026-07-24": 742.2292 };
const SEED_IBC = { "2026-07-17": 5144.74, "2026-07-23": 5173.61 };

const YF_TICKERS = [
  { k: "dow", t: "^DJI", n: "Dow Jones", dec: 2 },
  { k: "sp500", t: "^GSPC", n: "S&P 500", dec: 2 },
  { k: "nasdaq", t: "^IXIC", n: "Nasdaq", dec: 2 },
  { k: "brent", t: "BZ=F", n: "Petróleo Brent", dec: 2 },
  { k: "oro", t: "GC=F", n: "Oro", dec: 2 },
  { k: "btc", t: "BTC-USD", n: "Bitcoin", dec: 0 },
  { k: "eth", t: "ETH-USD", n: "Ethereum", dec: 0 },
];

const ENTORNO_Q_VZ =
  "(Venezuela) (economía OR BCV OR dólar OR inflación OR Pdvsa OR petróleo OR " +
  "bonos OR deuda OR sanciones OR bolívar OR reconstrucción)";
const ENTORNO_Q_LATAM =
  "(economía OR PIB OR inflación OR \"banco central\" OR tasa OR déficit OR " +
  "exportaciones OR adquisición) (México OR Brasil OR Argentina OR Colombia OR " +
  "Chile OR Perú OR Uruguay) -fútbol -deportes";
const ENTORNO_Q_GLOBAL =
  "(petróleo OR Brent OR \"Wall Street\" OR Fed OR oro OR bitcoin OR OPEP) " +
  "(mercados OR precio OR cierre OR semana)";

// Los feeds generalistas (El Cronista, Bloomberg Línea) traen mucho estilo de
// vida y clickbait: sin estos filtros el newsletter termina citando recetas.
const JUNK_RE =
  /(receta|hor[oó]scopo|farándula|far[aá]ndula|f[uú]tbol|futbol|deportiv|selecci[oó]n nacional|clima|lluvia|hurac[aá]n|visa|pasaporte|migrator|migrante|turismo|viral|tiktok|belleza|dieta|bicarbonato|limpieza|truco|ciudad flotante|anses|jubilad|loter[íi]a|netflix|serie|pel[íi]cula|famoso|astrolog|zodiac)/i;
const ECON_RE =
  /(econom|inflaci|ipc|pib|d[oó]lar|euro|peso|real |bolívar|bol[íi]var|banco central|tasa|inter[eé]s|bono|deuda|d[eé]ficit|fiscal|export|import|inversi|mercado|bolsa|acciones|adquisici|fusi[oó]n|compra|adquiere|opa|petr[oó]leo|crudo|barril|gas|miner|litio|cobre|energ|fmi|\bbid\b|banco mundial|moody|fitch|riesgo pa[íi]s|reservas|remesas|empleo|desempleo|salario|impuesto|arancel|comercio|superávit|super[aá]vit|pdvsa|bcv|selic|banxico|cepal|petrobras|pemex|ecopetrol|codelco|cemex|empresa|compañ|grupo |banco |fintech|financiamiento|financiaci|refinanc|cr[eé]dito)/i;
// Hechos duros de política económica o corporativa: es lo que debe encabezar.
const MACRO_FUERTE_RE =
  /(inflaci|ipc|pib|devaluaci|default|reestructuraci|sanci[oó]n|sanciones|licencia|ofac|fmi|banco mundial|banco central|tasa de inter[eé]s|d[eé]ficit|super[aá]vit|deuda|bonos|adquisici|fusi[oó]n|emisi[oó]n|arancel|reservas|barril|opep|producci[oó]n petrolera|recorte|alza de tasas|calificaci[oó]n)/i;
// Medios con estándar editorial: suma reputación, no la exige.
const MEDIOS_OK_RE =
  /(reuters|bloomberg|financial times|wall street journal|el pa[íi]s|expansi[oó]n|banca y negocios|finanzas ?digital|efecto cocuyo|descifrado|el nacional|el est[íi]mulo|talcual|infobae|el cronista|la naci[oó]n|clar[íi]n|folha|valor econ|estad[aã]o|semana|la rep[uú]blica|portafolio|el mercurio|diario financiero|el economista|el financiero|forbes|am[eé]rica econom[íi]a|latamlist|iupana|world oil|argus|platts|s&p global|cepal)/i;
// Formatos de tráfico: titulares que nunca traen un hecho nuevo.
const CLICKBAIT_RE =
  /(esto es lo que|todo lo que|as[íi] es como|mira c[oó]mo|no vas a creer|te contamos|en vivo|minuto a minuto|paso a paso|lo que debes saber|cu[áa]nto cuesta|as[íi] qued[oó]|ranking de|los \d+ mejores|conoce |sepa |encuesta de opini)/i;

// Para repartir cupo: un país no puede acaparar la sección de Latam.
const PAISES = [
  ["Argentina", /argentin|milei|merval|buenos aires|\bafip\b/i],
  ["Brasil", /brasil|brazil|lula|selic|ibovespa|petrobras|\breal brasile/i],
  ["México", /m[eé]xico|mexican|banxico|sheinbaum|pemex|cemex/i],
  ["Colombia", /colombia|petro|ecopetrol|colcap|bancolombia|cibest/i],
  ["Chile", /chile|codelco|\bipsa\b|boric/i],
  ["Perú", /per[uú]\b|lima|sunat/i],
  ["Ecuador", /ecuador|noboa/i],
  ["Uruguay", /uruguay/i],
  ["Bolivia", /bolivia/i],
  ["Paraguay", /paraguay/i],
  ["Panamá", /panam[aá]/i],
  ["Rep. Dominicana", /dominican/i],
  ["Centroamérica", /costa rica|guatemala|honduras|salvador|nicaragua/i],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Endpoint protegido para poblar el historial manualmente.
    if (url.pathname === "/ingest" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const n = await ingest(env);
      return new Response("ingested " + n);
    }
    // Que cron disparo el ultimo, para saber si el reloj vive. Ver el comentario
    // de scheduled().
    if (url.pathname === "/entorno" && url.searchParams.get("crones") &&
        url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const ultimo = await kvGet(env, "cron:ultimo", null);
      return new Response(JSON.stringify(ultimo || { aviso: "aun no ha disparado ninguno" }, null, 2),
        { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    // RECURSOS DEL RENDER QUE NO PUEDEN IR EN EL REPO. El repositorio es
    // público (trampa 13: por los minutos de Actions) y la pila de papeles de la
    // portada del Entorno es una foto de stock de Canva: usarla dentro del
    // diseño está permitido, publicarla como archivo suelto no. Vive en KV y
    // render.py la pide con la misma clave con la que pide la edición.
    if (url.pathname === "/recurso" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const nombre = String(url.searchParams.get("nombre") || "");
      if (!/^[a-z0-9.-]{1,40}$/.test(nombre)) return new Response("nombre no válido", { status: 400 });
      const datos = await env.KV.get("recurso:" + nombre, "arrayBuffer");
      if (!datos) return new Response("no existe", { status: 404 });
      return new Response(datos, {
        headers: { "Content-Type": nombre.endsWith(".png") ? "image/png" : "application/octet-stream" },
      });
    }
    // Endpoint protegido para revisar el newsletter sin pasar por Telegram.
    // /entorno?key=...&force=1 rearma la edición; &datos=1 muestra solo las cifras.
    if (url.pathname === "/entorno" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      try {
        if (url.searchParams.get("datos")) {
          const d = await gatherEntornoData(env);
          return new Response(JSON.stringify(d, null, 2), {
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const ed = await getEntorno(env, !!url.searchParams.get("force"));
        // formato=json: lo que consume entorno/render.py para armar las láminas.
        if (url.searchParams.get("formato") === "json") {
          return new Response(
            JSON.stringify(
              {
                hoy: ed.datos.hoy,
                generado: new Date(ed.ts).toISOString(),
                datos: ed.datos,
                secciones: ed.secciones || {},
                noticias: ed.noticias || [],
                escrita_por: ed.escrita_por || "",
                latam: ed.latam || null,
                semana: ed.semana || null,
                titular: ed.titular || "",
                eventos: ed.eventos || [],
                escenario: ed.escenario || "",
                portada: ed.portada || null,
                titulares: ed.titulares || [],
                // El texto ya maquetado para Telegram. Lo usa send_telegram.py
                // cuando la edición se armó en frío desde Actions y hay que
                // mandar también el texto, no solo las láminas.
                parts: ed.parts || [],
              },
              null,
              2
            ),
            { headers: { "Content-Type": "application/json; charset=utf-8" } }
          );
        }
        return new Response(ed.parts.join("\n\n———\n\n"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (e) {
        return new Response("error: " + (e && e.message ? e.message : e), { status: 500 });
      }
    }
    if (request.method !== "POST") return new Response("Sureconomics bot activo ✅");
    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("ok");
    }
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("ok");
  },

  // Crons (se configuran al desplegar):
  //  - "0 */3 * * *" ingiere noticias y tasas al historial.
  //  - ENTORNO_CRON (lunes 6:00 a.m. VET) prearma el newsletter semanal y lo
  //    deja en KV. No se envía a nadie: queda listo para cuando lo pidan.
  //  - DIARIO_CRON (12:00 y 18:00 UTC, L-V) lanza la tanda del medio.
  //
  // OJO AL ORDEN: hasta el 25/09/2026 los LUNES a las 12:00 coincidian
  // ENTORNO_CRON y DIARIO_CRON (ya no: el Entorno pasó a las 10:00). Aun asi,
  // Cloudflare entrega un evento por cada expresion, con su event.cron, y esa
  // es la forma de distinguirlos: no se cambian estos if por horas.
  async scheduled(event, env, ctx) {
    // QUE CRON DISPARO Y CUANDO, EN KV. Sin esto, "el cron no salta" y "el cron
    // salta pero cae en el else" son indistinguibles desde fuera, y el else
    // ejecuta la ingesta en silencio. El 18/09/2026 costo una tarde averiguar
    // cual de las dos era. Se lee en /entorno?key=...&crones=1.
    ctx.waitUntil(kvPut(env, "cron:ultimo", {
      cron: event.cron, cuando: new Date(event.scheduledTime).toISOString(),
    }));
    if (event.cron === DIARIO_CRON) {
      ctx.waitUntil(dispararTanda(env, event.scheduledTime));
    } else if (event.cron === ENTORNO_CRON) {
      ctx.waitUntil(getEntorno(env, true));
    } else if (event.cron === VIGILANCIA_CRON) {
      // Solo dispara el workflow y se va: la ronda entera corre en Actions, que
      // no tiene el limite de ~30 s de ctx.waitUntil() que se llevo por delante
      // el newsletter el 14/09/2026.
      //
      // Ventana de 1 hora con rondas cada 15 minutos: se solapan a proposito.
      // Un titular que aparezca justo en el borde lo ve la ronda siguiente, y
      // repetirlo no molesta porque vigilancia_estado.json recuerda lo avisado.
      ctx.waitUntil(dispararWorkflow(env, "vigilancia.yml", { horas: "1" }));
    } else {
      ctx.waitUntil(ingest(env));
      // El calendario de ForexFactory, guardado en KV cada tres horas: limita
      // las peticiones (429) y el lunes no puede faltar. Ver agendaForex().
      ctx.waitUntil(bajarForex(env));
    }
  },
};

async function handleUpdate(update, env) {
  // Botones de la franja dudosa. Cuando una captura no casa con seguridad con
  // ningun original, nota.py contesta con los candidatos y un boton por cada
  // uno; esto es lo que atiende el toque.
  if (update.callback_query) {
    await comandoBoton(env, update.callback_query);
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;

  // UNA FOTO ES UNA NOTICIA QUE ALGUIEN VIO. Los jefes mandan las noticias como
  // capturas de Instagram, asi que una foto sin texto no es ruido: es un
  // encargo. Va antes del filtro de abajo, que hasta hoy las tiraba todas.
  if (msg.photo && msg.photo.length) {
    // UNA FOTO CON PIE "/post" NO ES UNA CAPTURA DE NOTICIA. Es justo lo
    // contrario: no dice QUE escribir, sino con que imagen dibujar la lamina de
    // algo que ya esta publicado. Sin esta rama caia en comandoCaptura y el
    // motor se ponia a buscar de que noticia era la foto, que es lo que hace
    // con las capturas de Instagram que manda la direccion.
    //
    // Se mira aqui y no dentro de comandoCaptura para que el reparto se lea de
    // un vistazo: foto + /post es un camino, foto a secas es otro.
    const pie = (msg.caption || "").trim();
    if (/^\/post(@\S+)?\b/i.test(pie)) {
      await comandoPost(env, msg.chat.id, pie,
                        msg.photo[msg.photo.length - 1].file_id);
      return;
    }
    await comandoCaptura(env, msg.chat.id, msg);
    return;
  }

  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await sendHtml(env, chatId, WELCOME);   // lleva <b> y <code>
    return;
  }
  if (text === "/id") {
    await sendMessage(env, chatId, "Tu chat ID es: " + chatId);
    return;
  }
  // Solo la lamina de una pieza YA PUBLICADA: "/post <enlace>".
  //
  // VA ANTES QUE /nota A PROPOSITO, aunque no se solapen: si algun dia el
  // patron de /nota se abre para entender pedidos escritos a mano, "hazme el
  // post de esta" tiene que seguir cayendo aqui y no disparar una redaccion.
  if (text.toLowerCase().split(" ")[0].split("@")[0] === "/post") {
    await comandoPost(env, chatId, text, "");
    return;
  }

  // Pedir que se redacte una noticia: "/nota https://medio.com/la-nota".
  if (text.toLowerCase().split(" ")[0].split("@")[0] === "/nota") {
    await comandoNota(env, chatId, text, msg.from);
    return;
  }
  // Newsletter semanal, por comando o pedido en lenguaje natural.
  if (esPedidoEntorno(text)) {
    await enviarEntorno(env, chatId, /\bforz|de nuevo|refresc|actualiz/i.test(text));
    return;
  }
  // "Redáctame una noticia de lo que dijo X hoy" es un encargo, no una
  // pregunta. Hasta el 03/09/2026 caia en el asistente de consultas, que
  // contestaba explicando la noticia en vez de escribirla, y desde fuera parecia
  // que el bot se negaba. Solo cuenta para la redaccion: a cualquier otro se le
  // responde como siempre.
  if (enLaRedaccion(env, chatId) && esPedidoNota(text)) {
    // El tipo primero, porque decide si un "de Fulano" es la firma o el tema.
    // Despues la firma, y el tema se calcula sobre lo que queda.
    const queTipo = tipoDelPedido(text);
    await comandoNota(env, chatId,
                      "/nota " + temaDelPedido(sinLaFirma(text, queTipo)),
                      msg.from, queTipo, autorDelPedido(text, queTipo));
    return;
  }
  // Actualizar el IPC del BCV a mano: "/ipc 13,8 129,8 junio 2026".
  if (text.toLowerCase().startsWith("/ipc")) {
    await comandoIpc(env, chatId, text);
    return;
  }

  try {
    const [history, gnews, web, stored] = await Promise.all([
      kvGet(env, "chat:" + chatId, []),
      fetchNews(searchQueryFor(text)),
      fetchWebNews(env, text),
      kvGet(env, "articles", []),
    ]);
    const live = mergeNews(gnews, web, 12);
    const relevant = getContext(stored, text, 12);
    const answer = await aiAnswer(env, text, live, relevant, history);
    await sendMessage(env, chatId, answer);
    history.push({ r: "user", c: text });
    history.push({ r: "assistant", c: answer });
    await kvPut(env, "chat:" + chatId, history.slice(-8), 60 * 60 * 24 * 7);
  } catch (e) {
    await sendMessage(
      env,
      chatId,
      "Disculpa, tuve un problema procesando tu mensaje. Intenta de nuevo en un momento."
    );
  }
}

// --- Cloudflare KV (memoria) ---
async function kvGet(env, key, dflt) {
  if (!env.KV) return dflt;
  const v = await env.KV.get(key);
  return v ? JSON.parse(v) : dflt;
}
async function kvPut(env, key, val, ttl) {
  if (!env.KV) return;
  const opts = ttl ? { expirationTtl: ttl } : {};
  await env.KV.put(key, JSON.stringify(val), opts);
}

// --- Ingesta de noticias al historial ("articles") ---
async function ingest(env) {
  const stored = await kvGet(env, "articles", []);
  const seen = new Set(stored.map((a) => a.l));
  let added = 0;
  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, { headers: UA });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const it of parseRss(xml, 12)) {
        if (!it.link || seen.has(it.link)) continue;
        seen.add(it.link);
        stored.unshift({
          t: it.title,
          l: it.link,
          d: it.date || "",
          a: it.author || "",
          c: f.cat,
          s: it.resumen || "",
        });
        added++;
      }
    } catch {}
  }
  await kvPut(env, "articles", stored.slice(0, 300));
  // De paso guardamos tasa BCV e IBC del día: así el newsletter puede calcular
  // la variación semanal con datos propios (ninguna fuente la publica).
  await registrarHistoricos(env);
  return added;
}

// Anota el valor de hoy en los históricos de KV (idempotente por fecha).
async function registrarHistoricos(env) {
  const hoy = hoyVET();
  try {
    const t = await fetchTasas();
    if (t.bcv) {
      const h = await kvGet(env, "hist:bcv", SEED_BCV);
      h[t.fechaBcv || hoy] = t.bcv;
      await kvPut(env, "hist:bcv", podarHist(h));
    }
    if (t.paralelo) {
      const h = await kvGet(env, "hist:par", {});
      h[t.fechaPar || hoy] = t.paralelo;
      await kvPut(env, "hist:par", podarHist(h));
    }
  } catch {}
  try {
    const ibc = await fetchIbc();
    if (ibc.valor) {
      const h = await kvGet(env, "hist:ibc", SEED_IBC);
      h[ibc.fecha || hoy] = ibc.valor;
      await kvPut(env, "hist:ibc", podarHist(h));
    }
  } catch {}
}

// Deja solo las últimas 120 fechas para que el valor de KV no crezca sin límite.
function podarHist(h) {
  const out = {};
  for (const k of Object.keys(h).sort().slice(-120)) out[k] = h[k];
  return out;
}

function parseRss(xml, limit) {
  const items = [];
  for (const p of xml.split("<item>").slice(1, limit + 1)) {
    const grab = (re) => {
      const m = p.match(re);
      return m ? decodeEntities(m[1]).trim() : "";
    };
    const title = grab(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const link = grab(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    const date = grab(/<pubDate>([\s\S]*?)<\/pubDate>/);
    let author = grab(/<dc:creator>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/);
    if (!author) author = grab(/<author>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/author>/);
    // El resumen del feed es la diferencia entre que la IA redacte con detalle o
    // que especule a partir de un titular suelto.
    const resumen = limpiarHtml(
      grab(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)
    ).slice(0, 320);
    if (title) items.push({ title, link, date, author, resumen });
  }
  return items;
}

// Los resúmenes de RSS vienen con HTML y "Leer más": se deja solo texto.
function limpiarHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

// Busca en el historial guardado por coincidencia de palabras con la pregunta.
function relevantStored(stored, question, n) {
  const words = question
    .toLowerCase()
    .split(/[^a-záéíóúñ0-9]+/)
    .filter((w) => w.length > 3);
  if (!words.length) return [];
  return stored
    .map((a) => {
      const t = (a.t || "").toLowerCase();
      let s = 0;
      for (const w of words) if (t.includes(w)) s++;
      return { a, s };
    })
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map((x) => x.a);
}

// Detecta el tema para usar una búsqueda curada (mejor cobertura que la frase literal).
function searchQueryFor(text) {
  const t = text.toLowerCase();
  if (/\bm&a\b|fusion|fusión|adquisic|merger|acquisit|\bopa\b/.test(t)) return MA_Q_ES;
  if (/suramérica|suramerica|sudamérica|sudamerica|latinoam|américa del sur/.test(t))
    return SURAMERICA_Q;
  return text;
}

function categoryFor(text) {
  const t = text.toLowerCase();
  if (/\bm&a\b|fusion|fusión|adquisic|merger|acquisit|\bopa\b/.test(t)) return "M&A";
  if (/venezuela|bol[ií]var|bcv|pdvsa|caracas/.test(t)) return "Venezuela";
  return null;
}

// Combina coincidencias por palabra + noticias recientes de la categoría detectada.
function getContext(stored, text, n) {
  const out = [];
  const seen = new Set();
  const push = (a) => {
    if (a && !seen.has(a.l)) {
      seen.add(a.l);
      out.push(a);
    }
  };
  for (const a of relevantStored(stored, text, n)) push(a);
  const cat = categoryFor(text);
  if (cat) for (const a of stored.filter((x) => x.c === cat).slice(0, n)) push(a);
  return out.slice(0, n);
}

// Búsqueda web (Tavily): rastrea todo internet, no solo Google News.
// Solo se usa si hay TAVILY_API_KEY configurada.
async function fetchWebNews(env, query, limit = 8) {
  if (!env.TAVILY_API_KEY) return [];
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: query,
        topic: "news",
        days: 30,
        max_results: limit,
        search_depth: "advanced",
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || []).map((x) => ({
      t: x.title,
      l: x.url,
      d: x.published_date || "",
      a: "",
      s: limpiarHtml(x.content || "").slice(0, 320),
    }));
  } catch {
    return [];
  }
}

// Une varias listas de noticias, quita duplicados y ordena por fecha (recientes primero).
function mergeNews(a, b, limit) {
  const seen = new Set();
  const out = [];
  for (const n of [...a, ...b]) {
    const k = n.l || n.t;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  out.sort((x, y) => (Date.parse(y.d) || 0) - (Date.parse(x.d) || 0));
  return out.slice(0, limit);
}

// Noticias en vivo, ordenadas de más reciente a más antigua.
async function fetchNews(query, limit = 8) {
  try {
    const res = await fetch(GN(query), { headers: UA });
    if (!res.ok) return [];
    const items = parseRss(await res.text(), 25);
    items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    return items.slice(0, limit).map((it) => ({
      t: it.title,
      l: it.link,
      a: it.author,
      d: it.date,
      s: it.resumen || "",
    }));
  } catch {
    return [];
  }
}

// --- IA (Gemini con fallback a Groq) ---
function buildPrompt(question, live, stored, history) {
  const hist = history.length
    ? "CONVERSACIÓN PREVIA (contexto):\n" +
      history.map((m) => (m.r === "user" ? "Usuario" : "Tú") + ": " + m.c).join("\n") +
      "\n\n"
    : "";
  // EL ENLACE VA DENTRO. Hasta el 03/09/2026 aqui solo entraban titular, autor
  // y fecha, y el enlace se quedaba fuera aunque los articulos lo traen (it.l).
  // Consecuencia: cuando alguien de la redaccion pedia "dame la fuente para
  // hacer el /nota", el modelo no podia darla porque nunca la habia visto, y o
  // se disculpaba o se la inventaba. No era pereza del modelo, era un dato que
  // no le llegaba.
  const liveBlock = live.length
    ? "NOTICIAS EN VIVO (el texto tras el último ' - ' suele ser la fuente):\n" +
      live
        .map(
          (n, i) =>
            `${i + 1}. ${n.t}${n.a ? ` [autor: ${n.a}]` : ""}${n.d ? ` (${n.d})` : ""}` +
            `${n.l ? `\n   enlace: ${n.l}` : ""}`
        )
        .join("\n") +
      "\n\n"
    : "";
  const storedBlock = stored.length
    ? "HISTORIAL GUARDADO (noticias anteriores relevantes):\n" +
      stored
        .map(
          (a, i) =>
            `${i + 1}. [${a.c}] ${a.t}${a.a ? ` [autor: ${a.a}]` : ""}${a.d ? ` (${a.d})` : ""}` +
            `${a.l ? `\n   enlace: ${a.l}` : ""}`
        )
        .join("\n") +
      "\n\n"
    : "";
  const hoy = new Date().toISOString().slice(0, 10);
  return (
    "Eres un asistente útil, claro y preciso, especializado en economía y " +
    "finanzas, con foco en Venezuela y Suramérica (pero respondes cualquier duda " +
    "económica).\n" +
    "HOY ES " + hoy + ". Las noticias de abajo YA fueron obtenidas de la web por " +
    "el sistema: ÚSALAS directamente. Nunca digas que no puedes acceder a internet " +
    "ni que no puedes 'copiar' de la web. Prioriza lo más reciente y CITA la fecha " +
    "de cada noticia. Reporta los hechos relevantes de los últimos días o semanas " +
    "con su fecha; NO digas 'no hay nada nuevo' si abajo hay noticias relacionadas. " +
    "Solo di que no encontraste si de verdad no hay ninguna relacionada.\n" +
    "REGLAS:\n" +
    "- Responde en el idioma del usuario (por defecto español), de forma natural, " +
    "directa y bien explicada. Habla normal, como un buen analista que ayuda; NO " +
    "uses un tono editorial ni 'nuestra lectura' ni primera persona plural.\n" +
    "- Sé objetivo y concreto. Si usas una noticia, cita la fuente (y el autor si " +
    "aparece). No inventes datos ni cifras.\n" +
    "- Si te piden el enlace o la fuente de algo, DALO: cada noticia de abajo " +
    "trae su 'enlace'. Cópialo tal cual, entero. Nunca escribas un enlace que no " +
    "esté abajo, ni lo acortes ni lo reconstruyas de memoria: si de una noticia " +
    "no hay enlace, dilo en vez de inventarlo.\n" +
    "- Si te piden redactar o escribir una noticia, tú no la redactas: la escribe " +
    "otro proceso, con su expediente de cifras y su auditor. Dale el enlace de la " +
    "fuente y dile que use /nota con ese enlace, o que mande /nota y el tema.\n" +
    "- Si piden 'solo verificadas', prioriza medios reconocidos y acláralo.\n" +
    "- Si no sabes algo o no está en la información disponible, dilo con " +
    "honestidad.\n" +
    "- Texto plano, sin markdown.\n\n" +
    hist +
    liveBlock +
    storedBlock +
    "PREGUNTA DEL USUARIO:\n" +
    question
  );
}

async function aiAnswer(env, question, live, stored, history) {
  const prompt = buildPrompt(question, live, stored, history);
  // El chat va con flash-lite primero (GEMINI_MODELS), como siempre: son muchas
  // preguntas al día y cortas. Lo nuevo es la segunda cuenta en cada escalón.
  const r = await embudoGemini(env, GEMINI_MODELS, prompt);
  if (r) return r.texto;
  if (env.GROQ_API_KEY) return await callGroq(env, prompt);
  throw new Error("no AI available");
}

// LAS CUENTAS DE GEMINI, EN ORDEN. La reserva es opcional: si el binding no
// existe, llega vacío y se descarta, y todo sigue con una sola.
function clavesGemini(env) {
  return [["principal", env.GEMINI_API_KEY], ["reserva", env.GEMINI_API_KEY_RESERVA],
          ["reserva-2", env.GEMINI_API_KEY_RESERVA_2]]
    .filter((c) => c[1] && String(c[1]).trim());
}

// EL EMBUDO: PRIMERO EL MODELO, LUEGO LA CUENTA. Con [flash, flash-lite] el
// orden es flash de la principal, flash de la reserva, flash-lite de la
// principal y flash-lite de la reserva. Es el mismo orden que motor/ia.py del
// medio, decisión del dueño el 25/09/2026: antes el Worker ni siquiera tenía la
// segunda cuenta, y cuando la principal agotaba flash el Entorno lo escribía
// flash-lite, que se saltaba los topes y repetía hechos entre noticias.
//
// esperaSaturado (segundos): SATURADO NO ES SIN CUOTA. Si un modelo falla por
// 5xx en todas las cuentas, Google está saturado y no agotado; se espera y se
// vuelve a probar ESE modelo antes de bajar al siguiente. Lo usa el Entorno:
// una llamada por semana y es lo que se publica. La primera prueba del embudo
// nuevo, el 25/09/2026, dio 503 en el flash de las dos cuentas y sin esto lo
// habría escrito flash-lite. El chat no lo usa: ahí la respuesta tiene que ser
// rápida y corre dentro de los ~30 s de waitUntil.
//
// Devuelve { texto, quien } o null si no respondió ninguna combinación.
async function embudoGemini(env, modelos, prompt, esperaSaturado) {
  const claves = clavesGemini(env);
  for (const model of modelos) {
    const vueltas = esperaSaturado ? 2 : 1;
    for (let vuelta = 0; vuelta < vueltas; vuelta++) {
      if (vuelta === 1) {
        console.log("[gemini] " + model + " saturado en todas las cuentas; espero " + esperaSaturado + " s");
        await new Promise((r) => setTimeout(r, esperaSaturado * 1000));
      }
      let saturado = false;
      for (const [nombre, clave] of claves) {
        try {
          const texto = await callGemini(env, model, prompt, clave);
          return { texto: texto, quien: model + (claves.length > 1 ? " (" + nombre + ")" : "") };
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (/ 5\d\d$/.test(msg)) saturado = true;
          console.log("[gemini] " + model + " (" + nombre + "): " + msg.slice(0, 80));
        }
      }
      if (!saturado) break;
    }
  }
  return null;
}

async function callGemini(env, model, prompt, clave) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    (clave || env.GEMINI_API_KEY);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) throw new Error("gemini " + model + " " + r.status);
  const data = await r.json();
  const txt =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts.map((p) => p.text).join("")) ||
    "";
  if (!txt) throw new Error("gemini empty");
  return txt;
}

async function callGroq(env, prompt) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GROQ_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    }),
  });
  if (!r.ok) throw new Error("groq " + r.status);
  const data = await r.json();
  return data.choices[0].message.content;
}

// ===========================================================================
// ENTORNO EN VIÑETAS
// ===========================================================================

// --- Utilidades de fecha y formato (es-VE) ---
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// Venezuela es UTC-4 fijo (no hay horario de verano).
function fechaVET(ms) {
  return new Date((ms === undefined ? Date.now() : ms) - 4 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}
const hoyVET = () => fechaVET();

function fechaCorta(iso) {
  if (!iso) return "";
  const p = iso.slice(0, 10).split("-");
  return String(Number(p[2])) + "-" + (MESES[Number(p[1]) - 1] || p[1]);
}

function fechaLarga(iso) {
  if (!iso) return "";
  const p = iso.slice(0, 10).split("-");
  return Number(p[2]) + " de " + (MESES_LARGOS[Number(p[1]) - 1] || p[1]) + " de " + p[0];
}

// LAS FECHAS DE UNA EDICIÓN, igual que en entorno/render.py (lunes_objetivo y
// semana_cubierta): sale el lunes y cubre la semana ANTERIOR, de lunes a
// domingo (guía maestra de octubre de 2026; decisión de Saúl el 08/10/2026).
// Los datos de mercado tienen UNA sola fecha de corte: el cierre del viernes
// anterior al envío. Un pedido a mitad de semana arma la edición del lunes que
// viene, con la semana en curso.
function sumarDias(iso, n) {
  return new Date(Date.parse(iso.slice(0, 10) + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function semanaEntorno(hoyIso) {
  const dia = new Date(hoyIso.slice(0, 10) + "T12:00:00Z").getUTCDay(); // 0 domingo
  const lunes = sumarDias(hoyIso, (8 - dia) % 7);
  return { lunes: lunes, desde: sumarDias(lunes, -7), hasta: sumarDias(lunes, -1), corte: sumarDias(lunes, -3) };
}
// «del 5 al 11 de octubre de 2026», sin guiones.
function rangoSemana(s) {
  const [a0, m0, d0] = s.desde.split("-").map(Number);
  const [a1, m1, d1] = s.hasta.split("-").map(Number);
  const M = (m) => MESES_LARGOS[m - 1];
  if (a0 !== a1) return "del " + d0 + " de " + M(m0) + " de " + a0 + " al " + d1 + " de " + M(m1) + " de " + a1;
  if (m0 !== m1) return "del " + d0 + " de " + M(m0) + " al " + d1 + " de " + M(m1) + " de " + a1;
  return "del " + d0 + " al " + d1 + " de " + M(m1) + " de " + a1;
}

// SIN GUIONES (guía maestra, regla 1): ni guion, ni raya, ni flechas. Lo que se
// puede arreglar sin cambiar el sentido se arregla aquí: el inciso entre rayas
// pasa a comas y «La Guaira–Caracas» a «La Guaira y Caracas». Lo que no (un
// nombre como «T-MEC», un rango de cifras) lo señala el chequeo de render.py
// antes de enviar, para que lo corrija una persona.
function sinGuiones(s) {
  return String(s || "")
    .replace(/[ \t]*[→←↔⟶][ \t]*/g, " ")
    .replace(/[ \t]+[-–—][ \t]+/g, ", ")
    .replace(/([A-Za-zÁÉÍÓÚáéíóúÑñ])[–—]([A-Za-zÁÉÍÓÚáéíóúÑñ])/g, "$1 y $2")
    .replace(/,\s*,/g, ",")
    .replace(/\bpdvsa\b/gi, "PDVSA")  // norma de la casa (Saúl, 09/10/2026)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function num(n, dec = 2) {
  if (n === null || n === undefined || !isFinite(n)) return "s/d";
  const s = Math.abs(n).toFixed(dec).split(".");
  const ent = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (n < 0 ? "-" : "") + ent + (s[1] ? "," + s[1] : "");
}

function pct(p, dec = 1) {
  if (p === null || p === undefined || !isFinite(p)) return "s/d";
  return (p >= 0 ? "+" : "") + num(p, dec) + "%";
}

function aNumero(txt) {
  // "742,22920000" / "1.234,56" -> 742.2292 / 1234.56
  const n = parseFloat(String(txt).replace(/\./g, "").replace(",", "."));
  return isFinite(n) ? n : null;
}

// --- Fuentes duras ---

// Tasas: ve.dolarapi.com da oficial y paralelo en un solo JSON; si falla, se
// raspa bcv.org.ve (solo trae la oficial).
async function fetchTasas() {
  const out = { bcv: null, paralelo: null, fechaBcv: "", fechaPar: "", fuentePar: "promedio de mercado" };
  try {
    const r = await fetch("https://ve.dolarapi.com/v1/dolares", { headers: UA });
    if (r.ok) {
      for (const x of await r.json()) {
        const v = x.promedio || x.venta || x.compra;
        if (!v) continue;
        if (x.fuente === "oficial") {
          out.bcv = v;
          out.fechaBcv = (x.fechaActualizacion || "").slice(0, 10);
        } else if (x.fuente === "paralelo") {
          out.paralelo = v;
          out.fechaPar = (x.fechaActualizacion || "").slice(0, 10);
        }
      }
    }
  } catch {}
  if (!out.bcv) {
    try {
      const r = await fetch("https://www.bcv.org.ve/", { headers: UA });
      if (r.ok) {
        const html = await r.text();
        const m = html.match(/id="dolar"[\s\S]*?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/);
        if (m) out.bcv = aNumero(m[1]);
        const f = html.match(/Fecha\s*Valor[\s\S]*?content="(\d{4}-\d{2}-\d{2})/);
        if (f) out.fechaBcv = f[1];
      }
    } catch {}
  }
  if (!out.fechaBcv) out.fechaBcv = hoyVET();
  return out;
}

// IBC: la Bolsa de Caracas publica cada cierre como noticia con slug
// "indice-bursatil-caracas-cerro-en-5-17361-puntos-23jul".
async function fetchIbc() {
  const out = { valor: null, fecha: "", previo: null, previoFecha: "" };
  try {
    const r = await fetch("https://www.bolsadecaracas.com/", { headers: UA });
    if (!r.ok) return out;
    const html = await r.text();
    const re = /cerro-en-([0-9-]+)-puntos-(\d{1,2})([a-z]{3})/g;
    const vistos = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const valor = Number(m[1].replace(/-/g, "")) / 100;
      const mes = MESES.indexOf(m[3]);
      if (!valor || mes < 0) continue;
      const anio = Number(hoyVET().slice(0, 4));
      let iso =
        anio + "-" + String(mes + 1).padStart(2, "0") + "-" + String(Number(m[2])).padStart(2, "0");
      // Si la fecha cae en el futuro, el cierre es del año pasado (borde de enero).
      if (iso > hoyVET()) iso = anio - 1 + iso.slice(4);
      if (!vistos.some((v) => v.fecha === iso)) vistos.push({ fecha: iso, valor: valor });
      if (vistos.length >= 6) break;
    }
    vistos.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
    if (vistos[0]) {
      out.valor = vistos[0].valor;
      out.fecha = vistos[0].fecha;
    }
    if (vistos[1]) {
      out.previo = vistos[1].valor;
      out.previoFecha = vistos[1].fecha;
    }
  } catch {}
  return out;
}

// Serie diaria de 1 año (Yahoo Finance). query2 es el respaldo de query1.
async function yahooSerie(ticker) {
  const path =
    "/v8/finance/chart/" + encodeURIComponent(ticker) + "?interval=1d&range=1y";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const r = await fetch("https://" + host + path, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.timestamp) continue;
      const cierres = ((res.indicators.quote || [{}])[0] || {}).close || [];
      const serie = [];
      for (let i = 0; i < res.timestamp.length; i++) {
        const c = cierres[i];
        if (c === null || c === undefined) continue;
        serie.push({ d: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), c: c });
      }
      if (serie.length) return serie;
    } catch {}
  }
  return [];
}

// Último cierre + variación semanal + variación en el año. Con 'corte', el
// último cierre es el de esa fecha o antes (guía maestra: una sola fecha de
// corte por edición, el cierre del viernes; variación viernes contra viernes).
function resumenSerie(serie, corte) {
  if (corte && serie) serie = serie.filter((p) => p.d <= corte);
  if (!serie || !serie.length) return null;
  const ult = serie[serie.length - 1];
  const limite = new Date(Date.parse(ult.d) - 7 * 86400000).toISOString().slice(0, 10);
  let prev = null;
  for (const p of serie) if (p.d <= limite) prev = p;
  const base = serie.find((p) => p.d >= ult.d.slice(0, 4) + "-01-01");
  return {
    fecha: ult.d,
    valor: ult.c,
    sem: prev ? (ult.c / prev.c - 1) * 100 : null,
    semFecha: prev ? prev.d : "",
    ytd: base ? (ult.c / base.c - 1) * 100 : null,
  };
}

// Variación contra el histórico propio de KV (para tasa BCV e IBC).
function varDesdeHist(hist, valor, fecha, dias) {
  const vacio = { pct: null, ref: null, refFecha: "" };
  if (!valor || !hist) return vacio;
  const limite = new Date(Date.parse(fecha) - dias * 86400000).toISOString().slice(0, 10);
  const fechas = Object.keys(hist).sort();
  let ref = "";
  for (const k of fechas) if (k <= limite) ref = k;
  if (!ref) {
    // Todavía no hay un dato tan viejo: se usa el más antiguo que exista.
    const antiguas = fechas.filter((k) => k < fecha);
    if (!antiguas.length) return vacio;
    ref = antiguas[0];
  }
  return { pct: (valor / hist[ref] - 1) * 100, ref: hist[ref], refFecha: ref };
}

// --- Recolección completa de cifras ---
async function gatherEntornoData(env, corte) {
  const tareas = [
    fetchTasas(),
    fetchIbc(),
    kvGet(env, "ipc", IPC_DEFAULT),
    kvGet(env, "entorno:bases", BASES),
    kvGet(env, "hist:bcv", SEED_BCV),
    kvGet(env, "hist:par", {}),
    kvGet(env, "hist:ibc", SEED_IBC),
  ];
  const res = await Promise.all(tareas.concat(YF_TICKERS.map((x) => yahooSerie(x.t))));
  const [tasas, ibc, ipc, bases, histBcv, histPar, histIbc] = res;
  const series = res.slice(tareas.length);

  const mercados = {};
  YF_TICKERS.forEach((x, i) => {
    const r = resumenSerie(series[i], corte);
    if (r) mercados[x.k] = Object.assign({ nombre: x.n, dec: x.dec }, r);
  });
  // Si Yahoo no respondió (pasa si bloquea la IP del Worker), usamos el último
  // snapshot bueno y lo decimos en el texto.
  let mercadosViejos = false;
  if (!Object.keys(mercados).length) {
    const snap = await kvGet(env, "mkt:last", null);
    if (snap && snap.mercados) {
      Object.assign(mercados, snap.mercados);
      mercadosViejos = true;
    }
  } else {
    await kvPut(env, "mkt:last", { ts: Date.now(), mercados: mercados });
  }

  // TASAS E IBC AL CORTE: el valor del histórico propio con fecha igual o
  // anterior al viernes de corte. Sin corte (el comando de cifras sueltas), o
  // si el histórico no llega tan atrás, el último que haya.
  const alCorte = (hist, actual, fechaAct) => {
    if (!corte) return { v: actual, d: fechaAct };
    let ref = "";
    for (const k of Object.keys(hist || {}).sort()) if (k <= corte) ref = k;
    return ref ? { v: hist[ref], d: ref } : { v: actual, d: fechaAct };
  };
  const bcvC = alCorte(histBcv, tasas.bcv, tasas.fechaBcv);
  const parC = alCorte(histPar, tasas.paralelo, tasas.fechaPar || hoyVET());
  tasas.bcv = bcvC.v; tasas.fechaBcv = bcvC.d;
  tasas.paralelo = parC.v; tasas.fechaPar = parC.d;
  if (corte && ibc.valor) {
    const ibcC = alCorte(histIbc, ibc.valor, ibc.fecha || hoyVET());
    ibc.valor = ibcC.v; ibc.fecha = ibcC.d;
  }
  const bcvSem = varDesdeHist(histBcv, tasas.bcv, tasas.fechaBcv, 6);
  const parSem = varDesdeHist(histPar, tasas.paralelo, tasas.fechaPar || hoyVET(), 6);
  const brecha =
    tasas.bcv && tasas.paralelo ? (tasas.paralelo / tasas.bcv - 1) * 100 : null;
  // Brecha de la semana pasada: solo si tenemos ambas puntas del histórico.
  let brechaPrev = null;
  if (bcvSem.ref && parSem.ref) brechaPrev = (parSem.ref / bcvSem.ref - 1) * 100;

  const ibcSem = ibc.valor
    ? varDesdeHist(histIbc, ibc.valor, ibc.fecha || hoyVET(), 6)
    : { pct: null, ref: null, refFecha: "" };

  return {
    generado: new Date().toISOString(),
    hoy: hoyVET(),
    corte: corte || "",
    // La línea de fuentes de Economía en cifras (guía: todas las fuentes de la
    // página y la fecha de corte).
    fuentes_cifras: "BCV, ve.dolarapi.com (paralelo), Yahoo Finance (índices, commodities y criptoactivos), Bolsa de Valores de Caracas",
    cambiario: {
      bcv: tasas.bcv,
      fechaBcv: tasas.fechaBcv,
      bcvSem: bcvSem.pct,
      bcvSemFecha: bcvSem.refFecha,
      paralelo: tasas.paralelo,
      fechaPar: tasas.fechaPar,
      brecha: brecha,
      brechaPrev: brechaPrev,
      brechaDelta: brecha !== null && brechaPrev !== null ? brecha - brechaPrev : null,
      devalYTD: tasas.bcv ? (tasas.bcv / bases.bcv - 1) * 100 : null,
      baseAnual: bases.bcv,
    },
    inflacion: ipc,
    mercados: mercados,
    mercadosViejos: mercadosViejos,
    ibc: {
      valor: ibc.valor,
      fecha: ibc.fecha,
      sem: ibcSem.pct,
      semFecha: ibcSem.refFecha,
      ytd: ibc.valor ? (ibc.valor / bases.ibc - 1) * 100 : null,
      baseAnual: bases.ibc,
    },
  };
}

// --- Bloque "Economía en cifras" (HTML, armado por código) ---
function bloqueCifras(d) {
  const c = d.cambiario;
  const m = d.mercados;
  const L = [];
  const linea = (nombre, k, unidad, sufijo) => {
    const x = m[k];
    if (!x) return "• " + nombre + ": s/d";
    return (
      "• " + nombre + ": " + (unidad || "") + num(x.valor, x.dec === 0 ? 0 : 2) +
      (sufijo || "") + "  (" + pct(x.sem) + " sem. | " + pct(x.ytd) + " año)"
    );
  };

  L.push("<b>📊 ECONOMÍA EN CIFRAS</b>");
  L.push("");
  L.push("<b>Mercado cambiario</b>");
  L.push(
    "• Tasa BCV: Bs. " + num(c.bcv, 2) + "/US$" +
      (c.fechaBcv ? " (" + fechaCorta(c.fechaBcv) + ")" : "") +
      (c.bcvSem !== null ? "  " + pct(c.bcvSem, 2) + " sem." : "")
  );
  L.push(
    "• Tasa paralelo: Bs. " + num(c.paralelo, 2) + "/US$" +
      (c.fechaPar ? " (" + fechaCorta(c.fechaPar) + ")" : "")
  );
  L.push(
    "• Brecha: " + (c.brecha === null ? "s/d" : num(c.brecha, 1) + "%") +
      (c.brechaDelta !== null
        ? "  (" + pct(c.brechaDelta, 1) + " pp vs. semana previa)"
        : "")
  );
  L.push(
    "• Devaluación acumulada del año: " + pct(c.devalYTD, 1) +
      " (desde Bs. " + num(c.baseAnual, 2) + " el 1-ene)"
  );
  L.push("");
  L.push("<b>Inflación y precios</b>");
  L.push("• Inflación acumulada del año: " + num(d.inflacion.acumulada, 1) + "%");
  L.push(
    "• IPC mensual (" + escapeHtml(d.inflacion.mes) + "): " +
      pct(d.inflacion.mensual, 1)
  );
  L.push("");
  L.push("<b>Commodities</b>");
  L.push(linea("Petróleo Brent", "brent", "US$ ", "/barril"));
  L.push(linea("Oro", "oro", "US$ ", "/onza"));
  L.push("");
  L.push("<b>Criptoactivos</b>");
  L.push(linea("Bitcoin (BTC/USD)", "btc", "US$ "));
  L.push(linea("Ethereum (ETH/USD)", "eth", "US$ "));
  L.push("");
  L.push("<b>Mercado bursátil</b>");
  L.push(linea("Dow Jones", "dow"));
  L.push(linea("S&amp;P 500", "sp500"));
  L.push(linea("Nasdaq", "nasdaq"));
  L.push(
    "• Bolsa de Valores de Caracas (IBC): " + num(d.ibc.valor, 2) +
      (d.ibc.fecha ? " (" + fechaCorta(d.ibc.fecha) + ")" : "") +
      "  (" + pct(d.ibc.sem) + " sem. | " + pct(d.ibc.ytd) + " año)"
  );
  const fechasMkt = Object.keys(m)
    .map((k) => m[k].fecha)
    .filter(Boolean)
    .sort();
  if (fechasMkt.length) {
    L.push("");
    L.push(
      "<i>Último cierre disponible: " + fechaCorta(fechasMkt[fechasMkt.length - 1]) +
        (d.mercadosViejos ? " (snapshot guardado; Yahoo no respondió)" : "") + ".</i>"
    );
  }
  return L.join("\n");
}

// --- Prompt: la IA solo redacta; las cifras ya están calculadas ---
function resumenDatosParaIA(d) {
  const c = d.cambiario;
  const m = d.mercados;
  const l = [];
  l.push("Tasa BCV: Bs. " + num(c.bcv, 2) + " por US$ (" + c.fechaBcv + "), " + pct(c.bcvSem, 2) + " en la semana.");
  l.push("Paralelo: Bs. " + num(c.paralelo, 2) + ". Brecha: " + num(c.brecha, 1) + "%" +
    (c.brechaDelta !== null ? " (" + pct(c.brechaDelta, 1) + " pp vs. semana previa)" : "") + ".");
  l.push("Devaluación acumulada 2026: " + pct(c.devalYTD, 1) + " (base Bs. " + num(c.baseAnual, 2) + ").");
  l.push("IPC " + d.inflacion.mes + ": " + pct(d.inflacion.mensual, 1) + " mensual; acumulada del año " + num(d.inflacion.acumulada, 1) + "%.");
  for (const k of Object.keys(m)) {
    const x = m[k];
    l.push(x.nombre + ": " + num(x.valor, x.dec === 0 ? 0 : 2) + " (" + x.fecha + "), " +
      pct(x.sem) + " semanal, " + pct(x.ytd) + " en el año.");
  }
  l.push("IBC Caracas: " + num(d.ibc.valor, 2) + " (" + d.ibc.fecha + "), " + pct(d.ibc.sem) +
    " semanal, " + pct(d.ibc.ytd) + " en el año.");
  return l.join("\n");
}

// Google News pega " - Medio" al final del título. Hay que separarlo: si se
// evalúa el título completo, un medio como "Financial Times" cuela cualquier
// titular por la palabra "Financia".
function sinMedio(t) {
  return String(t || "").replace(/\s-\s[^-]{2,40}$/, "");
}
function medioDe(t) {
  const m = String(t || "").match(/\s-\s([^-]{2,40})$/);
  return m ? m[1].trim() : "";
}

// Descarta clickbait y, en los feeds generalistas, exige señal económica.
// Además saca lo que tenga más de 12 días: esto es un semanal, no un archivo.
function filtrarNoticias(lista, exigirEcon) {
  const corte = Date.now() - 12 * 86400000;
  return lista.filter((n) => {
    const t = n.t || "";
    if (!t) return false;
    if (JUNK_RE.test(t)) return false;
    const titular = sinMedio(t);
    if (CLICKBAIT_RE.test(titular)) return false;
    if (exigirEcon && !ECON_RE.test(titular)) return false;
    const ts = Date.parse(n.d || "");
    if (ts && ts < corte) return false;
    return true;
  });
}

// Puntaje de relevancia: en vez de pasa/no pasa, ordena por señal. Premia hecho
// macro duro, cifras, medio reconocido, resumen disponible y frescura.
function puntuar(n) {
  const titular = sinMedio(n.t || "");
  let p = 0;
  if (MEDIOS_OK_RE.test(n.t + " " + (n.l || ""))) p += 3;
  if (MACRO_FUERTE_RE.test(titular)) p += 3;
  if (ECON_RE.test(titular)) p += 1;
  if (/\d/.test(titular)) p += 1;
  if (/(\d+[.,]?\d*\s?%|US\$|\$\s?\d|millones|billones|mil millones)/i.test(titular)) p += 2;
  if (resumenUtil(n)) p += 1;
  const dias = n.d ? (Date.now() - Date.parse(n.d)) / 86400000 : NaN;
  if (isNaN(dias)) p += 0;
  else if (dias <= 2) p += 3;
  else if (dias <= 5) p += 2;
  else if (dias <= 8) p += 1;
  else p -= 1;
  return p;
}

// Google News repite el titular dentro de <description>: eso no aporta nada.
// Solo cuenta como resumen si añade texto propio.
function resumenUtil(n) {
  const s = (n.s || "").trim();
  if (s.length < 60) return "";
  const t = sinMedio(n.t || "").toLowerCase();
  if (t.includes(s.toLowerCase().slice(0, 40))) return "";
  return s;
}

function paisDe(n) {
  const t = (n.t || "") + " " + (n.s || "");
  for (const par of PAISES) if (par[1].test(t)) return par[0];
  return "";
}

// Quita la misma noticia contada por varios medios (compara palabras del
// titular, no la URL: el link siempre es distinto).
// Las palabras con peso de un titular: sin el sufijo del medio, sin tildes y
// sin las cortas. La usan dedupTitulos() y enlaceDirecto(), que se hacen la
// misma pregunta -\u00bfestos dos titulares cuentan lo mismo?- y tienen que medirla
// igual.
function palabrasTitular(t) {
  return new Set(
    sinMedio(t || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((x) => x.length > 3)
  );
}

// Jaccard entre dos bolsas: palabras compartidas sobre palabras totales.
function parecidoTitular(w, w2) {
  let inter = 0;
  for (const x of w) if (w2.has(x)) inter++;
  const union = w.size + w2.size - inter;
  return { indice: union ? inter / union : 0, comunes: inter };
}

function dedupTitulos(lista) {
  const out = [];
  const bolsas = [];
  for (const n of lista) {
    const w = palabrasTitular(n.t);
    let dup = false;
    for (const w2 of bolsas) {
      if (parecidoTitular(w, w2).indice > 0.5) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      bolsas.push(w);
      out.push(n);
    }
  }
  return out;
}

// Arma la lista final con cupos: Venezuela para la nota principal, Latam con
// máximo 2 por país (si no, una semana argentina se come la sección) y algo de
// contexto global.
function seleccionarNoticias(cands) {
  const porPuntaje = (a, b) => b._p - a._p;
  for (const n of cands) n._p = puntuar(n);
  const vz = cands.filter((n) => n.g === "VZ").sort(porPuntaje).slice(0, 10);
  const glob = cands.filter((n) => n.g === "GLOBAL").sort(porPuntaje).slice(0, 5);
  const cuenta = {};
  const latam = [];
  for (const n of cands.filter((n) => n.g === "LATAM").sort(porPuntaje)) {
    const p = paisDe(n) || "región";
    cuenta[p] = (cuenta[p] || 0) + 1;
    if (cuenta[p] <= 2) latam.push(Object.assign({}, n, { p: p }));
    if (latam.length >= 14) break;
  }
  return dedupTitulos([].concat(vz, latam, glob));
}

// EL ENLACE DE GOOGLE NEWS NO SIRVE PARA SACAR LA FOTO. Es un redirector
// cifrado que solo salta al artículo con JavaScript: pedirlo devuelve una
// página de Google sin og:image. Probado el 24/09/2026 armando una edición
// entera solo con feeds de Google: cero fotos de cinco.
//
// Pero la misma noticia suele estar también en el historial del KV, que se
// ingiere de los feeds de los propios medios y trae el enlace directo. Así que
// si la fuente es de Google, se busca ahí el titular que cuente lo mismo y se
// usa ese enlace, para la foto y para el «Fuente:» del texto.
//
// Se exige parecido de verdad (0,4 y tres palabras en común) porque un
// emparejamiento flojo no deja la página sin foto: le pone la de OTRA noticia,
// que es peor. Sin pareja, la página va sin foto y render.py lo resuelve.
function enlaceDirecto(n, todas) {
  if (!n || !n.l || !/news\.google\./i.test(n.l)) return n;
  const w = palabrasTitular(n.t);
  let mejor = null;
  let pm = { indice: 0, comunes: 0 };
  for (const c of todas) {
    if (!c.l || /news\.google\./i.test(c.l)) continue;
    const p = parecidoTitular(w, palabrasTitular(c.t));
    if (p.indice > pm.indice) {
      pm = p;
      mejor = c;
    }
  }
  if (mejor && pm.indice >= 0.4 && pm.comunes >= 3) {
    return Object.assign({}, n, { l: mejor.l, t: mejor.t });
  }
  console.log("[entorno] sin enlace directo para «" + sinMedio(n.t).slice(0, 60) + "»" +
    (mejor ? " (lo más parecido, " + pm.indice.toFixed(2) + ": «" + sinMedio(mejor.t).slice(0, 60) + "»)" : ""));
  return n;
}

// Marca de dónde viene cada titular: le dice al modelo qué usar para la noticia
// principal (VZ) y qué para Latam enlatada (LATAM).
function etiquetar(lista, g) {
  return lista.map((n) => Object.assign({}, n, { g: g }));
}


// --- «¿Qué estamos esperando?»: la agenda de la semana que empieza ---
//
// LAS FECHAS NO LAS PONE EL MODELO. La guía maestra pide 3 eventos «siempre con
// fecha confirmada», y Saúl decidió el 08/10/2026 que el bot los busque en la
// web y en la lista blanca en vez de mantener una lista a mano. Así que hay dos
// orígenes, y los dos dejan la fecha comprobable:
//   1. la Reserva Federal publica su calendario de reuniones con un año de
//      antelación: se lee de su web (agendaFed) y la fecha es la del calendario;
//   2. eventos anunciados en la prensa («el BCV publicará…», «vence la licencia…»):
//      el modelo propone, y verificarEvento() exige que el titular o su resumen
//      digan esa fecha (el día y el mes, o el día de la semana). Si no, se cae.
const ENTORNO_Q_AGENDA =
  "(Venezuela OR BCV OR Pdvsa OR OPEP OR OFAC OR \"Reserva Federal\" OR Fed) " +
  "(publicará OR \"se reunirá\" OR reunión OR vence OR vencimiento OR \"próxima semana\" OR " +
  "subasta OR elecciones OR anunciará OR licencia)";
// MÁS VENEZUELA. El 09/10/2026 la primera edición con la guía nueva le llegó al
// modelo con UN solo titular de Venezuela (Tavily sin crédito y una sola
// consulta a Google News), y rellenó tres viñetas con la tabla de cifras. Tres
// consultas más, una por frente, y todas acotadas a la semana (when:9d).
const ENTORNO_Q_VZ_EXTRA = [
  "Venezuela (Pdvsa OR petróleo OR crudo OR Chevron OR licencia OR OFAC OR refinería) when:9d",
  "(BCV OR \"Banco Central de Venezuela\" OR bolívar OR inflación OR Sudeban) Venezuela when:9d",
  "Venezuela (empresas OR inversión OR deuda OR bonos OR FMI OR \"Banco Mundial\" OR reestructuración OR Fedecámaras) when:9d",
];
const MESES_EN = ["january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december"];
const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// LA AGENDA SALE TODAS LAS SEMANAS. Lo pidió Saúl el 09/10/2026, después de una
// edición con la sección vacía: no había reunión de la Fed ni dato de la BEA esa
// semana y ningún titular traía fecha comprobable. Ahora hay cuatro calendarios
// oficiales leídos por código (Fed, EIA, Oficina del Censo y BEA), y la EIA
// publica su informe semanal de inventarios TODAS las semanas, así que al
// menos un evento hay siempre. Cada candidato oficial trae una prioridad (cuánto
// puede mover la economía venezolana) y un texto propio: si el modelo no elige
// tres que pasen la verificación, el código completa con los de mayor
// prioridad. Las fechas nunca las pone el modelo.
const DIAS_TXT = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
function fechaEvento(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return DIAS_TXT[new Date(iso + "T12:00:00Z").getUTCDay()] + " " + d + " de " + MESES_LARGOS[m - 1];
}
function oficial(origen, fecha, prioridad, fuente, url, texto, nombre, porque) {
  return { origen: origen, fecha: fecha, prioridad: prioridad, fuente: fuente, url: url, texto: texto,
           nombre: nombre, descripcion: fechaEvento(fecha) + ". " + porque };
}

// El calendario completo de la Reserva Federal, el que pinta su página de
// eventos (www.federalreserve.gov/json/calendar.json). De todo lo que trae se
// queda con lo que mueve mercados: reunión y actas del FOMC, Libro Beige,
// comparecencias y discursos del presidente, y la producción industrial.
async function agendaFed(sem) {
  const fin = sumarDias(sem.lunes, 6);
  const URLF = "https://www.federalreserve.gov/newsevents/calendar.htm";
  try {
    const r = await fetch("https://www.federalreserve.gov/json/calendar.json", { headers: UA });
    if (!r.ok) return [];
    const j = JSON.parse((await r.text()).replace(/^﻿/, ""));
    const out = [];
    for (const e of j.events || []) {
      for (const d of String(e.days || "").split(",").map((x) => parseInt(x, 10)).filter(Boolean)) {
        const fecha = String(e.month || "") + "-" + String(d).padStart(2, "0");
        if (fecha < sem.lunes || fecha > fin) continue;
        const t = String(e.title || "");
        const presidente = /^(Speech|Discussion|Testimony)\s+-\s+Chair(man)?\s/i.test(t);
        if (e.type === "FOMC" && /FOMC Meeting/i.test(t)) {
          out.push(oficial("FED", fecha, 100, "Reserva Federal", URLF, t, "Reserva Federal decide tasas",
            "La decisión sobre las tasas de interés de Estados Unidos mueve el dólar, el petróleo y el costo del financiamiento externo."));
        } else if (e.type === "FOMC" && /Minutes/i.test(t)) {
          out.push(oficial("FED", fecha, 70, "Reserva Federal", URLF, t, "Actas de la Reserva Federal",
            "Las minutas de su última reunión darán pistas sobre el rumbo de las tasas de interés en Estados Unidos."));
        } else if (e.type === "Beige") {
          out.push(oficial("FED", fecha, 55, "Reserva Federal", URLF, t, "Libro Beige de la Reserva Federal",
            "El informe regional muestra cómo va la actividad económica en Estados Unidos y anticipa el rumbo de las tasas."));
        } else if (presidente && /Testimony/i.test(t)) {
          out.push(oficial("FED", fecha, 75, "Reserva Federal", URLF, t, "Presidente de la Fed ante el Congreso",
            "Su comparecencia puede adelantar decisiones sobre tasas que mueven el dólar y el petróleo."));
        } else if (presidente) {
          out.push(oficial("FED", fecha, 60, "Reserva Federal", URLF, t, "Habla el presidente de la Fed",
            "Cualquier señal sobre las tasas de interés de Estados Unidos mueve el dólar y el precio del petróleo."));
        } else if (/^G\.17/.test(t)) {
          const g17 = oficial("FED", fecha, 40, "Reserva Federal", URLF, t, "Producción industrial de EE. UU.",
            "El dato de la Reserva Federal mide la actividad de la industria estadounidense y su demanda de energía.");
          g17.familia = "DATOS_EEUU";
          out.push(g17);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// El informe semanal de inventarios de petróleo de la EIA. La propia página lo
// dice: sale los miércoles a las 10:30, salvo las excepciones por feriado de su
// tabla («datos de la semana que termina el…» → «fecha alternativa»). El de la
// semana del lunes L es el de los datos que terminan el viernes L-3.
async function agendaEia(sem) {
  const URLE = "https://www.eia.gov/petroleum/supply/weekly/schedule.php";
  let fecha = sumarDias(sem.lunes, 2);
  try {
    const r = await fetch(URLE, { headers: UA });
    if (r.ok) {
      const t = (await r.text()).replace(/<[^>]+>/g, " | ").replace(/\s+/g, " ");
      if (!/standard release time and day of the week will be at 10:30 a\.m\. eastern time on Wednesday/i.test(t)) return [];
      const viernes = sumarDias(sem.lunes, -3);
      const re = /([A-Z][a-z]+) (\d{1,2}), (\d{4}) \| \| ([A-Z][a-z]+) (\d{1,2}), (\d{4})/g;
      let m;
      const iso = (mes, d, a) => a + "-" + String(MESES_EN.indexOf(mes.toLowerCase()) + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      while ((m = re.exec(t)) !== null) {
        if (iso(m[1], m[2], m[3]) === viernes) fecha = iso(m[4], m[5], m[6]);
      }
    } else return [];
  } catch {
    return [];
  }
  // Prioridad baja A PROPOSITO: sale todas las semanas, y la agenda no puede
  // ser siempre la misma. Entra solo si no hay nada mejor.
  const out = [oficial("EIA", fecha, 30, "Administración de Información Energética de EE. UU. (EIA)", URLE,
    "Weekly Petroleum Status Report", "Inventarios de crudo de EE. UU.",
    "El informe semanal de la EIA mueve el precio del petróleo, del que dependen los ingresos de Venezuela.")];
  // Y el informe mensual de perspectivas (STEO), con la proyección del precio
  // del petróleo. Su página dice en texto la próxima fecha de publicación.
  try {
    const URLS = "https://www.eia.gov/outlooks/steo/release_schedule.php";
    const r = await fetch(URLS, { headers: UA });
    if (r.ok) {
      const t = (await r.text()).replace(/<[^>]+>/g, " | ").replace(/\s+/g, " ");
      const m = t.match(/Next Release Date:\s*\|[\s|]*([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
      if (m) {
        const f = m[3] + "-" + String(MESES_EN.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0") + "-" + String(m[2]).padStart(2, "0");
        if (f >= sem.lunes && f <= sumarDias(sem.lunes, 6)) {
          out.push(oficial("EIA", f, 52, "Administración de Información Energética de EE. UU. (EIA)", URLS,
            "Short-Term Energy Outlook", "Perspectivas de energía de la EIA",
            "El informe mensual actualiza la proyección del precio del petróleo, clave para los ingresos venezolanos."));
        }
      }
    }
  } catch {}
  return out;
}

// El informe semanal de inventarios de gas natural de la EIA: los jueves a las
// 10:30, salvo las fechas alternativas de su tabla de feriados (lo dice la
// propia página). Segundo informe que sale TODAS las semanas.
async function agendaGas(sem) {
  const URLG = "https://ir.eia.gov/ngs/schedule.html";
  const fin = sumarDias(sem.lunes, 6);
  let fecha = sumarDias(sem.lunes, 3);
  try {
    const r = await fetch(URLG, { headers: UA });
    if (!r.ok) return [];
    const t = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!/standard release time and day of the week will be at 10:30 a\.m\. eastern time on Thursdays/i.test(t)) return [];
    const re = /([A-Z][a-z]+) (\d{1,2}), (\d{4})[^A-Za-z]{0,30}(?:\(Updated\))?\s*(Monday|Tuesday|Wednesday|Thursday|Friday)/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const f = m[3] + "-" + String(MESES_EN.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0") + "-" + String(m[2]).padStart(2, "0");
      if (f >= sem.lunes && f <= fin) fecha = f;
    }
  } catch {
    return [];
  }
  return [oficial("EIA", fecha, 20, "Administración de Información Energética de EE. UU. (EIA)", URLG,
    "Weekly Natural Gas Storage Report", "Inventarios de gas natural de EE. UU.",
    "El informe semanal de la EIA mueve el precio del gas, otro de los mercados energéticos que sigue Venezuela.")];
}

// Las subastas de notas y bonos del Tesoro de EE. UU. de las próximas semanas
// (TreasuryDirect publica las que vienen en JSON). Las letras de corto plazo no
// entran: se subastan a diario y no mueven nada.
async function agendaTesoro(sem) {
  const fin = sumarDias(sem.lunes, 6);
  const URLT = "https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json";
  try {
    const r = await fetch(URLT, { headers: UA });
    if (!r.ok) return [];
    const lista = (await r.json()) || [];
    const out = [];
    for (const x of lista) {
      const fecha = String(x.auctionDate || "").slice(0, 10);
      if (!/^(Note|Bond)$/.test(x.securityType || "") || fecha < sem.lunes || fecha > fin) continue;
      const anios = Math.round(parseInt(String(x.securityTerm || "").match(/\d+/) || [0], 10) + (/Month/.test(x.securityTerm || "") ? 1 : 0));
      if (!anios || out.some((e) => e.fecha === fecha)) continue;
      out.push(oficial("TESORO", fecha, anios >= 10 ? 28 : 26, "Departamento del Tesoro de EE. UU.",
        "https://www.treasurydirect.gov/auctions/upcoming/", x.securityType + " " + x.securityTerm,
        "Subasta de deuda del Tesoro a " + anios + " años",
        "La demanda por deuda estadounidense mueve las tasas de referencia de los mercados emergentes."));
    }
    return out;
  } catch {
    return [];
  }
}

// El calendario de indicadores de la Oficina del Censo. Cada fila trae el nombre
// del indicador y un código con la fecha y la hora (A202610150830).
const CENSO = [
  [/Advance Monthly Sales for Retail/i, 50, "Ventas minoristas de EE. UU.",
   "Mide el consumo en Estados Unidos, una de las variables que sigue la Reserva Federal para decidir tasas."],
  [/Advance Report on Durable Goods/i, 45, "Pedidos de bienes duraderos en EE. UU.",
   "Anticipa la inversión de las empresas estadounidenses y la fortaleza de su industria."],
  [/New Residential Construction/i, 35, "Construcción de viviendas en EE. UU.",
   "Los permisos e inicios de obra muestran cómo responde la economía estadounidense a las tasas de interés."],
  [/Advance Economic Indicators/i, 34, "Indicadores adelantados de EE. UU.",
   "Adelanta el comercio de bienes y los inventarios de Estados Unidos, incluidas sus compras de petróleo."],
  [/New Residential Sales/i, 30, "Venta de viviendas nuevas en EE. UU.",
   "Mide el pulso del sector inmobiliario estadounidense, sensible a las tasas de la Reserva Federal."],
  [/Manufacturers' Shipments, Inventories and Orders/i, 28, "Pedidos a fábricas en EE. UU.",
   "El informe completo de la industria estadounidense, que sigue la Reserva Federal."],
];
// OJO: calendar-listview.html trae el calendario del AÑO QUE VIENE (medido el
// 09/10/2026: solo filas de 2027). El del año en curso es calendar-listview-AAAA.
async function agendaCenso(sem) {
  const fin = sumarDias(sem.lunes, 6);
  const URLC = "https://www.census.gov/economic-indicators/calendar-listview-" + sem.lunes.slice(0, 4) + ".html";
  try {
    const r = await fetch(URLC, { headers: UA });
    if (!r.ok) return [];
    const t = await r.text();
    const out = [];
    // <a href="/retail">Advance Monthly Sales…</a></td><td sorttable_customkey="202610150830">
    const re = />([^<]{8,140})<\/a><\/td>\s*<td sorttable_customkey="(\d{4})(\d{2})(\d{2})\d{4}"/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const fecha = m[2] + "-" + m[3] + "-" + m[4];
      if (fecha < sem.lunes || fecha > fin) continue;
      for (const [patron, prioridad, nombre, porque] of CENSO) {
        if (patron.test(m[1]) && !out.some((e) => e.nombre === nombre)) {
          out.push(oficial("CENSO", fecha, prioridad, "Oficina del Censo de EE. UU.", URLC, m[1].trim(), nombre, porque));
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}


// EL CALENDARIO ECONÓMICO DE FOREXFACTORY (su exportación semanal en JSON). Es
// un agregador, no una fuente oficial, pero trae lo que los calendarios
// oficiales legibles no dan: la inflación y el empleo de EE. UU. (la web de la
// BLS da 403 a la lectura automática), las reuniones de la OPEP+, los discursos
// de Trump y las decisiones de otros bancos centrales, cada una con su impacto.
// Solo publica la semana EN CURSO: sirve para la edición que se arma el lunes,
// que es la de esa semana. Se queda solo con lo de impacto medio o alto, y cada
// evento conocido trae su nombre y su texto en español; lo desconocido no entra.
const FOREX = [
  // [patrón del título, moneda (o null), prioridad, familia, nombre, por qué]
  [/^(Federal Funds Rate|FOMC Statement)/, "USD", 100, "FED", "Reserva Federal decide tasas",
   "La decisión sobre las tasas de interés de Estados Unidos mueve el dólar, el petróleo y el costo del financiamiento externo."],
  [/OPEC/i, null, 85, "OPEP", "Reunión de la OPEP+",
   "Sus decisiones sobre la producción mueven el precio del crudo, el principal ingreso de Venezuela."],
  [/^(Core )?CPI m\/m/, "USD", 80, "DATOS_EEUU", "Inflación de Estados Unidos",
   "El dato marca buena parte del rumbo de las tasas de la Reserva Federal y del valor del dólar."],
  [/^Non-Farm Employment Change/, "USD", 80, "DATOS_EEUU", "Empleo en Estados Unidos",
   "El informe de empleo es el dato que más mueve las expectativas sobre las tasas de la Reserva Federal."],
  [/^Core PCE Price Index/, "USD", 62, "DATOS_EEUU", "Inflación PCE de Estados Unidos",
   "Es el índice de precios que la Reserva Federal usa para medir la inflación."],
  [/^(Advance|Prelim|Final) GDP/, "USD", 65, "DATOS_EEUU", "PIB de Estados Unidos",
   "La estimación del crecimiento de la mayor economía del mundo, que marca la demanda de petróleo y el rumbo de las tasas."],
  [/^(Core )?Retail Sales m\/m/, "USD", 50, "DATOS_EEUU", "Ventas minoristas de EE. UU.",
   "Mide el consumo en Estados Unidos, una de las variables que sigue la Reserva Federal para decidir tasas."],
  [/^(Core )?PPI m\/m/, "USD", 45, "DATOS_EEUU", "Precios al productor en EE. UU.",
   "Anticipa la inflación que llegará al consumidor y las próximas decisiones de la Reserva Federal."],
  [/^ISM (Manufacturing|Services) PMI/, "USD", 45, "DATOS_EEUU", "Índice ISM de EE. UU.",
   "La encuesta a empresas adelanta si la economía estadounidense acelera o se frena."],
  [/^Unemployment Claims/, "USD", 25, "DATOS_EEUU", "Solicitudes de desempleo en EE. UU.",
   "El dato semanal de despidos que siguen los mercados para medir el empleo estadounidense."],
  [/^Fed Chair .* (Speaks|Testifies)/, "USD", 60, "FED", "Habla el presidente de la Fed",
   "Cualquier señal sobre las tasas de interés de Estados Unidos mueve el dólar y el precio del petróleo."],
  [/^FOMC Meeting Minutes/, "USD", 70, "FED", "Actas de la Reserva Federal",
   "Las minutas de su última reunión darán pistas sobre el rumbo de las tasas de interés en Estados Unidos."],
  [/^President Trump Speaks/, "USD", 50, "CASA_BLANCA", "Habla Donald Trump",
   "Sus anuncios sobre comercio, sanciones o petróleo pueden mover los mercados y la relación con Venezuela."],
  [/^(Main Refinancing Rate|Monetary Policy Statement)/, "EUR", 45, "OTROS_BC", "El BCE decide tasas",
   "La decisión del Banco Central Europeo mueve el euro frente al dólar y el apetito por riesgo global."],
  [/^Official Bank Rate/, "GBP", 40, "OTROS_BC", "El Banco de Inglaterra decide tasas",
   "Su decisión mueve la libra y se suma a las señales de los grandes bancos centrales."],
  [/^BOJ Policy Rate/, "JPY", 40, "OTROS_BC", "El Banco de Japón decide tasas",
   "Su decisión mueve el yen y los flujos de capital hacia los mercados emergentes."],
  [/^(GDP q\/y|Industrial Production y\/y)/, "CNY", 45, "CHINA", "Datos de crecimiento de China",
   "China es uno de los grandes compradores de petróleo: su crecimiento pesa en el precio del crudo."],
];

const URLX = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// LIMITA LAS PETICIONES: medido el 09/10/2026, tras unas pocas seguidas
// contesta 429 durante minutos, y las IP de Cloudflare son compartidas. Así
// que la última respuesta buena se guarda en KV (la refresca el cron de cada
// tres horas) y la edición la usa si en ese momento no contesta.
async function bajarForex(env) {
  try {
    const r = await fetch(URLX, { headers: BROWSER_UA });
    if (!r.ok) return null;
    const lista = await r.json();
    if (Array.isArray(lista) && lista.length) await kvPut(env, "forex:semana", { ts: Date.now(), lista: lista });
    return lista;
  } catch {
    return null;
  }
}

async function agendaForex(env, sem) {
  const fin = sumarDias(sem.lunes, 6);
  try {
    let lista = await bajarForex(env);
    if (!lista) lista = ((await kvGet(env, "forex:semana", null)) || {}).lista || [];
    const out = [];
    for (const x of lista) {
      if (!/^(High|Medium)$/.test(x.impact || "")) continue;
      const fecha = String(x.date || "").slice(0, 10);
      if (fecha < sem.lunes || fecha > fin) continue;
      for (const [patron, moneda, prioridad, familia, nombre, porque] of FOREX) {
        if (!patron.test(x.title || "") || (moneda && x.country !== moneda)) continue;
        if (out.some((e) => e.nombre === nombre)) break;
        const e = oficial("FOREX", fecha, prioridad, "Calendario económico (ForexFactory)", URLX,
                          x.country + " " + x.title, nombre, porque);
        e.familia = familia;
        out.push(e);
        break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// La familia de cada candidato, para no repetir: como mucho uno de cada una
// (dos de la prensa, que es lo venezolano). Pedido de Saúl el 09/10/2026: «no
// es para poner eventos de EIA todas las semanas, tiene que ser variado».
function familiaDe(c) {
  if (c.familia) return c.familia;
  return { FED: "FED", BEA: "DATOS_EEUU", CENSO: "DATOS_EEUU", EIA: "EIA", TESORO: "TESORO",
           PRENSA: "PRENSA" }[c.origen] || c.origen;
}

// El calendario de la BEA (PIB, ingreso y gasto personal, comercio exterior de
// EE. UU.): una tabla con «October 29 8:30 AM News GDP (Advance Estimate)…».
// No trae el año en cada fila; es el calendario vigente, así que es el del lunes.
async function agendaBea(sem) {
  const fin = sumarDias(sem.lunes, 6);
  try {
    const r = await fetch("https://www.bea.gov/news/schedule", { headers: UA });
    if (!r.ok) return [];
    const html = await r.text();
    const out = [];
    for (const fila of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
      const t = fila.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
      const m = t.match(/^([A-Z][a-z]+)\s+(\d{1,2})\s+[\d:]+\s*[AP]M\s+N\s*ews\s+(.+)$/);
      if (!m) continue;
      const mes = MESES_EN.indexOf(m[1].toLowerCase()) + 1;
      if (mes < 1) continue;
      const fecha = sem.lunes.slice(0, 4) + "-" + String(mes).padStart(2, "0") + "-" + String(m[2]).padStart(2, "0");
      if (fecha >= sem.lunes && fecha <= fin) {
        const URLB = "https://www.bea.gov/news/schedule";
        const BEA = [[/^GDP/i, 65, "PIB de Estados Unidos", "La estimación del crecimiento de la mayor economía del mundo, que marca la demanda de petróleo y el rumbo de las tasas."],
                     [/Personal Income and Outlays/i, 62, "Ingreso y gasto personal en EE. UU.", "Incluye el índice de precios que la Reserva Federal usa para medir la inflación."],
                     [/International Trade in Goods and Services/i, 40, "Comercio exterior de EE. UU.", "Mide las importaciones estadounidenses, incluidas las de petróleo."]];
        for (const [patron, prioridad, nombre, porque] of BEA) {
          if (patron.test(m[3]) && !out.some((e) => e.nombre === nombre)) {
            out.push(oficial("BEA", fecha, prioridad, "Oficina de Análisis Económico de EE. UU. (BEA)", URLB, m[3], nombre, porque));
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ¿Dice la fuente esa fecha? «6 de noviembre» (con o sin «el»), o el día de la
// semana que cae esa fecha. No basta con que el modelo la ponga.
function verificarEvento(fecha, texto) {
  const [a, m, d] = fecha.split("-").map(Number);
  const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const mes = MESES_LARGOS[m - 1].normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (new RegExp("\\b" + d + "\\s+de\\s+" + mes + "\\b").test(t)) return true;
  const dia = DIAS_SEMANA[new Date(fecha + "T12:00:00Z").getUTCDay()].normalize("NFD").replace(/[̀-ͯ]/g, "");
  return new RegExp("\\b(este|el|proximo|el proximo)\\s+" + dia + "\\b").test(t);
}

// Los eventos que el modelo propuso, filtrados: dentro de la semana que empieza,
// con fuente de la lista y con la fecha confirmada. Si no llegan a tres, se
// completa con los oficiales de mayor prioridad que no estén ya (con su texto
// propio). Máximo tres, ordenados por fecha.
function eventosVerificados(lineas, sem, candidatos) {
  const fin = sumarDias(sem.lunes, 6);
  const out = [];
  const usados = new Set();
  for (const l of lineas) {
    const p = l.split("|").map((x) => x.trim());
    if (p.length < 4) continue;
    const ref = p[0].toUpperCase().replace(/[^A-Z0-9]/g, "");
    const fecha = (p[1].match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
    const c = candidatos[ref];
    if (!c || !fecha || fecha < sem.lunes || fecha > fin || usados.has(ref)) {
      console.log("[entorno] evento descartado (fuera de la semana, sin fuente o repetido): " + l.slice(0, 120));
      continue;
    }
    const ok = c.origen === "PRENSA" ? verificarEvento(fecha, c.texto) : c.fecha === fecha;
    if (!ok) {
      console.log("[entorno] evento descartado (la fuente no dice esa fecha): " + l.slice(0, 120));
      continue;
    }
    usados.add(ref);
    // Lo de la prensa que pasa la verificación es de Venezuela, la OPEP+ o la
    // OFAC: va por delante de cualquier dato de Estados Unidos.
    out.push({ fecha: fecha, nombre: sinGuiones(p[2]), descripcion: sinGuiones(p.slice(3).join(" ")),
               fuente: c.fuente || "", url: c.url || "", prioridad: c.origen === "PRENSA" ? 90 : c.prioridad || 0,
               familia: familiaDe(c) });
  }
  // Los oficiales que el modelo no tomó, con su texto propio. Luego se queda con
  // los tres más relevantes de todos: así un evento flojo elegido por el modelo
  // (el gas, el 09/10/2026) no deja fuera uno fuerte (el Libro Beige).
  for (const k of Object.keys(candidatos)) {
    const c = candidatos[k];
    if (c.origen === "PRENSA" || usados.has(k) || out.some((e) => e.nombre === c.nombre)) continue;
    out.push({ fecha: c.fecha, nombre: c.nombre, descripcion: c.descripcion, fuente: c.fuente, url: c.url,
               prioridad: c.prioridad || 0, familia: familiaDe(c) });
  }
  out.sort((x, y) => y.prioridad - x.prioridad);
  // VARIADA: como mucho uno por familia (dos de la prensa venezolana). Solo si
  // con esa regla no se llega a tres se permite repetir familia.
  const elegidos = [];
  const usadas = {};
  for (const e of out) {
    if (elegidos.length >= 3) break;
    const tope = e.familia === "PRENSA" ? 2 : 1;
    if ((usadas[e.familia] || 0) >= tope) continue;
    usadas[e.familia] = (usadas[e.familia] || 0) + 1;
    elegidos.push(e);
  }
  for (const e of out) {
    if (elegidos.length >= 3) break;
    if (!elegidos.includes(e)) elegidos.push(e);
  }
  for (const e of elegidos) { delete e.prioridad; delete e.familia; }
  elegidos.sort((x, y) => (x.fecha < y.fecha ? -1 : 1));
  return elegidos;
}

// EL PROMPT SIGUE LA GUÍA MAESTRA DE CONTENIDO (equipo de comunicación, 7 de
// octubre de 2026). Cada límite de palabras, cada regla de formato y cada
// criterio de selección de abajo viene de ahí; si la guía cambia, se cambia
// aquí. Los límites además son las cajas de la plantilla verde (DAHWrdKhQZs):
// pasarse no rompe la lámina, porque render.py encoge el texto, pero encogido
// deja de parecerse a la plantilla.
function promptEntorno(d, noticias, sem, agenda) {
  const lista = noticias
    .map((n, i) => {
      const etq = (n.g || "OTRO") + (n.p ? "/" + n.p : "");
      const medio = medioDe(n.t) || "";
      const directo = n.l && !/news\.google\./i.test(n.l) ? " [directo]" : "";
      const cab =
        `${i + 1}. [${etq}]${directo} ${sinMedio(n.t)}` +
        (medio ? ` (medio: ${medio})` : "") +
        (n.d ? ` (${n.d})` : "");
      const res = i < 14 ? resumenUtil(n) : "";
      return res ? cab + "\n   → " + res : cab;
    })
    .join("\n");
  const listaAgenda = Object.keys(agenda)
    .map((k) => k + ". " + (agenda[k].fecha ? "[" + agenda[k].fecha + "] " : "") + agenda[k].texto +
      (agenda[k].fuente ? " (" + agenda[k].fuente + ")" : ""))
    .join("\n");
  return (
    "Eres el editor de ENTORNO EN VIÑETAS, el boletín semanal de SurEconomics: las noticias " +
    "de la semana sobre Venezuela, cada una leída con tres lentes (económico, político y " +
    "crecimiento).\n" +
    "Esta edición sale el lunes " + fechaLarga(sem.lunes) + " y cubre la semana " +
    rangoSemana(sem) + ". Los datos de mercado tienen fecha de corte el " + fechaLarga(sem.corte) + ".\n\n" +
    "REGLAS QUE APLICAN A TODO (no negociables):\n" +
    "1. PROHIBIDO usar guiones de cualquier tipo: ni guion, ni raya, ni flechas. Fechas escritas " +
    "(«26 de junio», nunca «26-jun» ni «24-J»), rangos con palabras («del 12 al 18»), nombres " +
    "compuestos con «y» («eje La Guaira y Caracas»), incisos entre comas, y en el texto las " +
    "bajadas se dicen con palabras («baja 0,09%», nunca «-0,09%»).\n" +
    "2. Formato numérico venezolano: punto para miles y coma para decimales (1.450; 7,5%). " +
    "Moneda como US$ o Bs.\n" +
    "3. Toda cifra sale de los DATOS o de los TITULARES de abajo, con su fuente nombrada en el " +
    "texto. Si un dato no está ahí, no se publica. NO inventes cifras ni fechas.\n" +
    "4. Usa siempre la cifra más reciente, no la del primer reporte (si un balance se " +
    "actualizó, va el último, con su fecha).\n" +
    "5. Tono neutro y descriptivo en los hechos. La opinión solo vive en el bloque de análisis " +
    "(los tres lentes), y siempre argumentada con datos.\n" +
    "6. Nada de relleno: ningún campo con texto genérico, repetido o de plantilla.\n" +
    "7. Español de Venezuela, sin una palabra en inglés. Texto plano, sin markdown ni " +
    "asteriscos. Respeta EXACTAMENTE los marcadores ### y las etiquetas de cada campo.\n\n" +
    "FORMATO EXACTO DE SALIDA:\n" +
    "###PORTADA\n" +
    "TITULAR: el titular de la semana, máximo 12 palabras. Es la noticia 01 contada en una " +
    "frase con gancho (ejemplo: «El petróleo ya salió del pozo. Falta que salga de la cuenta.»).\n" +
    "###NOTICIA1\n###NOTICIA2\n###NOTICIA3\n###NOTICIA4\n" +
    "Cuatro noticias de la semana SOBRE VENEZUELA, ordenadas de mayor a menor impacto. La 01 " +
    "es la de mayor impacto económico medible; a igualdad, la que más afecta el bolsillo del " +
    "lector. Dentro de cada bloque, estas líneas en este orden:\n" +
    "TEMA: una sola palabra entre VENEZUELA, PETRÓLEO, FINANZAS, POLÍTICA o ENERGÍA.\n" +
    "TITULO: el hecho en máximo 4 palabras y unos 22 caracteres, sin guiones (ejemplo: «Terremotos " +
    "de junio»). Va a 121 px en una caja de dos renglones: una palabra larga no cabe.\n" +
    "SUBTITULO: el ángulo específico que desarrolla la viñeta, máximo 8 palabras. Ese ángulo " +
    "TIENE que aparecer explicado en el cuerpo (si el subtítulo nombra una licencia, el cuerpo " +
    "explica esa licencia).\n" +
    "FUENTE: solo el número del titular de la lista en que se basa.\n" +
    "LUGAR: solo en la NOTICIA1: la ciudad o el lugar donde pasa el hecho, tal como se " +
    "llama en Wikipedia (ejemplo: Caracas). De ahí sale la foto de fondo de la portada.\n" +
    "PROTAGONISTA: solo en la NOTICIA1: la persona, institución u objeto protagonista, tal " +
    "como se llama en Wikipedia (ejemplo: Fondo Monetario Internacional). Es la foto de la polaroid.\n" +
    "SECUNDARIO: solo en la NOTICIA1: otro actor, institución u objeto de la misma noticia, " +
    "distinto del protagonista, tal como se llama en Wikipedia. Es la foto de «¿Qué podría pasar?».\n" +
    "CUERPO:\n" +
    "exactamente 3 párrafos separados por una línea en blanco, máximo 120 palabras entre los " +
    "tres: (1) qué pasó, con fecha y lugar; (2) las cifras clave, con su fuente nombrada; (3) " +
    "quién respondió o qué cambió.\n" +
    "ECONOMICO: qué le cuesta o le aporta esto a la economía o al bolsillo, CON UNA CIFRA. " +
    "Máximo 50 palabras.\n" +
    "POLITICO: qué cambia en las relaciones de poder, la regulación o la relación con Estados " +
    "Unidos. Máximo 50 palabras.\n" +
    "CRECIMIENTO: qué oportunidad o riesgo abre para la inversión en los próximos meses. " +
    "Máximo 50 palabras.\n" +
    "Los tres lentes responden preguntas distintas y NINGUNO repite lo que ya dice el cuerpo.\n" +
    "###EVENTOS\n" +
    "Hasta 3 eventos de la semana que empieza el " + fechaLarga(sem.lunes) + " que pueden " +
    "mover la economía venezolana (publicación de datos oficiales, vencimientos de licencias " +
    "OFAC, decisiones de la Reserva Federal, elecciones, subastas de divisas, reuniones de la " +
    "OPEP+, vencimientos de deuda), SOLO de la lista AGENDA de abajo y con una fecha que esa " +
    "lista diga. Una línea por evento, con este formato exacto:\n" +
    "REF | AAAA-MM-DD | nombre del evento en máximo 6 palabras | descripción de máximo 25 " +
    "palabras que empieza por la fecha escrita y dice por qué importa\n" +
    "(ejemplo: A3 | 2026-11-06 | BCV publica inflación de octubre | Viernes 6 de noviembre. " +
    "Dirá si la inflación mensual sigue en un dígito por tercer mes.)\n" +
    "Las referencias F, B, E, C y T son calendarios oficiales (Reserva Federal, BEA, EIA, " +
    "Oficina del Censo y Tesoro de EE. UU.) y van ordenadas de más a menos relevantes; las A " +
    "son de la prensa. Elige los tres que más puedan mover la economía venezolana: un evento " +
    "de Venezuela, de la OPEP+ o de la OFAC con fecha confirmada va por delante de un dato de " +
    "Estados Unidos. Escribe el nombre en español. Si no hay tres, pon los que haya: el sistema " +
    "completa con los oficiales. NUNCA inventes un evento ni una fecha.\n" +
    "###ESCENARIO\n" +
    "¿Qué podría pasar?: escenario sobre la NOTICIA1 para las próximas semanas, en 2 párrafos " +
    "y máximo 120 palabras. Es la única sección que especula, y lo hace con condiciones " +
    "claras. El primer párrafo plantea el escenario más probable y la condición que lo " +
    "activa; el segundo, el alternativo y qué señal lo anticiparía. Estructura: «Si " +
    "[condición], lo más probable es [resultado], porque [dato]. Si en cambio [condición " +
    "alternativa], [resultado alternativo]. La señal a vigilar: [indicador o evento].»\n" +
    "###LATAM\n" +
    "Exactamente 3 puntos, uno por país de América Latina distinto de Venezuela, separados " +
    "por una línea con tres guiones bajos (___). Cada punto empieza por el nombre del país y " +
    "trae una cifra, máximo 50 palabras (ejemplo: «Argentina sale de la recesión: crecería " +
    "cerca de 4,5% este año, con una inflación que bajó de tres dígitos a cerca de 14%.»). " +
    "Prioriza Colombia y Brasil (vecinos y socios comerciales), luego Argentina y México, y " +
    "después el resto. Solo entra lo que sirve de comparación o tiene efecto sobre Venezuela. " +
    "El primero es el más fuerte.\n" +
    "###LATAM_CONCLUSION\n" +
    "Una conclusión de máximo 40 palabras que conecte los tres puntos, idealmente con una " +
    "lectura para Venezuela.\n" +
    "###LATAM_FUENTE\n" +
    "Los números de los titulares de cada punto de LATAM, en orden y separados por comas.\n" +
    "###LATAM_PAIS\n" +
    "El país del primer punto, en una palabra o dos.\n\n" +
    "CÓMO ELEGIR LAS CUATRO NOTICIAS:\n" +
    "- Hechos concretos de los titulares marcados [VZ] y publicados en la semana cubierta: " +
    "una decisión, una cifra oficial, una operación, un anuncio. Nada de declaraciones sin " +
    "efecto económico medible.\n" +
    "- Fuentes válidas: BCV, Gaceta Oficial, OFAC y Departamento del Tesoro, Departamento de " +
    "Estado, PDVSA, OPEP, PNUD, Banco Mundial, FMI y medios con verificación editorial. Redes " +
    "sociales solo si es una cuenta oficial.\n" +
    "- Cada noticia cuenta un hecho DISTINTO. Entre dos de relevancia parecida, elige la " +
    "marcada [directo]: de ahí sale su foto.\n" +
    "- La tasa del BCV, el paralelo, la brecha, la devaluación, la inflación y los mercados " +
    "ya tienen su página (Economía en cifras): una noticia que sea solo que una de esas " +
    "cifras subió o bajó está repetida. Sí pueden ir como contexto.\n\n" +
    "DATOS DUROS (calculados por el sistema, son la verdad):\n" +
    resumenDatosParaIA(d) +
    "\n\nAGENDA (candidatos para ###EVENTOS; cada uno con su referencia):\n" +
    (listaAgenda || "(sin candidatos esta semana)") +
    "\n\nTITULARES. La línea que empieza con '→' es el resumen de esa noticia: úsalo para el " +
    "detalle. Si un dato no está en el titular ni en su resumen, NO lo afirmes.\n" +
    lista +
    "\n\nEscribe ahora la edición."
  );
}

// Los campos de cada bloque ###NOTICIAn. Se aceptan con tilde y sin ella y con
// los asteriscos que a veces pone el modelo aunque se le pida texto plano: un
// campo que no se reconoce es una lámina con un hueco.
const CAMPOS_NOTICIA = /^\s*\**\s*(TEMA|T[IÍ]TULO|SUBT[IÍ]TULO|SUMARIO|FUENTE|LUGAR|PROTAGONISTA|SECUNDARIO|CUERPO|ECON[OÓ]MICO|POL[IÍ]TICO|CRECIMIENTO|LECTURA|TEXTO\s*2)\s*\**\s*:\s*\**/gim;

function parseNoticia(bloque) {
  const out = {};
  const marcas = [];
  let m;
  CAMPOS_NOTICIA.lastIndex = 0;
  while ((m = CAMPOS_NOTICIA.exec(bloque)) !== null) {
    const k = m[1].toUpperCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "");
    marcas.push({ k: k, i: m.index, fin: CAMPOS_NOTICIA.lastIndex });
  }
  for (let i = 0; i < marcas.length; i++) {
    const hasta = i + 1 < marcas.length ? marcas[i + 1].i : bloque.length;
    out[marcas[i].k] = bloque.slice(marcas[i].fin, hasta).trim();
  }
  const limpio = (s) => sinGuiones(String(s || "").replace(/^[\s▪•*]+/, ""));
  return {
    tema: (out.TEMA || "").toUpperCase().split(/\s+/)[0] || "",
    titulo: limpio(out.TITULO),
    subtitulo: limpio(out.SUBTITULO),
    fuente: parseInt((out.FUENTE || "").match(/\d+/) || [NaN], 10),
    lugar: limpio(out.LUGAR),
    protagonista: limpio(out.PROTAGONISTA),
    secundario: limpio(out.SECUNDARIO),
    cuerpo: (out.CUERPO || "").split(/\n\s*\n/).map(sinGuiones).filter(Boolean).join("\n\n"),
    lentes: { economico: limpio(out.ECONOMICO), politico: limpio(out.POLITICO), crecimiento: limpio(out.CRECIMIENTO) },
  };
}

function parseSecciones(txt) {
  const out = {};
  const re = /###\s*(PORTADA|NOTICIA\s*[1-4]|EVENTOS|ESCENARIO|LATAM_CONCLUSION|LATAM_FUENTE|LATAM_PAIS|LATAM|CONTRAPORTADA)\s*\n?/gi;
  const marcas = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    marcas.push({ k: m[1].toUpperCase().replace(/\s+/g, ""), i: m.index, fin: re.lastIndex });
  }
  for (let i = 0; i < marcas.length; i++) {
    const hasta = i + 1 < marcas.length ? marcas[i + 1].i : txt.length;
    out[marcas[i].k] = txt.slice(marcas[i].fin, hasta).trim();
  }
  out.noticias = [1, 2, 3, 4]
    .map((n) => (out["NOTICIA" + n] ? parseNoticia(out["NOTICIA" + n]) : null))
    .filter((x) => x && (x.titulo || x.cuerpo));
  out.titular = sinGuiones((out.PORTADA || "").replace(/^\s*\**\s*TITULAR\s*\**\s*:\s*/i, "").split("\n")[0]);
  return out;
}

// --- Armado de la edición ---
async function buildEntorno(env) {
  const sem = semanaEntorno(hoyVET());
  const [datos, gVz, gLatam, gGlobal, tVz, tLatam, guardadas, gAgenda, fed, bea, eia, censo, gas, tesoro, forex, ...gVzExtra] = await Promise.all([
    gatherEntornoData(env, sem.corte),
    fetchNews(ENTORNO_Q_VZ, 12),
    fetchNews(ENTORNO_Q_LATAM, 12),
    fetchNews(ENTORNO_Q_GLOBAL, 8),
    fetchWebNews(env, "Venezuela economía dólar inflación petróleo esta semana", 6),
    fetchWebNews(env, "América Latina economía banco central empresas esta semana", 6),
    kvGet(env, "articles", []),
    fetchNews(ENTORNO_Q_AGENDA, 15),
    agendaFed(sem),
    agendaBea(sem),
    agendaEia(sem),
    agendaCenso(sem),
    agendaGas(sem),
    agendaTesoro(sem),
    agendaForex(env, sem),
    ...ENTORNO_Q_VZ_EXTRA.map((q) => fetchNews(q, 12)),
  ]);
  const curadas = filtrarNoticias(
    [].concat(
      etiquetar(gVz, "VZ"),
      etiquetar([].concat(...gVzExtra), "VZ"),
      etiquetar(tVz, "VZ"),
      etiquetar(gLatam, "LATAM"),
      etiquetar(tLatam, "LATAM"),
      etiquetar(gGlobal, "GLOBAL")
    ),
    true
  );
  const delHistorial = filtrarNoticias(
    etiquetar(guardadas.slice(0, 200), "LATAM").map((n) =>
      /venezuela|bcv|pdvsa|bol[íi]var|caracas/i.test(n.t) ? Object.assign(n, { g: "VZ" }) : n
    ),
    true
  );
  // SOLO LA SEMANA CUBIERTA. La guía: «cubre la semana anterior, de lunes a
  // domingo». Las que no traen fecha se quedan (no se puede decir que sean
  // viejas). Si la semana deja menos de seis de Venezuela —pasa si se arma a
  // mitad de semana—, se vuelve a la ventana de doce días y se dice en el log.
  const enSemana = (n) => {
    const ts = Date.parse(n.d || "");
    if (!ts) return true;
    const dia = fechaVET(ts);
    return dia >= sem.desde && dia <= sem.hasta;
  };
  let pozo = mergeNews(curadas, delHistorial, 120);
  const semanal = pozo.filter(enSemana);
  if (semanal.filter((n) => n.g === "VZ").length >= 6) pozo = semanal;
  else console.log("[entorno] la semana " + sem.desde + "/" + sem.hasta + " trae pocas de Venezuela; uso doce días");
  const noticias = seleccionarNoticias(pozo);

  // La agenda: F1.. de la Reserva Federal, A1.. de la prensa (ver agendaFed).
  const agenda = {};
  // Las referencias: F (Fed), B (BEA), E (EIA), C (Censo) y A (prensa). Los
  // oficiales van primero y por prioridad: es el orden en que el modelo los ve.
  const oficiales = [].concat(fed, bea, eia, censo, gas, tesoro, forex).sort((x, y) => y.prioridad - x.prioridad);
  const letra = { FED: "F", BEA: "B", EIA: "E", CENSO: "C", TESORO: "T", FOREX: "X" };
  const cuenta = {};
  for (const e of oficiales) {
    const l = letra[e.origen];
    cuenta[l] = (cuenta[l] || 0) + 1;
    agenda[l + cuenta[l]] = e;
  }
  filtrarNoticias(gAgenda, false).slice(0, 15).forEach((n, i) => {
    agenda["A" + (i + 1)] = { origen: "PRENSA", texto: sinMedio(n.t) + (resumenUtil(n) ? ". " + resumenUtil(n) : ""),
                              fuente: medioDe(n.t), url: n.l || "" };
  });

  const redaccion = await aiEntorno(env, promptEntorno(datos, noticias, sem, agenda));
  const crudo = redaccion.texto;
  console.log("[entorno] la escribió " + redaccion.quien);
  const s = parseSecciones(crudo);
  const eventos = eventosVerificados((s.EVENTOS || "").split("\n").filter((l) => l.includes("|")), sem, agenda);

  // FOTOS: una por viñeta y otra para Latam, ninguna repetida, todas pedidas a
  // la vez (ver la nota de septiembre en la versión anterior: en serie no hay
  // tiempo). El fondo de portada y la foto de «¿Qué podría pasar?» las pone
  // render.py desde Wikidata (LUGAR y PROTAGONISTA de la noticia 01).
  const todas = [].concat(curadas, delHistorial);
  const elegida = (k) => enlaceDirecto((Number.isFinite(k) && noticias[k - 1]) || null, todas);
  const fuentesLatam = ((s.LATAM_FUENTE || "").match(/\d+/g) || [])
    .slice(0, 3)
    .map((k) => elegida(parseInt(k, 10)))
    .filter(Boolean);
  // UNA VIÑETA SIN TITULAR DE ORIGEN SE DESCARTA. Es una noticia que el modelo
  // armó con la tabla de cifras o de memoria: la guía pide «toda cifra con
  // fuente real», y el 09/10/2026 salieron tres así. Mejor una viñeta menos (el
  // chequeo lo avisa) que una noticia sin fuente.
  s.noticias = s.noticias.filter((nt) => {
    const ok = Number.isFinite(nt.fuente) && noticias[nt.fuente - 1];
    if (!ok) console.log("[entorno] viñeta descartada, sin titular de origen: " + nt.titulo);
    return ok;
  });
  const fuentes = s.noticias.map((nt) => elegida(nt.fuente));
  const pozoFotos = [];
  for (const n of fuentes.concat(fuentesLatam)) {
    if (n && n.l && !pozoFotos.some((c) => c.l === n.l)) pozoFotos.push(n);
  }
  const imagenes = new Map(
    await Promise.all(pozoFotos.map(async (n) => [n.l, await ogImagen(n.l)]))
  );
  const usadas = new Set();
  const foto = (n) => {
    const img = n && imagenes.get(n.l);
    if (!img || usadas.has(img)) return "";
    usadas.add(img);
    return img;
  };

  const notas = s.noticias.map((nt, i) => {
    const src = fuentes[i];
    return Object.assign({}, nt, {
      numero: i + 1,
      imagen: foto(src),
      url: src ? src.l || "" : "",
      medio: src ? medioDe(src.t) : "",
      fuenteTitulo: src ? sinMedio(src.t) : "",
    });
  });
  const puntos = (s.LATAM || "")
    .split(/\n?(?:_{3,}|-{3,})\n?/)
    .map((x) => sinGuiones(x.replace(/^[\s▪•*]+/, "")))
    .filter(Boolean)
    .slice(0, 3);
  const latam = { puntos: puntos, conclusion: sinGuiones(s.LATAM_CONCLUSION || ""),
                  pais: sinGuiones((s.LATAM_PAIS || "").split("\n")[0]), imagen: "", url: "", medio: "" };
  // La foto de Latam es la del punto más fuerte (el primero), según la guía.
  const lat0 = fuentesLatam[0];
  if (lat0) Object.assign(latam, { imagen: foto(lat0), url: lat0.l || "", medio: medioDe(lat0.t) });
  const escenario = (s.ESCENARIO || "").split(/\n\s*\n/).map(sinGuiones).filter(Boolean).join("\n\n");

  const partes = [];
  if (notas.length) {
    partes.push(
      "📰 <b>ENTORNO EN VIÑETAS</b>\n<i>Semana " + escapeHtml(rangoSemana(sem)) + " · SurEconomics</i>\n\n" +
        (s.titular ? "<b>" + escapeHtml(s.titular) + "</b>\n\n" : "") +
        "<b>En esta edición</b>\n" +
        notas.map((n) => "(0" + n.numero + ") <b>" + escapeHtml(n.titulo) + "</b>: " + escapeHtml(n.subtitulo)).join("\n")
    );
    for (const n of notas) partes.push(textoNoticia(n));
  } else {
    // Si el modelo no respetó los marcadores, mandamos su texto tal cual: es
    // mejor una edición imperfecta que ninguna.
    partes.push("📰 <b>ENTORNO EN VIÑETAS</b>\n\n" + escapeHtml(crudo));
  }
  partes.push(
    "<b>¿Qué estamos esperando?</b>\n\n" +
      (eventos.length
        ? eventos.map((e, i) => "0" + (i + 1) + " <b>" + escapeHtml(e.nombre) + "</b>\n" + escapeHtml(e.descripcion)).join("\n\n")
        : "<i>Sin eventos con fecha confirmada para esta semana.</i>") +
      (escenario ? "\n\n<b>¿Qué podría pasar?</b>\n\n" + escapeHtml(escenario) : "")
  );
  partes.push(bloqueCifras(datos));
  if (puntos.length) {
    partes.push(
      "<b>🌎 LATAM ENLATADA</b>\n\n" +
        puntos.concat(latam.conclusion ? [latam.conclusion] : []).map((x) => "• " + escapeHtml(x)).join("\n\n") +
        "\n\n" + bloqueFuentes(noticias)
    );
  } else {
    partes.push(bloqueFuentes(noticias));
  }

  const principal = notas[0] || null;
  return {
    ts: Date.now(),
    fecha: datos.hoy,
    parts: partes,
    datos: datos,
    secciones: s,
    noticias: notas,
    latam: latam,
    semana: { desde: sem.desde, hasta: sem.hasta, lunes: sem.lunes },
    titular: s.titular || "",
    eventos: eventos,
    escenario: escenario,
    escrita_por: redaccion.quien,
    portada: principal
      ? { titulo: principal.fuenteTitulo, medio: principal.medio, url: principal.url,
          fecha: "", imagen: principal.imagen }
      : null,
    titulares: noticias.slice(0, 12).map((n) => ({
      t: sinMedio(n.t), medio: medioDe(n.t), l: n.l || "", d: n.d || "", g: n.g || "",
    })),
  };
}

// Una viñeta de la edición, como mensaje de Telegram: cuerpo y los tres lentes.
function textoNoticia(n) {
  const lentes = n.lentes || {};
  const L = [["economico", "Económico"], ["politico", "Político"], ["crecimiento", "Crecimiento"]]
    .filter(([k]) => lentes[k])
    .map(([k, nombre]) => "\n\n▪ <b>" + nombre + ":</b> " + escapeHtml(lentes[k]));
  const viejas = L.length ? [] : [].concat(n.lectura || []).map((l) => "\n\n▪ <i>" + escapeHtml(l) + "</i>");
  return (
    "<b>(0" + n.numero + ") " + escapeHtml(n.tema) + " · " + escapeHtml(n.titulo) + "</b>\n" +
    (n.subtitulo ? "<i>" + escapeHtml(n.subtitulo) + "</i>\n" : "") + "\n" +
    escapeHtml(n.cuerpo) + L.join("") + viejas.join("") +
    (n.url ? '\n\n<a href="' + escapeHtml(n.url) + '">Fuente: ' + escapeHtml(n.medio || "nota original") + "</a>" : "")
  );
}

function bloqueFuentes(noticias) {
  const links = noticias
    .filter((n) => n.l)
    .slice(0, 5)
    .map((n) => '• <a href="' + escapeHtml(n.l) + '">' + escapeHtml(n.t) + "</a>")
    .join("\n");
  return (
    "<b>Fuentes de datos</b>\n" +
    "<i>BCV / ve.dolarapi.com (tasas), Bolsa de Valores de Caracas (IBC), " +
    "Yahoo Finance (índices, commodities, cripto).</i>" +
    (links ? "\n\n<b>Titulares usados</b>\n" + links : "")
  );
}

// Los primeros 'max' caracteres de una respuesta, cortando la descarga en
// cuanto se tienen. Si el cuerpo no se deja leer por partes, se lee entero.
async function principioDe(r, max) {
  if (!r.body || !r.body.getReader) return (await r.text()).slice(0, max);
  const lector = r.body.getReader();
  const dec = new TextDecoder();
  let txt = "";
  while (txt.length < max) {
    const { value, done } = await lector.read();
    if (done) break;
    txt += dec.decode(value, { stream: true });
  }
  try { await lector.cancel(); } catch {}
  return txt.slice(0, max);
}

// Foto de la lámina: la imagen destacada (og:image) del artículo fuente. Es lo
// único que puede ilustrar la noticia de la semana sin criterio humano.
async function ogImagen(url) {
  if (!url) return "";
  try {
    // Con el UA de bot, medios como Infobae devuelven 403 y no hay foto.
    // CON TOPE DE TIEMPO: las fotos se piden todas a la vez con Promise.all, y
    // un solo medio que acepte la conexión y no conteste colgaría la edición
    // entera. Es la trampa 9 de este repo en versión Worker.
    const r = await fetch(url, {
      headers: BROWSER_UA, redirect: "follow", signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "";
    // SOLO EL PRINCIPIO DE LA PÁGINA. og:image va en el <head>, y leer el
    // cuerpo entero para luego recortarlo gastaba CPU en decodificar medio
    // megabyte por nota. Con la plantilla de cuatro noticias se buscan hasta
    // nueve fotos por edición, y el plan gratuito de Cloudflare mide la CPU.
    const html = await principioDe(r, 90000);
    for (const re of [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]) {
      const m = html.match(re);
      if (m && /^https?:\/\//.test(m[1])) return decodeEntities(m[1]);
    }
  } catch {}
  return "";
}

// Caché de 6 h: dos pedidos seguidos no queman cuota de IA ni cambian el texto.
async function getEntorno(env, force) {
  const cache = await kvGet(env, "entorno:last", null);
  if (!force && cache && cache.parts && Date.now() - cache.ts < ENTORNO_TTL * 1000) {
    return cache;
  }
  try {
    const ed = await buildEntorno(env);
    await kvPut(env, "entorno:last", ed);
    return ed;
  } catch (e) {
    if (cache && cache.parts) return Object.assign({}, cache, { degradado: true });
    throw e;
  }
}

async function enviarEntorno(env, chatId, force) {
  // SI HAY QUE ARMARLA DE CERO, SE DICE Y SE DICE QUÉ HACER. Armarla tarda unos
  // 26 s y esto corre en ctx.waitUntil(), que Cloudflare corta a los ~30 s: da
  // tiempo a armarla y guardarla en KV, pero a veces no a enviarla, y entonces
  // el Worker muere sin excepción y la persona se queda con el "dame unos
  // segundos" para siempre. Pasó del 03/09 al 14/09/2026 sin que nadie supiera
  // por qué.
  //
  // Lo bueno es que ese intento NO se pierde: getEntorno() guarda en KV antes
  // de devolver, así que volver a pedirla la sirve al instante. Por eso el
  // aviso dice justo eso en vez de dejar a la persona mirando el chat.
  const enCache = await kvGet(env, "entorno:last", null);
  const fria = force || !enCache || !enCache.parts ||
    Date.now() - enCache.ts >= ENTORNO_TTL * 1000;

  // EN FRÍO YA NO SE ARMA AQUÍ, Y ESTO CAMBIÓ CON LA PLANTILLA DE CUATRO
  // NOTICIAS (24/09/2026). Con una noticia, armarla tardaba 26 s y cabía justo
  // en los ~30 s de waitUntil. Con cuatro, el modelo escribe más del doble y
  // hay cinco fotos que buscar: no cabe, y el corte de Cloudflare no avisa.
  //
  // Una petición HTTP al Worker, en cambio, no tiene ese límite mientras quien
  // la hace siga esperando. Así que se lanza entorno.yml, y es render.py el que
  // pide la edición: el Worker la arma dentro de esa petición, la guarda en KV
  // y se la devuelve; el workflow manda el texto y luego las láminas al chat
  // que la pidió. Sin GITHUB_PAT no hay workflow que lanzar, y se sigue
  // armando aquí como antes: mejor intentarlo que no mandar nada.
  if (fria && env.GITHUB_PAT) {
    const lanzado = await dispararLaminas(env, chatId, { conTexto: true, forzar: force });
    await sendMessage(
      env,
      chatId,
      lanzado
        ? "📰 No tengo la edición de esta semana armada, así que la armo de cero. " +
          "Tarda unos minutos: te llegan aquí el texto y las láminas."
        : "No pude lanzar el armado del newsletter. Intenta de nuevo en unos minutos."
    );
    return;
  }
  await sendMessage(
    env,
    chatId,
    fria
      // Sin etiquetas: sendMessage() no manda parse_mode y un <b> saldría a la
      // vista. El HTML es cosa de sendHtml(), que es por donde va el newsletter.
      ? "📰 No tengo la edición de esta semana en memoria, así que la armo de " +
        "cero. Tarda cerca de medio minuto. Si no te llega, vuelve a pedírmela: " +
        "la segunda vez sale al instante."
      : "📰 Armando el Entorno en Viñetas… dame unos segundos."
  );
  let ed;
  try {
    ed = await getEntorno(env, force);
  } catch (e) {
    await sendMessage(
      env,
      chatId,
      "No pude armar el newsletter ahora mismo (falló la IA o una fuente de datos). " +
        "Intenta de nuevo en unos minutos."
    );
    return;
  }
  const edad = Date.now() - ed.ts;
  if (ed.degradado || edad > ENTORNO_MAX_EDAD) {
    await sendMessage(
      env,
      chatId,
      "⚠️ Te mando la última edición disponible (" + fechaLarga(ed.fecha) + "). " +
        "No pude regenerarla con datos de hoy."
    );
  }
  for (const p of ed.parts) await sendHtml(env, chatId, p);

  // Las laminas con el diseno las dibuja GitHub Actions y las manda al mismo
  // chat que las pidio. Si no hay token configurado, el texto ya salio y no se
  // menciona nada: el newsletter no depende del render.
  if (env.GITHUB_PAT) {
    const ok = await dispararLaminas(env, chatId);
    await sendMessage(
      env,
      chatId,
      ok
        ? "🎨 Armando las láminas con la plantilla; llegan en un par de minutos."
        : "⚠️ El texto salió, pero no pude disparar el render de las láminas."
    );
  }
}

// ---------------------------------------------------------------------------
// /nota: pedir que la redaccion automatica escriba una noticia.
//
// LISTA BLANCA, decidida el 01/09/2026. Solo los chat id dados de alta en
// REDACCION_IDS pueden pedir notas. Sin esto, cualquiera que de con el bot
// gasta cuota de IA y crea borradores en el panel del medio, y en Telegram
// cualquier miembro de un grupo puede añadir a otro.
//
// YA NO SE EXIGE UN ENLACE. Hasta el 03/09/2026 un tema suelto se rechazaba
// aqui mismo, y el motivo era bueno: con un tema habria que fiarse de lo que el
// modelo recuerde, que es justo lo que este motor no hace. Lo que cambio es que
// nota.py ya no se fia: busca el tema en la lista blanca, lee hasta tres medios
// distintos y escribe desde esos documentos. Sigue sin haber una sola cifra que
// no venga de una fuente leida; lo unico que se ahorra es que la persona tenga
// que ir a buscar el enlace ella. Si no encuentra nada, lo dice y no escribe.
// "Redactame una noticia de X" dicho a mano, sin acordarse del comando.
//
// EL PATRON ES ESTRECHO A PROPOSITO. Tiene que haber un VERBO EN IMPERATIVO
// («redacta», «escribe», «haz») pegado a «nota» o «noticia». Con algo mas suelto
// -cualquier frase que mencionase «noticia»- se dispararia una corrida de
// Actions cada vez que alguien preguntase "¿que noticias hay de Chevron?", que
// es la pregunta mas comun que recibe el bot. Falso negativo: la persona escribe
// /nota. Falso positivo: se gasta una corrida y aparece un borrador que nadie
// pidio.
// Como llama la gente a cada tipo. La palabra que se escribe nunca es el nombre
// interno: se pide "un articulo", "una columna", "un reportaje". El nombre
// canonico -con sus tildes- es el que entiende nota.py.
//
// 'articulo' es Análisis y no Opinión, aunque el prompt de opinion se titule
// "Articulo de opinion": en el sitio ese formato se llama 'articulo' y es el que
// Edicion pide cuando dice articulo. Una columna firmada se pide por su nombre.
const TIPOS_PEDIDO = {
  nota: "Noticia", noticia: "Noticia", pieza: "Noticia",
  articulo: "Análisis", analisis: "Análisis",
  editorial: "Editorial",
  columna: "Opinión", opinion: "Opinión",
  reportaje: "Investigación", informe: "Investigación",
  investigacion: "Investigación",
  explicador: "Educación",
};

const PEDIDO_NOTA = new RegExp(
  "^\\s*(?:me\\s+)?(?:puedes\\s+|podrias\\s+|porfa\\s+)?" +
  "(redact|escrib|haz(?:me)?|hac(?:me)?|arma(?:me)?|prepara(?:me)?)\\w*" +
  "(?:me)?\\s+(?:una?\\s+|la\\s+|el\\s+)?(" +
  Object.keys(TIPOS_PEDIDO).join("|") + ")\\b",
  "i");

// Sin tildes, LETRA A LETRA. Tiene que conservar las posiciones para poder
// recortar despues sobre el texto original; por eso no se usa normalize("NFD"),
// que descompone en dos caracteres y descuadra los indices.
//
// Hace falta porque el primer patron no reconocia "redáctame", que es
// literalmente como lo escribio Edicion: "redact" no casa contra "redáct".
function sinTildes(s) {
  return String(s || "").replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g,
    (c) => "aeiouunAEIOUUN"["áéíóúüñÁÉÍÓÚÜÑ".indexOf(c)]);
}

function esPedidoNota(texto) {
  return PEDIDO_NOTA.test(sinTildes(texto));
}

// QUIEN FIRMA. Una opinión sin nombre y apellido no se escribe: el prompt
// devuelve faltantes:["autor"] y no hay pieza, asi que las columnas no se
// podian encargar desde el bot.
//
// SE EXIGEN DOS PALABRAS EN MAYUSCULA, o sea nombre y apellido. En español "de"
// introduce igual al autor que al tema, y con una sola palabra "una columna de
// Venezuela" habria firmado la pieza como "Venezuela". Un nombre completo si es
// una señal fiable, y ademas es lo que la opinión necesita: firmar con el
// nombre de pila no vale para un medio.
//
// Se busca sobre el texto SIN tildes por lo de siempre, pero se recorta y se
// devuelve sobre el ORIGINAL: la firma se publica, y "Oscar Doval" no es como
// se llama.
const NOMBRE_FIRMA =
  "[A-ZÁÉÍÓÚÑ][a-záéíóúñ'-]+(?:\\s+(?:de|del|la|las|los|van|von|da|di))?" +
  "(?:\\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'-]+){1,3}";
// Y HAY DOS CASOS, no uno, porque "de" no basta como señal.
//
// "hazme una noticia de Nicolás Maduro" habria firmado la pieza como Maduro. En
// español "de" introduce igual al autor que al tema, y con un nombre propio
// detras el sentido lo decide QUE TIPO DE PIEZA es, no la gramatica:
//
//   - "una columna de Óscar Doval"  -> la escribe Óscar Doval
//   - "una noticia de Óscar Doval"  -> habla de Óscar Doval
//
// Asi que el "de" suelto solo cuenta en los tipos que van firmados. Para todo
// lo demas hace falta decirlo: "firma: X", "firmada por X".
const AUTORIA_EXPLICITA = new RegExp(
  "\\b(?:firmad[ao]\\s+por|firma\\s*:\\s*|firma\\s+|escrit[ao]\\s+por)\\s+(" +
  NOMBRE_FIRMA + ")");
const AUTORIA_IMPLICITA = new RegExp("\\b(?:de|por)\\s+(" + NOMBRE_FIRMA + ")");

// Los tipos que no se publican sin nombre y apellido. El editorial no entra:
// lo firma la redaccion por definicion, que es lo que lo separa de una columna.
const TIPOS_FIRMADOS = ["Opinión", "Investigación"];

function _firma(texto, tipo) {
  const t = String(texto || "");
  const m = AUTORIA_EXPLICITA.exec(t);
  if (m) return m;
  return TIPOS_FIRMADOS.indexOf(tipo) >= 0 ? AUTORIA_IMPLICITA.exec(t) : null;
}

function autorDelPedido(texto, tipo) {
  const m = _firma(texto, tipo);
  return m ? m[1].trim() : "";
}

// El texto sin la parte de la firma. Hay que quitarla antes de calcular el
// tema: "Óscar Doval" dentro de la consulta busca notas SOBRE Óscar Doval, que
// es lo contrario de lo que se pidio.
function sinLaFirma(texto, tipo) {
  const original = String(texto || "");
  const m = _firma(original, tipo);
  if (!m) return original;
  return (original.slice(0, m.index) + " " + original.slice(m.index + m[0].length))
    .replace(/\s{2,}/g, " ").trim();
}

// Que tipo de pieza se pidio. La palabra viaja aparte del tema porque
// temaDelPedido() se la come al recortar: "redactame un articulo sobre X" deja
// "X", y sin esto el tipo se perdia y salia una noticia.
function tipoDelPedido(texto) {
  const m = PEDIDO_NOTA.exec(sinTildes(texto));
  return (m && TIPOS_PEDIDO[m[2].toLowerCase()]) || "Noticia";
}

// Lo que queda del encargo una vez quitado el "redactame una noticia de".
// Se le pasa a /nota como tema; si dentro hay un enlace, comandoNota lo detecta
// y escribe desde esa fuente en vez de buscar.
function temaDelPedido(texto) {
  const original = String(texto || "");
  const m = PEDIDO_NOTA.exec(sinTildes(original));
  // Se corta sobre el ORIGINAL, con las tildes puestas: el tema se va a buscar
  // en medios en español y "Maria Corina Machado" sin tilde busca peor.
  const resto = m ? original.slice(m.index + m[0].length) : original;
  return resto
    .replace(/^\s*(?:sobre|de|acerca de|del|de la|con)\b\s*/i, "")
    .trim();
}

// Quien puede pedir notas. Lo usan el comando y las capturas: una sola lista.
function enLaRedaccion(env, chatId) {
  return String(env.REDACCION_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean).includes(String(chatId));
}

// ---------------------------------------------------------------------------
// El toque de un boton de la franja dudosa.
//
// DONDE ESTA EL ENLACE. En callback_data no cabe: Telegram lo limita a 64
// bytes y una direccion de noticia se pasa sola. Asi que el boton solo lleva su
// numero ("nota:2") y la direccion se saca del texto del propio mensaje, que ya
// la lleva escrita en su linea /nota. No hace falta guardar nada en ningun
// sitio, y eso es lo que hace que siga funcionando dentro de una semana: no hay
// estado que caduque, se pierda al redesplegar ni haya que limpiar.
//
// El texto llega SIN formato (Telegram entrega el plano, no el HTML), asi que
// las direcciones se ven tal cual.
async function comandoBoton(env, cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const responder = (aviso) => avisarBoton(env, cq.id, aviso);

  if (!enLaRedaccion(env, chatId)) {
    await responder("Solo la redacción puede pedir notas.");
    return;
  }
  // Dos botones distintos, misma mecanica: "nota:N" elige entre los candidatos
  // de una captura dudosa; "forzar:N" reescribe una que la memoria da por
  // publicada. Solo cambia si se manda o no la instruccion "igual".
  const partes = String(cq.data || "").split(":");
  const n = parseInt(partes[1], 10);

  // "subir:<corrida>" NO REDACTA NADA. La pieza ya se escribio y quedo en el
  // artefacto de aquella corrida: subir_borrador.yml se lo baja y lo sube tal
  // cual. Es lo que se quiere cuando la memoria da algo por repetido y no lo
  // es: la persona acaba de leer el borrador entero aqui y lo unico que
  // discute es el veredicto, asi que reescribirlo le devolveria un texto
  // distinto del que aprobo.
  //
  // Va antes que lo demas porque no necesita enlace ninguno.
  if (partes[0] === "subir") {
    const corrida = String(partes[1] || "").replace(/\D/g, "");
    if (!corrida) {
      await responder("No sé de qué corrida es ese borrador.");
      return;
    }
    await responder("La subo igual.");
    const subio = await dispararWorkflow(env, "subir_borrador.yml",
      { corrida: corrida, chat: String(chatId) });
    await sendMessage(env, chatId, subio
      ? "📤 Recuperando ese borrador y subiéndolo al panel. Va marcado como parecido a otro."
      : "⚠️ No pude lanzar la subida. Vuelve a intentarlo en un momento.");
    return;
  }

  // "boletin:<corrida>" SUBE EL ENTORNO AL BOLETÍN DEL SITIO Y LO DEJA ACTIVO:
  // el lunes a las 9:00 sale por correo a toda la lista. Es de lo poco de este
  // bot que acaba publicado sin más revisión, y por eso: solo la redacción (la
  // comprobación de arriba), solo al tocarlo alguien que acaba de ver el álbum,
  // y el botón se quita en cuanto se toca, para que dos toques no suban dos
  // veces. subir_boletin.py tampoco pisa un número que ya tenga páginas.
  //
  // La corrida es la de entorno.yml que dibujó esas láminas: boletin.yml se baja
  // su artefacto y sube exactamente lo que estaba en el chat.
  if (partes[0] === "boletin") {
    const corrida = String(partes[1] || "").replace(/\D/g, "");
    if (!corrida) {
      await responder("No sé de qué edición es ese botón.");
      return;
    }
    await responder("Lo subo al boletín.");
    await quitarBotones(env, cq.message, "📤 Subiendo al boletín… te aviso aquí cuando esté.");
    const lanzado = await dispararEnBot(env, "boletin.yml", { corrida: corrida, chat: String(chatId) });
    if (!lanzado) {
      await sendMessage(env, chatId, "⚠️ No pude lanzar la subida al boletín. No se envió nada; vuelve a pedir /entorno en un momento.");
    }
    return;
  }

  // "post:<id>" TAMPOCO REDACTA NADA. La pieza ya esta publicada: post.yml la
  // lee del panel y dibuja la lamina. Hasta el 23/09/2026 este boton no
  // existia y la unica salida del aviso «esa ya esta publicada» era
  // «Escribirla igual», que rehace la pieza entera y deja un borrador
  // duplicado que nadie queria, solo para conseguir el post.
  //
  // VIAJA EL id Y NO EL slug: en callback_data caben 64 bytes y los slugs del
  // sitio llegan a 89 caracteres («la-can-y-el-mercosur-declaran-el-estado-de-
  // emergencia-hidrica-en-la-cuenca-de-la-amazonia»). Un id son tres digitos.
  //
  // Va aqui arriba por lo mismo que "subir": no necesita ningun enlace.
  if (partes[0] === "post") {
    const pieza = String(partes[1] || "").replace(/\D/g, "");
    if (!pieza) {
      await responder("No sé de qué pieza es ese post.");
      return;
    }
    await responder("Te hago el post.");
    const lanzado = await dispararWorkflow(env, "post.yml",
      { enlace: pieza, chat: String(chatId) });
    await sendMessage(env, chatId, lanzado
      ? "🖼️ Dibujando la lámina de esa pieza. No reescribo nada ni toco el " +
        "panel.\n\nSi quieres el texto a tu manera, repítelo con /post y el " +
        "enlace, y escribe debajo «titular:» y «bajada:»."
      : "⚠️ No pude lanzar el post. Vuelve a intentarlo en un momento.");
    return;
  }

  // DE DONDE SALE LA DIRECCION. Por dos vias, y las dos hacen falta.
  //
  // 1. Las lineas "/nota <url>" del texto. Es lo que llevan los avisos con
  //    varios candidatos, donde ademas el ORDEN importa: el boton dice "el 2"
  //    y hay que coger el segundo.
  // 2. Los enlaces puestos como <a href>. Telegram manda su direccion en
  //    entities[].url y NO dentro de text, asi que el aviso de "repetida"
  //    puede pasar la fuente sin enseñar ningun comando: la persona ve dos
  //    botones y ya. Solo cuentan los 'text_link' -los que llevan href-, que
  //    es lo que deja fuera la url del sitio que va escrita a la vista.
  const texto = String((cq.message && cq.message.text) || "");
  const enlaces = texto.match(/\/nota\s+(https?:\/\/\S+)/g) || [];
  const conHref = ((cq.message && cq.message.entities) || [])
    .filter((e) => e && e.type === "text_link" && e.url)
    .map((e) => e.url);
  const elegido =
    (enlaces[n - 1] || "").replace(/^\/nota\s+/, "") ||
    conHref[n - 1] ||
    conHref[0] ||
    "";
  const forzar = partes[0] === "forzar";
  if (!elegido) {
    // Pasa si el mensaje es viejo y se edito, o si el boton no casa con el
    // texto. Mejor decirlo que escribir la nota equivocada.
    await responder("No encuentro ese enlace. Mándamelo con /nota.");
    return;
  }

  // El aviso del boton se contesta ANTES de disparar. Telegram deja el boton
  // girando hasta que se le responde y solo espera unos segundos; lanzar
  // primero el workflow dejaria la sensacion de que no paso nada.
  await responder(forzar ? "La escribo igual." : "Voy con esa.");
  const ok = await dispararNota(env, chatId, cq.from,
    { enlace: elegido, encargo: forzar ? "igual" : "" });
  await sendMessage(env, chatId, ok
    ? (forzar
        ? "📝 A ello, aunque ya esté publicada. "
        : "📝 A ello, desde ese enlace. ") +
      "Te lo devuelvo aquí en unos minutos."
    : "⚠️ No pude lanzar la redacción. Vuelve a intentarlo en un momento.");
}

// Contesta el toque para que el boton deje de girar. Si esto falla no se corta
// nada: es cosmetico y la nota ya se pidio.
async function avisarBoton(env, id, texto) {
  try {
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/answerCallbackQuery",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: id, text: texto }),
      });
  } catch {
    /* el boton se queda girando un rato y ya */
  }
}

// Un solo sitio que dispara nota.yml. Antes estaba escrito dentro de
// comandoNota y al llegar las capturas habria hecho falta una segunda copia;
// hoy mismo un nombre calculado en dos sitios distintos ya costo una corrida.
// Un solo sitio que habla con la API de Actions. Lo pedia el comentario de
// arriba y ahora hay dos workflows que disparar: nota.yml a peticion y
// diario.yml por reloj.
async function dispararWorkflow(env, archivo, inputs) {
  if (!env.GITHUB_PAT) return false;
  try {
    const r = await fetch(
      "https://api.github.com/repos/" + REPO_MEDIO +
      "/actions/workflows/" + archivo + "/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.GITHUB_PAT,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "sureconomics-bot",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: inputs }),
      }
    );
    return r.status === 204; // GitHub responde 204 sin cuerpo cuando acepta
  } catch {
    return false;
  }
}

async function dispararNota(env, chatId, quien, extra) {
  const nombre = [quien && quien.first_name, quien && quien.last_name]
    .filter(Boolean).join(" ") || String(chatId);
  return dispararWorkflow(env, "nota.yml", Object.assign(
    // chat: para que el borrador vuelva por donde se pidio, no solo al correo.
    { enlace: "", foto: "", encargo: "", quien: nombre, tipo: "Noticia",
      chat: String(chatId) },
    extra));
}

// EL RELOJ DE LAS TANDAS. Las 8:00 a.m. y las 2:00 p.m. de Venezuela.
//
// POR QUE NO BASTA EL "schedule" DE GITHUB, que sigue puesto. Llega tarde y no
// poco: medido el 01/09/2026, el de las 12:00 UTC llego a las 16:22 y el de las
// 18:00 a las 20:53. El 04/09 el de las 18:00 aparecio a las 20:37. Para un
// medio que titula "la tanda de la mañana", cuatro horas tarde no es un retraso,
// es otra cosa.
//
// El cron de Cloudflare si es puntual, y ademas ya estaba aqui: este Worker
// tiene el PAT, sabe hablar con Actions y corre crons desde el primer dia. No
// hace falta cron-job.org ni una credencial mas que mantener.
//
// EL "schedule" DE GITHUB SE QUEDA COMO RED. La guardia de diario.yml corre
// siempre ante un disparo pedido y salta el del reloj si esa tanda ya salio:
// asi que si Cloudflare falla, el de GitHub llega tarde pero llega, y si
// Cloudflare funciona, el de GitHub se descarta solo. No hay que elegir.
async function dispararTanda(env, cuando) {
  // LA HORA SALE DE scheduledTime Y NO DEL RELOJ. Es la hora a la que TOCABA
  // correr, no a la que se ejecuta: si un dia la entrega se retrasa, la tanda
  // sigue etiquetandose bien. Es la misma leccion que dejo github.event.schedule
  // en la guardia, y ahi costo una tanda mal etiquetada.
  const hora = new Date(cuando).getUTCHours();
  const tanda = hora < 15 ? "manana" : "tarde";
  // origen=reloj: la guardia de diario.yml lo trata como al schedule y no
  // repite una tanda que ya salio. Sin esto, una tanda lanzada a mano mas la
  // del reloj daban doce borradores, porque la guardia solo frenaba los
  // 'schedule' y este cron dispara por workflow_dispatch igual que una persona.
  const ok = await dispararWorkflow(env, "diario.yml",
    { tanda: tanda, piezas: "6", sin_subir: "false", origen: "reloj" });
  console.log("tanda " + tanda + " (" + hora + ":00 UTC): " +
              (ok ? "lanzada" : "NO se pudo lanzar"));
  return ok;
}

// Una captura de pantalla mandada al bot. Se coge la de MAYOR resolucion:
// Telegram manda el mismo archivo en varios tamaños y el ultimo es el grande.
// Con la miniatura, el texto del titular no se lee.
async function comandoCaptura(env, chatId, msg) {
  if (!enLaRedaccion(env, chatId)) {
    await sendMessage(env, chatId,
      "Recibí la imagen, pero este bot solo redacta para la redacción. Si " +
      "necesitas acceso, pide que añadan tu chat ID (" + chatId + ") a la lista.");
    return;
  }
  const grande = msg.photo[msg.photo.length - 1];
  // Se manda el file_id y NO la direccion de descarga: esa lleva el token del
  // bot dentro y quedaria escrita en el registro de Actions para siempre.
  // EL PIE DE FOTO ES UNA INSTRUCCION. Lo escribio una persona junto a la
  // imagen: "hazla editorial", "enfocala en Venezuela". Viaja como encargo y
  // nota.py saca de ahi el tipo de pieza y la orden de edicion.
  const pie = (msg.caption || "").trim();
  const ok = await dispararNota(env, chatId, msg.from,
    { foto: grande.file_id, encargo: pie });
  await sendMessage(env, chatId, ok
    ? "👀 Leyendo la captura." +
      (pie ? " Tomo nota de: «" + pie.slice(0, 120) + "»." : "") +
      " Busco la nota original en los medios de la lista y, si aparece, te " +
      "devuelvo el borrador aquí. Si no la encuentro, te lo digo."
    : "⚠️ No pude procesar la imagen. Vuelve a intentarlo en un momento.");
}

// /post: la lamina de Instagram de una pieza YA PUBLICADA.
//
// POR QUE NO ES /nota CON UNA BANDERA. La lamina no necesita el motor: para
// dibujarla hacen falta titular corto, bajada, categoria e imagen, y para una
// pieza publicada las cuatro estan ya en el panel. Asi que esto no redacta, no
// audita, no crea borrador y no gasta cuota de redactor.
//
// EL CASO QUE LO PIDIO. Edicion pedia /nota de algo ya publicado, el motor
// contestaba «esa ya esta publicada» -correcto- y ahi se acababa: el unico
// boton era «Escribirla igual», que rehace la pieza entera y deja un borrador
// duplicado que nadie queria, solo para conseguir el post.
//
// LO QUE SE PUEDE ESCRIBIR JUNTO AL ENLACE: "titular:", "bajada:" y
// "categoria:", una por renglon. Acortar un titular es criterio de redes, no un
// dato que haya que auditar, y quien usa la lamina a diario quiere decidirlo.
// Iterar aqui cuesta segundos; por /nota costaba reescribir la nota entera.
async function comandoPost(env, chatId, texto, fotoId) {
  if (!enLaRedaccion(env, chatId)) {
    await sendMessage(env, chatId,
      "Este comando es solo para la redacción. Si necesitas acceso, pide que " +
      "añadan tu chat ID (" + chatId + ") a la lista.");
    return;
  }

  const resto = String(texto || "").replace(/^\/post(@\S+)?\s*/i, "").trim();
  const enlace = (resto.match(/https?:\/\/\S+/) || [])[0] ||
    // Sin http tambien vale un slug pelado, que es como queda si alguien copia
    // solo el final de la direccion. Se coge la primera palabra larga con
    // guiones: los slugs del sitio los llevan siempre.
    (resto.match(/^[a-z0-9]+(?:-[a-z0-9]+){2,}/i) || [])[0] || "";

  if (!enlace) {
    await sendHtml(env, chatId,
      "Dime de qué pieza hago el post:\n" +
      "<code>/post https://www.sureconomics.com/la-pieza</code>\n\n" +
      "Tiene que estar ya publicada. Si quieres el texto a tu manera, " +
      "escríbelo debajo, uno por renglón:\n" +
      "<code>titular: La Amazonía se queda sin agua</code>\n" +
      "<code>bajada: CAN y Mercosur declaran la emergencia</code>\n" +
      "<code>categoría: LATINOAMÉRICA</code>\n\n" +
      "Y si mandas una imagen con eso de pie de foto, la uso de fondo.");
    return;
  }

  if (!env.GITHUB_PAT) {
    await sendMessage(env, chatId, "No tengo credencial para lanzar el post.");
    return;
  }

  // El enlace se quita del encargo: lo demas son las instrucciones. Si no, el
  // "titular:" podria arrastrar la direccion dentro.
  const encargo = resto.replace(enlace, "").trim();
  const ok = await dispararWorkflow(env, "post.yml", {
    enlace: enlace,
    foto: fotoId || "",
    chat: String(chatId),
    encargo: encargo,
  });
  await sendMessage(env, chatId, ok
    ? "🖼️ Dibujando la lámina. No reescribo la nota ni toco el panel." +
      (fotoId ? " Uso la imagen que mandaste." : "")
    : "⚠️ No pude lanzar el post. Vuelve a intentarlo en un momento.");
}

async function comandoNota(env, chatId, text, quien, tipo, autor) {
  if (!enLaRedaccion(env, chatId)) {
    await sendMessage(env, chatId,
      "Este comando es solo para la redacción. Si necesitas acceso, pide que " +
      "añadan tu chat ID (" + chatId + ") a la lista.");
    return;
  }

  const resto = text.replace(/^\/nota(@\S+)?\s*/i, "").trim();
  const enlace = (resto.match(/https?:\/\/\S+/) || [])[0];
  if (!resto) {
    await sendHtml(env, chatId,
      "Dime de qué la escribo:\n" +
      "<code>/nota https://medio.com/la-noticia</code>\n" +
      "<code>/nota el relevo de Tim Cook en Apple</code>\n\n" +
      "Con enlace escribo desde esa fuente. Con un tema la busco en la lista " +
      "de medios y cruzo los que la cuenten.");
    return;
  }

  if (!env.GITHUB_PAT) {
    await sendMessage(env, chatId, "No tengo credencial para lanzar la redacción.");
    return;
  }

  // Lo que se escriba junto al enlace es una instruccion de edicion, igual que
  // el pie de una captura: "hazla editorial", "escribela igual aunque ya este".
  // Hasta hoy se tiraba, y con ella se tiraba la unica forma de forzar una nota
  // que la memoria daba por publicada, que es algo que el propio bot ofrece.
  //
  // SIN ENLACE, TODO EL TEXTO ES EL TEMA. No se intenta separar el tema de la
  // instruccion porque no hay forma fiable de hacerlo y equivocarse sale caro
  // en los dos sentidos: partir mal la frase estropea la busqueda, y adivinar
  // una instruccion que nadie dio cambia la pieza. nota.py busca con la frase
  // entera y ahi mismo detecta el "igual" si aparece.
  // El tipo por defecto sigue siendo Noticia. Solo cambia cuando quien escribe
  // lo pide por su nombre ("un análisis de", "una editorial sobre").
  const pedido = tipo || "Noticia";
  const ok = await dispararNota(env, chatId, quien, Object.assign(
    { tipo: pedido, autor: autor || "" },
    enlace
      ? { enlace: enlace, encargo: resto.replace(enlace, "").trim() }
      : { enlace: resto, encargo: "" }));

  const comoSale = pedido === "Noticia" ? "" : " Sale como " + pedido + ".";
  const aviso = enlace
    ? "📝 A ello. Paso la fuente por el expediente, las cifras y el auditor."
    : "🔎 A ello. Busco quién lo cuenta en la lista de medios, cruzo hasta tres " +
      "y lo paso todo por el expediente, las cifras y el auditor.";
  await sendMessage(env, chatId, ok
    ? aviso + comoSale + " Te lo devuelvo aquí en unos minutos. También va al " +
      "correo. Nada se publica solo."
    : "⚠️ No pude lanzar la redacción. Vuelve a intentarlo en un momento.");
}

// Dispara el workflow "Entorno en Vinetas" pasandole el chat que lo pidio.
// Dispara un workflow de ESTE repo (el del bot), no el del medio. dispararWorkflow
// apunta al medio, que es privado y va justo de minutos de Actions; lo que no
// necesita el motor corre aquí, que es público y gratis.
async function dispararEnBot(env, archivo, inputs) {
  if (!env.GITHUB_PAT) return false;
  try {
    const r = await fetch(
      "https://api.github.com/repos/" + GITHUB_REPO + "/actions/workflows/" + archivo + "/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.GITHUB_PAT,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "sureconomics-bot",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: inputs }),
      }
    );
    return r.status === 204;
  } catch {
    return false;
  }
}

// Cambia el texto del mensaje del botón y le quita el teclado. Sirve de acuse
// ("subiendo…") y de cerrojo: sin botón no hay segundo toque. Si falla, no
// pasa nada grave: boletin.yml tampoco sube dos veces el mismo número.
async function quitarBotones(env, mensaje, texto) {
  if (!mensaje || !mensaje.chat) return;
  try {
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/editMessageText", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: mensaje.chat.id,
        message_id: mensaje.message_id,
        text: texto,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  } catch {}
}

// conTexto: el workflow manda también el texto de la edición, no solo las
// láminas. Es lo que se pide cuando la edición se arma en frío desde Actions:
// el chat no la tenía y no llegó a mandar nada. forzar: rearmarla aunque haya
// una en caché, que es lo que pide quien escribe «actualiza el entorno».
async function dispararLaminas(env, chatId, opciones) {
  const o = opciones || {};
  try {
    const r = await fetch(
      "https://api.github.com/repos/" + GITHUB_REPO + "/actions/workflows/entorno.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.GITHUB_PAT,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "sureconomics-bot",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            chat: String(chatId),
            con_texto: o.conTexto ? "1" : "",
            forzar: o.forzar ? "1" : "",
          },
        }),
      }
    );
    return r.status === 204; // GitHub responde 204 sin cuerpo cuando acepta
  } catch {
    return false;
  }
}

// IA para el newsletter. A diferencia del chat, aquí se prueba PRIMERO el modelo
// grande: es una sola llamada por semana y la redacción es lo que se publica.
// Devuelve { texto, quien }: quién la escribió queda guardado en la edición,
// porque la calidad cambia mucho entre flash y flash-lite y así se sabe.
async function aiEntorno(env, prompt) {
  const r = await embudoGemini(env, ["gemini-3.5-flash", "gemini-3.5-flash-lite"], prompt, 30);
  if (r) return r;
  if (env.GROQ_API_KEY) return { texto: await callGroq(env, prompt), quien: "groq" };
  throw new Error("no AI available");
}

function esPedidoEntorno(t) {
  const s = t.toLowerCase();
  if (/^\/entorno\b/.test(s)) return true;
  if (/vi[ñn]etas/.test(s)) return true;
  if (/\bentorno\b/.test(s) &&
      /(dame|env[íi]a|manda|mu[ée]strame|quiero|arma|genera|resumen|newsletter|bolet[íi]n)/.test(s))
    return true;
  if (/(newsletter|bolet[íi]n|informe)\s+(semanal|de la semana)/.test(s)) return true;
  return false;
}

// El IPC lo publica el BCV una vez al mes y no hay API: se actualiza a mano.
// Uso: "/ipc 13,8 129,8 junio 2026"  (mensual, acumulada, mes)
async function comandoIpc(env, chatId, text) {
  const cuerpo = text.slice(4).trim();
  const re = /-?\d+(?:[.,]\d+)?/g;
  const nums = cuerpo.match(re) || [];
  if (nums.length < 2) {
    const ipc = await kvGet(env, "ipc", IPC_DEFAULT);
    await sendMessage(
      env,
      chatId,
      "IPC guardado: " + ipc.mes + " — " + num(ipc.mensual, 1) + "% mensual, " +
        num(ipc.acumulada, 1) + "% acumulado.\n\n" +
        "Para actualizarlo: /ipc 13,8 129,8 junio 2026\n" +
        "(primero el mensual, luego el acumulado del año, luego el mes)"
    );
    return;
  }
  let quitados = 0;
  const mes = cuerpo
    .replace(re, (m2) => (quitados++ < 2 ? " " : m2))
    .replace(/%/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ipc = {
    mes: mes || "último mes",
    mensual: parseFloat(nums[0].replace(",", ".")),
    acumulada: parseFloat(nums[1].replace(",", ".")),
    ts: Date.now(),
  };
  await kvPut(env, "ipc", ipc);
  await sendMessage(
    env,
    chatId,
    "✅ IPC actualizado: " + ipc.mes + " — " + num(ipc.mensual, 1) + "% mensual, " +
      num(ipc.acumulada, 1) + "% acumulado del año.\n" +
      "La próxima edición del Entorno en Viñetas lo usará."
  );
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Telegram ---
async function sendMessage(env, chatId, text) {
  const limit = 4000;
  for (let i = 0; i < text.length; i += limit) {
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(i, i + limit),
        disable_web_page_preview: true,
      }),
    });
  }
}

// Igual que sendMessage pero con parse_mode HTML (negritas del newsletter).
// Corta en saltos de línea para no partir una etiqueta por la mitad.
async function sendHtml(env, chatId, html) {
  const limit = 3800;
  const bloques = [];
  let actual = "";
  for (const linea of html.split("\n")) {
    if (actual && actual.length + linea.length + 1 > limit) {
      bloques.push(actual);
      actual = linea;
    } else {
      actual = actual ? actual + "\n" + linea : linea;
    }
  }
  if (actual) bloques.push(actual);
  for (const b of bloques) {
    const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: b,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    // Si Telegram rechaza el HTML, reintentamos en texto plano para no perder
    // la edición completa por una etiqueta mal formada.
    if (!r.ok) await sendMessage(env, chatId, b.replace(/<[^>]+>/g, ""));
  }
}
