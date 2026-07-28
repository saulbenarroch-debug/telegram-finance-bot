# Sureconomics

Servicio de noticias económicas por Telegram centrado en **Venezuela y
Suramérica**, con la tesis de promover la inversión en el sur.

Un mismo bot de Telegram:

- 📰 **Resume las noticias dos veces al día** (10:00 y 16:00 hora Venezuela), en
  español e inglés, redactado por IA con la voz editorial de la casa.
- 🚨 **Avisa de eventos de alto impacto** (crash, default, sanciones,
  devaluación…) revisando cada hora.
- 💬 **Responde preguntas** sobre economía de la región, buscando noticias en
  vivo y recordando la conversación.
- 🗞️ **Arma "Entorno en Viñetas"**, un newsletter semanal con 4 láminas de
  diseño, a pedido desde el chat.
- 📊 **Genera "Al Cierre"**, las 4 láminas diarias de cierre de mercados
  (Rendigroup), todos los días a las 5:30 pm.

## Documentación

| Documento | Para qué |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **Empieza aquí.** Reglas del proyecto, voz editorial, trampas conocidas. Lo lee Claude Code automáticamente. |
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Cómo funciona cada subsistema, fuentes de datos, flujo de la información. |
| [docs/OPERACION.md](docs/OPERACION.md) | Runbook: desplegar, disparar a mano, qué hacer cuando algo falla. |
| [docs/ACCESOS.md](docs/ACCESOS.md) | Cuentas y servicios externos, y quién necesita acceso a qué. |
| [al-cierre/README.md](al-cierre/README.md) | Detalle del generador de láminas de Al Cierre. |

## Arranque rápido

Necesitas **Python 3.12** y acceso al repo. Ver [docs/ACCESOS.md](docs/ACCESOS.md)
para las claves.

```bash
git clone https://github.com/saulbenarroch-debug/telegram-finance-bot.git
cd telegram-finance-bot
pip install -r requirements.txt
cp .env.example .env    # y rellena los valores
```

Para probar sin molestar a nadie, pon **tu propio chat id** en `CHAT_ID`:
escríbele algo al bot en Telegram y mándale `/id`, te responde tu id.

Luego:

```bash
python bot.py
```

Te llega el resumen a tu chat. Si eso funciona, ya tienes el entorno listo.

⚠️ Los scripts **envían mensajes reales**. Revisa a qué `CHAT_ID` apuntas antes
de correr cualquier cosa.

## Estructura

```
bot.py                      Resumen 2x/día (RSS -> IA -> Telegram)
breaking.py                 Alertas de alto impacto (cada hora)
breaking_state.json         Enlaces ya avisados (lo commitea el workflow)
get_chat_id.py              Utilidad para descubrir un chat id
requirements.txt            4 dependencias, nada más

cloudflare-worker/
  worker.js                 Bot conversacional + newsletter (corre en el borde)
scripts/
  deploy_worker.py          Despliega el Worker por la API de Cloudflare

entorno/                    "Entorno en Viñetas": láminas del newsletter
  render.py                 JSON del Worker -> HTML -> PNG (Chrome headless)
  send_telegram.py          Envía las 4 láminas como álbum
al-cierre/                  "Al Cierre": láminas diarias de cierre de mercados
  daily.py                  Orquestador (datos -> láminas -> Telegram)
  fetch_data.py             Descarga los 23 valores -> data.json
  render.py                 data.json -> HTML -> PNG
  send_telegram.py          Envía el álbum

.github/workflows/
  news.yml                  Resumen 2x/día
  breaking.yml              Alertas cada hora
  entorno.yml               Láminas del newsletter (a pedido, desde el bot)
  al-cierre.yml             Láminas de cierre, 5:30 pm
```

## Cómo trabajar en equipo

1. **Rama por cambio**, nunca directo a `main`: los workflows de `main` son los
   que corren en producción.
   ```bash
   git checkout -b mejora/lo-que-sea
   ```
2. **Prueba localmente** apuntando `CHAT_ID` a tu propio chat.
3. **Un cambio estructural = actualizar `CLAUDE.md`** en el mismo commit
   (fuente nueva, horario, secreto, decisión de diseño).
4. **Pull request** al repo. Ojo: `main` recibe commits automáticos de los
   workflows (`[skip ci]`), así que haz `git pull --rebase` antes de subir.
5. **Mensajes de commit en español**, describiendo el efecto:
   `Entorno en Vinetas: laminas a pedido desde el chat, no por horario`.

Nunca commitees `.env`, `entorno/out/`, `al-cierre/data.json` ni
`al-cierre/overrides.json` (ya están en los `.gitignore`).

## Estado

En producción y funcionando. Repo privado. Pendientes en la sección final de
[CLAUDE.md](CLAUDE.md).
