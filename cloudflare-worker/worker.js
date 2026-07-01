// Sureconomics — bot conversacional (Cloudflare Worker)
// Responde preguntas en Telegram con la voz de Sureconomics.
// Variables de entorno necesarias (se configuran en el panel de Cloudflare):
//   TELEGRAM_TOKEN, GEMINI_API_KEY, GROQ_API_KEY (opcional), WEBHOOK_SECRET (opcional)

const GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
const GROQ_MODEL = "llama-3.3-70b-versatile";

const WELCOME =
  "👋 Soy el asistente de Sureconomics. Pregúntame sobre economía de " +
  "Venezuela, Suramérica, fusiones y adquisiciones (M&A) o mercados.\n\n" +
  "Ejemplos:\n" +
  "• ¿Qué está pasando con el dólar en Venezuela?\n" +
  "• Busca noticias de litio en Argentina\n" +
  "• Resume las últimas noticias de M&A en la región";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Sureconomics bot activo ✅");
    }
    // Verificacion opcional del secreto del webhook.
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
    // Procesamos en segundo plano y respondemos 200 de inmediato
    // (evita que Telegram reintente y mande respuestas duplicadas).
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("ok");
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
    const news = await fetchNews(text);
    const answer = await aiAnswer(env, text, news);
    await sendMessage(env, chatId, answer);
  } catch (e) {
    await sendMessage(
      env,
      chatId,
      "Disculpa, tuve un problema procesando tu mensaje. Intenta de nuevo en un momento."
    );
  }
}

// --- Noticias (Google News RSS a partir de la pregunta del usuario) ---
async function fetchNews(query, limit = 8) {
  try {
    const url =
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(query) +
      "&hl=es-419&gl=US&ceid=US:es-419";
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SureconomicsBot/1.0)" },
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    for (const part of xml.split("<item>").slice(1, limit + 1)) {
      const title = decodeEntities(
        (part.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || ""
      ).trim();
      const link = (
        (part.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || ""
      ).trim();
      if (title) items.push({ title, link });
    }
    return items;
  } catch {
    return [];
  }
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

// --- IA: Gemini con fallback a Groq ---
function buildPrompt(question, news) {
  const newsBlock = news.length
    ? "NOTICIAS RECIENTES (pueden servirte; el texto tras el guion final suele ser la fuente):\n" +
      news.map((n, i) => `${i + 1}. ${n.title}`).join("\n")
    : "No se encontraron noticias recientes para esta consulta.";

  return (
    "Eres el asistente de Sureconomics, un servicio centrado en Venezuela y " +
    "Suramérica que promueve la inversión en la región con criterio propio.\n\n" +
    "ESTILO: primera persona plural, con criterio editorial; pragmático y NO " +
    "partidista (valoras lo positivo para la economía de la región venga de quien " +
    "venga, y criticas con honestidad las fragilidades). Pro-inversión en el sur, " +
    "pero SIN tono publicitario y sin inventar datos.\n\n" +
    "REGLAS:\n" +
    "- Responde en el idioma del usuario (por defecto español), claro y conciso.\n" +
    "- Si la pregunta es sobre noticias, usa las de abajo y CITA la fuente. Si el " +
    "usuario pide 'solo verificadas', prioriza medios reconocidos y dilo.\n" +
    "- No inventes datos ni cifras que no estén en las noticias. Si no sabes algo, " +
    "dilo con honestidad.\n" +
    "- Texto plano, sin markdown ni HTML.\n\n" +
    newsBlock +
    "\n\nPREGUNTA DEL USUARIO:\n" +
    question
  );
}

async function aiAnswer(env, question, news) {
  const prompt = buildPrompt(question, news);
  // 1) Gemini (varios modelos, cuota separada por modelo)
  for (const model of GEMINI_MODELS) {
    try {
      return await callGemini(env, model, prompt);
    } catch (e) {
      // probamos el siguiente modelo / proveedor
    }
  }
  // 2) Groq de respaldo
  if (env.GROQ_API_KEY) {
    return await callGroq(env, prompt);
  }
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
