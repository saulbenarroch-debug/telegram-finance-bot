# Accesos y cuentas externas

Todo lo que hay que tener para que el proyecto **no dependa de una sola persona**.
Este documento lista *qué* servicios se usan y *para qué*. **Nunca pongas aquí un
token, contraseña o clave.**

## Cuentas de las que depende producción

| Servicio | Para qué | Sin esto, qué se rompe |
|---|---|---|
| **GitHub** — `saulbenarroch-debug/telegram-finance-bot` (privado) | Código y los 4 workflows | Todo lo programado |
| **Telegram** — @BotFather | Dueño del bot; genera y revoca el token | Todo |
| **Google AI Studio** (aistudio.google.com) | `GEMINI_API_KEY`, gratis sin tarjeta | Los resúmenes salen sin IA (solo titulares) |
| **Cloudflare** | Worker `sureconomics-bot` + KV `sureconomics-kv` | El bot deja de responder en el chat y no hay newsletter |
| **cron-job.org** | El reloj: dispara los workflows a su hora | Nada sale a horario (hay que disparar a mano) |
| **Groq** (console.groq.com) | `GROQ_API_KEY`, respaldo de IA | Se pierde el respaldo cuando Gemini se agota |
| **Tavily** (app.tavily.com) | `TAVILY_API_KEY`, búsqueda en toda la web | El bot busca solo en Google News + RSS |
| **Canva** | Plantillas de referencia del diseño | Nada en producción; solo referencia de diseño |

## Lo mínimo para que el proyecto sobreviva

Si el equipo va a compartir el mantenimiento, hacen falta al menos **dos personas**
con acceso a:

1. **GitHub** con permiso de escritura y de administrar Secrets.
2. **@BotFather** — o sea, la cuenta de Telegram dueña del bot. Es el punto único
   de fallo más serio: quien no la tenga no puede revocar ni regenerar el token.
3. **Cloudflare** — cuenta o miembro con permiso sobre Workers y KV.
4. **cron-job.org** — para revisar y arreglar los horarios.

> **Pendiente de organización:** decidir si estas cuentas se pasan a
> correos/organizaciones del equipo en vez de cuentas personales. Mientras sean
> personales, el proyecto sigue dependiendo de una persona por más documentado
> que esté.

## Variables de entorno

Nueve variables. `.env` local para desarrollo, GitHub Secrets para los
workflows, bindings del Worker para el chat (los pone `deploy_worker.py`).

| Variable | Usada por | Obligatoria | De dónde sale |
|---|---|---|---|
| `TELEGRAM_TOKEN` | todo | ✅ | @BotFather |
| `CHAT_ID` | difusión (uno o varios, por coma) | ✅ | comando `/id` del bot |
| `GEMINI_API_KEY` | `bot.py`, `breaking.py`, Worker | ✅ | aistudio.google.com → Get API key (`AIza…`) |
| `GROQ_API_KEY` | respaldo de IA | ⬜ | console.groq.com → API Keys (`gsk_…`) |
| `TAVILY_API_KEY` | búsqueda web del Worker | ⬜ | app.tavily.com → API Keys (`tvly-…`) |
| `CLOUDFLARE_API_TOKEN` | `deploy_worker.py` | solo para desplegar | Cloudflare → token con plantilla "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy_worker.py` | solo para desplegar | panel de Cloudflare (barra lateral de Workers) |
| `WEBHOOK_SECRET` | Worker, `entorno/render.py` | se autogenera | lo crea `deploy_worker.py` y lo guarda en `.env` |
| `GITHUB_PAT` | el Worker, para disparar las láminas | ⬜ | GitHub → fine-grained PAT, **Actions: read/write** sobre este repo |

Si `GITHUB_PAT` falta o venció, el newsletter llega en texto y el bot avisa que
no pudo disparar el render.

### Cuáles van en GitHub Secrets

`TELEGRAM_TOKEN`, `CHAT_ID`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `WEBHOOK_SECRET`.

Los de Cloudflare y `GITHUB_PAT` **no** hacen falta en Actions: solo se usan
desde tu máquina al desplegar.

## Cómo se le da acceso a alguien nuevo

1. **GitHub:** invitarlo como colaborador con permiso de escritura.
2. **Sus propias claves de IA:** que saque su `GEMINI_API_KEY` gratis en
   aistudio.google.com y su `GROQ_API_KEY` en console.groq.com. Así prueba con su
   propia cuota y no consume la de producción.
3. **Su chat id:** que le escriba al bot y mande `/id`, y que lo ponga en su
   `.env` local. **Que NO apunte a los destinatarios reales mientras prueba.**
4. **Cloudflare:** solo si va a tocar el bot conversacional. Necesita su propio
   `CLOUDFLARE_API_TOKEN`.
5. **`WEBHOOK_SECRET`:** solo si necesita los endpoints de depuración. Pásalo por
   un canal seguro (gestor de contraseñas), nunca por chat.

Al salir alguien del proyecto: quitar el colaborador de GitHub, revocar sus
tokens de Cloudflare, y **rotar `WEBHOOK_SECRET`** si lo tuvo (corriendo
`deploy_worker.py` después de borrarlo del `.env`).

## Reglas de manejo de secretos

- Un token expuesto se considera comprometido: **revocar primero, rotar después.**
- Nada de claves en el código, en commits, en issues ni en chats.
- `.env` está en `.gitignore`. Que siga así.
- Cada persona usa sus propias claves de IA en desarrollo.
- Los tokens fine-grained de GitHub con el mínimo permiso necesario
  (Actions: read/write) y solo sobre este repo.
