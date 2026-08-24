// Sureconomics — bot conversacional con memoria (Cloudflare Worker + KV)
// Bindings necesarios: TELEGRAM_TOKEN, GEMINI_API_KEY, GROQ_API_KEY,
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

const WELCOME =
  "👋 Soy el asistente de Sureconomics. Pregúntame sobre economía de " +
  "Venezuela, Suramérica, fusiones y adquisiciones (M&A) o mercados.\n\n" +
  "Guardo un historial de noticias, así que puedo comentar también lo de días " +
  "anteriores. Ejemplos:\n" +
  "• ¿Qué está pasando con el dólar en Venezuela?\n" +
  "• Busca noticias de litio en Argentina\n" +
  "• ¿Qué pasó esta semana con M&A en la región?\n\n" +
  "📰 Y para el newsletter semanal, pídeme:\n" +
  "• Dame el entorno en viñetas   (o /entorno)\n" +
  "Se arma solo cada viernes a las 8:00 a.m. (VET); si lo pides después, te lo " +
  "devuelvo al instante.";

// ---------------------------------------------------------------------------
// ENTORNO EN VIÑETAS — newsletter semanal (contraportada, noticia principal,
// economía en cifras y Latam enlatada). Regla de oro: las CIFRAS las calcula
// este código a partir de fuentes duras; la IA solo redacta la prosa.
// ---------------------------------------------------------------------------
const ENTORNO_CRON = "0 12 * * 5"; // viernes 12:00 UTC = 8:00 a.m. VET
// Repo donde vive el workflow que dibuja las laminas (Chrome headless no corre
// en un Worker, asi que el render se delega a GitHub Actions).
const GITHUB_REPO = "saulbenarroch-debug/telegram-finance-bot";
const ENTORNO_TTL = 6 * 60 * 60; // seg. que se reusa una edición ya armada
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
                portada: ed.portada || null,
                titulares: ed.titulares || [],
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
  //  - ENTORNO_CRON (viernes 8:00 a.m. VET) prearma el newsletter semanal y lo
  //    deja en KV. No se envía a nadie: queda listo para cuando lo pidan.
  async scheduled(event, env, ctx) {
    if (event.cron === ENTORNO_CRON) ctx.waitUntil(getEntorno(env, true));
    else ctx.waitUntil(ingest(env));
  },
};

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await sendMessage(env, chatId, WELCOME);
    return;
  }
  if (text === "/id") {
    await sendMessage(env, chatId, "Tu chat ID es: " + chatId);
    return;
  }
  // Newsletter semanal, por comando o pedido en lenguaje natural.
  if (esPedidoEntorno(text)) {
    await enviarEntorno(env, chatId, /\bforz|de nuevo|refresc|actualiz/i.test(text));
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
  const liveBlock = live.length
    ? "NOTICIAS EN VIVO (el texto tras el último ' - ' suele ser la fuente):\n" +
      live
        .map(
          (n, i) =>
            `${i + 1}. ${n.t}${n.a ? ` [autor: ${n.a}]` : ""}${n.d ? ` (${n.d})` : ""}`
        )
        .join("\n") +
      "\n\n"
    : "";
  const storedBlock = stored.length
    ? "HISTORIAL GUARDADO (noticias anteriores relevantes):\n" +
      stored
        .map(
          (a, i) =>
            `${i + 1}. [${a.c}] ${a.t}${a.a ? ` [autor: ${a.a}]` : ""}${a.d ? ` (${a.d})` : ""}`
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
  for (const model of GEMINI_MODELS) {
    try {
      return await callGemini(env, model, prompt);
    } catch (e) {}
  }
  if (env.GROQ_API_KEY) return await callGroq(env, prompt);
  throw new Error("no AI available");
}

async function callGemini(env, model, prompt) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    env.GEMINI_API_KEY;
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

// Último cierre + variación semanal + variación en el año.
function resumenSerie(serie) {
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
async function gatherEntornoData(env) {
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
    const r = resumenSerie(series[i]);
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
function dedupTitulos(lista) {
  const out = [];
  const bolsas = [];
  for (const n of lista) {
    const w = new Set(
      sinMedio(n.t || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((x) => x.length > 3)
    );
    let dup = false;
    for (const w2 of bolsas) {
      let inter = 0;
      for (const x of w) if (w2.has(x)) inter++;
      const union = w.size + w2.size - inter;
      if (union && inter / union > 0.5) {
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

// Marca de dónde viene cada titular: le dice al modelo qué usar para la noticia
// principal (VZ) y qué para Latam enlatada (LATAM).
function etiquetar(lista, g) {
  return lista.map((n) => Object.assign({}, n, { g: g }));
}

function promptEntorno(d, noticias) {
  // A las mejores puntuadas se les pasa el resumen del feed: con eso el modelo
  // redacta con detalle real en vez de rellenar con generalidades.
  const lista = noticias
    .map((n, i) => {
      const etq = (n.g || "OTRO") + (n.p ? "/" + n.p : "");
      const medio = medioDe(n.t) || "";
      const cab =
        `${i + 1}. [${etq}] ${sinMedio(n.t)}` +
        (medio ? ` (medio: ${medio})` : "") +
        (n.d ? ` (${n.d})` : "");
      const res = i < 14 ? resumenUtil(n) : "";
      return res ? cab + "\n   → " + res : cab;
    })
    .join("\n");
  return (
    "Actúa como analista financiero y periodista económico senior especializado en " +
    "el mercado venezolano y latinoamericano. Redactas la edición semanal de " +
    "ENTORNO EN VIÑETAS, un newsletter ejecutivo de economía y finanzas.\n" +
    "HOY ES " + fechaLarga(d.hoy) + ".\n\n" +
    "ESTILO: directo, técnico, profesional pero ágil y fácil de leer. Sintético: " +
    "cada bloque debe caber en una página de diagramación. Español de Venezuela.\n\n" +
    "REGLAS DURAS:\n" +
    "- NO inventes cifras. Solo puedes citar números que aparezcan en DATOS o en " +
    "los TITULARES de abajo. Si no tienes un dato, no lo menciones.\n" +
    "- No repitas la tabla de cifras: ese bloque lo arma el sistema aparte.\n" +
    "- ESCRIBE TODO EN ESPAÑOL, sin una sola palabra en inglés. Si el titular " +
    "original está en inglés, traduce y reescribe con tus palabras; nunca copies " +
    "un titular tal cual.\n" +
    "- Solo temas macroeconómicos, financieros o de negocios (bancos centrales, " +
    "tasas, inflación, PIB, deuda, fiscal, comercio, empresas, M&A, commodities, " +
    "energía, banca). NADA de migración, visas, clima, deportes, farándula ni " +
    "estilo de vida, aunque aparezca en los titulares.\n" +
    "- No menciones días de la semana ni 'hoy/ayer' salvo que la fecha esté en los " +
    "datos o en el titular que usas.\n" +
    "- Texto plano, sin markdown, sin asteriscos, sin viñetas dentro de los " +
    "párrafos.\n" +
    "- Respeta EXACTAMENTE los marcadores ### del formato. Nada fuera de ellos.\n\n" +
    "FORMATO EXACTO DE SALIDA:\n" +
    "###CONTRAPORTADA\n" +
    "Un solo párrafo de máximo 4 líneas que condense los temas centrales de esta " +
    "edición y funcione como gancho. Debe mencionar al menos dos hechos concretos " +
    "(con cifra o nombre propio), no generalidades.\n" +
    "###NICHO\n" +
    "El país o temática de la noticia principal, en mayúsculas, formato " +
    "VENEZUELA / MACROECONOMÍA o VENEZUELA / FINANZAS.\n" +
    "###TITULAR\n" +
    "Titular conciso y directo, una sola línea.\n" +
    "###SUBTITULO\n" +
    "Subtítulo ligeramente llamativo (amarillista pero con rigor técnico, sin " +
    "desinformar), una sola línea, que insinúe la consecuencia o el riesgo.\n" +
    "###CUERPO\n" +
    "Exactamente 3 párrafos cortos separados por una línea en blanco: (1) el hecho " +
    "y sus cifras, (2) su impacto, (3) perspectiva estratégica.\n" +
    "###FUENTE\n" +
    "Solo el número del titular de la lista en que se basa la noticia principal " +
    "(un dígito o dos, nada más). De ahí se saca la foto de la lámina.\n" +
    "###LATAM\n" +
    "Exactamente 4 ítems de países DISTINTOS de América Latina (Estados Unidos, " +
    "Europa y Asia NO cuentan como país de la región, aunque la noticia afecte a " +
    "Latam), separados por una " +
    "línea con tres guiones (---). Cada ítem: primera línea 'PAÍS — Titular en " +
    "español' (sin punto final); siguiente línea, un sumario de máximo 3 líneas " +
    "que NO empiece repitiendo el nombre del país. No incluyas Venezuela aquí (ya " +
    "va en la noticia principal).\n\n" +
    "CÓMO ELEGIR:\n" +
    "- Prefiere hechos con cifra, decisión de política económica u operación " +
    "concreta (emisión, crédito, adquisición, dato oficial). Evita declaraciones, " +
    "polémicas verbales y peleas políticas sin efecto económico medible.\n" +
    "- La noticia principal debe apoyarse en un HECHO concreto de los titulares " +
    "marcados [VZ] (una decisión, una cifra publicada, una operación, un anuncio) " +
    "y usar las cifras del cuadro como soporte. No escribas una nota que sea solo " +
    "la lectura de la tabla.\n" +
    "- Los 4 ítems de Latam salen de los titulares marcados [LATAM] o [GLOBAL] con " +
    "efecto en la región. Si un país no tiene noticia económica útil, usa otro.\n\n" +
    "DATOS DUROS (calculados por el sistema, son la verdad):\n" +
    resumenDatosParaIA(d) +
    "\n\nTITULARES RECIENTES. La línea que empieza con '→' es el resumen de esa " +
    "noticia: úsalo para dar detalle concreto. Si un dato no está en el titular " +
    "ni en su resumen, NO lo afirmes.\n" +
    lista +
    "\n\nEscribe ahora la edición."
  );
}

function parseSecciones(txt) {
  const out = {};
  const re = /###\s*(CONTRAPORTADA|NICHO|TITULAR|SUBTITULO|CUERPO|FUENTE|LATAM)\s*\n?/gi;
  const marcas = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    marcas.push({ k: m[1].toUpperCase(), i: m.index, fin: re.lastIndex });
  }
  for (let i = 0; i < marcas.length; i++) {
    const hasta = i + 1 < marcas.length ? marcas[i + 1].i : txt.length;
    out[marcas[i].k] = txt.slice(marcas[i].fin, hasta).trim();
  }
  return out;
}

// --- Armado de la edición ---
async function buildEntorno(env) {
  const [datos, gVz, gLatam, gGlobal, tVz, tLatam, guardadas] = await Promise.all([
    gatherEntornoData(env),
    fetchNews(ENTORNO_Q_VZ, 12),
    fetchNews(ENTORNO_Q_LATAM, 12),
    fetchNews(ENTORNO_Q_GLOBAL, 8),
    fetchWebNews(env, "Venezuela economía dólar inflación petróleo esta semana", 6),
    fetchWebNews(env, "América Latina economía banco central empresas esta semana", 6),
    kvGet(env, "articles", []),
  ]);
  // Curadas (queries económicas) + historial de KV, que sí exige señal económica
  // porque viene de feeds generalistas. Los [VZ] van primero para que el modelo
  // los tenga a la vista al elegir la noticia principal.
  const curadas = filtrarNoticias(
    [].concat(
      etiquetar(gVz, "VZ"),
      etiquetar(tVz, "VZ"),
      etiquetar(gLatam, "LATAM"),
      etiquetar(tLatam, "LATAM"),
      etiquetar(gGlobal, "GLOBAL")
    ),
    true
  );
  const delHistorial = filtrarNoticias(
    etiquetar(guardadas.slice(0, 60), "LATAM").map((n) =>
      /venezuela|bcv|pdvsa|bol[íi]var|caracas/i.test(n.t) ? Object.assign(n, { g: "VZ" }) : n
    ),
    true
  );
  const noticias = seleccionarNoticias(mergeNews(curadas, delHistorial, 120));

  const crudo = await aiEntorno(env, promptEntorno(datos, noticias));
  const s = parseSecciones(crudo);

  // La noticia que sustenta la nota principal: de ahí sale la foto de la lámina.
  const idx = parseInt((s.FUENTE || "").match(/\d+/) || [NaN], 10) - 1;
  // Candidatas: la que citó el modelo primero, luego las mejores de Venezuela.
  // Muchos medios no publican og:image o bloquean la descarga, así que se
  // prueban varias en vez de quedarse sin foto.
  const candidatas = [];
  for (const n of [noticias[idx]].concat(noticias.filter((x) => x.g === "VZ"), noticias)) {
    if (n && n.l && !candidatas.some((c) => c.l === n.l)) candidatas.push(n);
    if (candidatas.length >= 4) break;
  }
  let portada = null;
  for (const c of candidatas) {
    const img = await ogImagen(c.l);
    if (!portada) {
      portada = { titulo: sinMedio(c.t), medio: medioDe(c.t), url: c.l, fecha: c.d || "", imagen: img };
    }
    if (img) {
      portada = { titulo: sinMedio(c.t), medio: medioDe(c.t), url: c.l, fecha: c.d || "", imagen: img };
      break;
    }
  }
  const cabecera =
    "📰 <b>ENTORNO EN VIÑETAS</b> — Resumen semanal\n" +
    "<i>" + fechaLarga(datos.hoy) + " · Sureconomics</i>";

  const partes = [];
  if (s.CONTRAPORTADA && s.CUERPO) {
    partes.push(
      cabecera + "\n\n<b>CONTRAPORTADA</b>\n" + escapeHtml(s.CONTRAPORTADA) + "\n\n" +
        "<b>" + escapeHtml(s.NICHO || "VENEZUELA") + "</b>\n" +
        "<b>" + escapeHtml(s.TITULAR || "") + "</b>\n" +
        "<i>" + escapeHtml(s.SUBTITULO || "") + "</i>\n\n" +
        escapeHtml(s.CUERPO)
    );
  } else {
    // Si el modelo no respetó los marcadores, mandamos su texto tal cual: es
    // mejor una edición imperfecta que ninguna.
    partes.push(cabecera + "\n\n" + escapeHtml(crudo));
  }
  partes.push(bloqueCifras(datos));
  if (s.LATAM) {
    const items = s.LATAM.split(/\n?-{3,}\n?/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const lin = x.split("\n");
        return "<b>" + escapeHtml(lin[0]) + "</b>\n" + escapeHtml(lin.slice(1).join("\n").trim());
      });
    partes.push("<b>🌎 LATAM ENLATADA</b>\n\n" + items.join("\n\n") + "\n\n" + bloqueFuentes(noticias));
  } else {
    partes.push(bloqueFuentes(noticias));
  }

  return {
    ts: Date.now(),
    fecha: datos.hoy,
    parts: partes,
    datos: datos,
    // Para el renderizador de láminas (entorno/render.py): secciones sueltas,
    // no el texto ya maquetado para Telegram.
    secciones: s,
    portada: portada,
    titulares: noticias.slice(0, 12).map((n) => ({
      t: sinMedio(n.t), medio: medioDe(n.t), l: n.l || "", d: n.d || "", g: n.g || "",
    })),
  };
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

// Foto de la lámina: la imagen destacada (og:image) del artículo fuente. Es lo
// único que puede ilustrar la noticia de la semana sin criterio humano.
async function ogImagen(url) {
  if (!url) return "";
  try {
    // Con el UA de bot, medios como Infobae devuelven 403 y no hay foto.
    const r = await fetch(url, { headers: BROWSER_UA, redirect: "follow" });
    if (!r.ok) return "";
    const html = (await r.text()).slice(0, 200000);
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
  await sendMessage(env, chatId, "📰 Armando el Entorno en Viñetas… dame unos segundos.");
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

// Dispara el workflow "Entorno en Vinetas" pasandole el chat que lo pidio.
async function dispararLaminas(env, chatId) {
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
        body: JSON.stringify({ ref: "main", inputs: { chat: String(chatId) } }),
      }
    );
    return r.status === 204; // GitHub responde 204 sin cuerpo cuando acepta
  } catch {
    return false;
  }
}

// IA para el newsletter. A diferencia del chat, aquí se prueba PRIMERO el modelo
// grande: es una sola llamada por semana y la redacción es lo que se publica.
async function aiEntorno(env, prompt) {
  for (const model of GEMINI_MODELS.slice().reverse()) {
    try {
      return await callGemini(env, model, prompt);
    } catch (e) {}
  }
  if (env.GROQ_API_KEY) return await callGroq(env, prompt);
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
