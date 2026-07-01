// Sureconomics — bot conversacional con memoria (Cloudflare Worker + KV)
// Bindings necesarios: TELEGRAM_TOKEN, GEMINI_API_KEY, GROQ_API_KEY,
//                      WEBHOOK_SECRET, y KV (namespace de Cloudflare KV).

const GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
const GROQ_MODEL = "llama-3.3-70b-versatile";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; SureconomicsBot/1.0)" };

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
  // Fuentes de nicho de LatAm (negocios, M&A, VC, fintech).
  { cat: "Suramérica", url: "https://www.bloomberglinea.com/arc/outboundfeeds/rss/?outputType=xml" },
  { cat: "Suramérica", url: "https://www.cronista.com/arc/outboundfeeds/rss/" },
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
  "• ¿Qué pasó esta semana con M&A en la región?";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Endpoint protegido para poblar el historial manualmente.
    if (url.pathname === "/ingest" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const n = await ingest(env);
      return new Response("ingested " + n);
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

  // Cron: ingiere noticias al historial (se configura el schedule al desplegar).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ingest(env));
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
        stored.unshift({ t: it.title, l: it.link, d: it.date || "", a: it.author || "", c: f.cat });
        added++;
      }
    } catch {}
  }
  await kvPut(env, "articles", stored.slice(0, 300));
  return added;
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
    if (title) items.push({ title, link, date, author });
  }
  return items;
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
