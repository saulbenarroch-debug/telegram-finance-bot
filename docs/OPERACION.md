# Operación (runbook)

Qué correr, qué revisar y qué hacer cuando algo falla.

## Producción de un vistazo

| Qué | Cuándo | Quién lo dispara |
|---|---|---|
| Resumen matutino | 10:00 VET | cron-job.org → `news.yml` |
| Resumen vespertino | 16:00 VET | cron-job.org → `news.yml` |
| Alertas de alto impacto | cada hora | cron-job.org → `breaking.yml` |
| Al Cierre | 5:30 pm VET | cron-job.org → `al-cierre.yml` |
| Ingesta de noticias y tasas | cada 3 h | cron del Worker |
| Prearmar newsletter | viernes 8:00 a.m. VET | cron del Worker (**no envía**) |
| Láminas del newsletter | a pedido | el bot, cuando alguien escribe `/entorno` |

VET = UTC-4, sin horario de verano.

## Desplegar

### El bot conversacional (Worker)

Cada vez que edites `cloudflare-worker/worker.js`:

```bash
python scripts/deploy_worker.py
```

Es idempotente: crea el KV y el `WEBHOOK_SECRET` solo la primera vez, sube el
script con los secretos como bindings, activa la URL, configura los crons y hace
`setWebhook` con el secret token.

**Espera 10-20 segundos antes de probar.** Si pruebas de inmediato te responde la
versión anterior y vas a creer que tu cambio no funcionó.

Verificar que quedó vivo:

```bash
curl https://sureconomics-bot.sureconomics.workers.dev
```

Debe responder `Sureconomics bot activo ✅`.

### Lo que corre en Actions

Se despliega con hacer merge a `main`. No hay build.

## Disparar cosas a mano

Desde la pestaña **Actions** del repo → el workflow → "Run workflow":

- **Noticias financieras** — manda el resumen ya.
- **Alertas de alto impacto** — chequea ahora.
- **Al Cierre** — con `force: true` si ya se envió hoy.
- **Entorno en Viñetas** — con `chat` vacío van a todos los de `CHAT_ID`; con un
  chat id van solo a ese.

Desde Telegram: `/entorno` (texto al instante + láminas después). Agrégale
"forzar", "de nuevo", "refrescar" o "actualizar" para ignorar la caché de 6 h.

Endpoints de depuración (necesitas `WEBHOOK_SECRET`):

```bash
curl "https://sureconomics-bot.sureconomics.workers.dev/entorno?key=SECRET&datos=1"
```

Devuelve solo las cifras en JSON — la forma más rápida de ver si una fuente de
datos se cayó, sin gastar cuota de IA.

## Agregar o quitar un destinatario

1. La persona le escribe cualquier cosa al bot y luego `/id`. El bot le devuelve
   su chat id.
2. Agregar ese id al secret **`CHAT_ID`** del repo, separado por coma:
   `123456,789012`.
3. Agregarlo también al `.env` local si quieres que los envíos manuales le
   lleguen.

`get_chat_id.py` **no sirve** para esto: con el webhook activo, `getUpdates`
queda vacío.

El chat conversacional responde a cualquiera que le escriba, sin restricción.
Solo la difusión programada usa `CHAT_ID`.

## Cuando algo falla

### No llegó el resumen a su hora

1. **Actions → Noticias financieras.** ¿Hay una corrida a esa hora?
   - **No hay corrida** → el problema es el reloj: revisa el job en
     cron-job.org (historial de ejecuciones) y que su PAT no haya vencido.
   - **Corrida en rojo** → abre el log del paso "Enviar resumen a Telegram".
2. **Corrida en verde pero no llegó** → problema de destinatario. Busca en el log
   `[warn] fallo enviar a <chat_id>`: probablemente alguien bloqueó al bot.

### Llegó sin resumen de IA, solo titulares

Funcionó la degradación suave: se agotó la cuota de IA. En el log verás
`[warn] no se pudo generar el resumen IA`.

- Si es esporádico, no hay nada que hacer: se recupera al día siguiente.
- Si es constante, revisa que `GROQ_API_KEY` esté configurada (es el respaldo
  cross-provider). Si tampoco alcanza, hay que agregar otro proveedor.
- **No cambies a un modelo `gemini-2.0-*`**: en este proyecto tienen límite 0.

### El bot no responde en el chat

1. `curl https://sureconomics-bot.sureconomics.workers.dev` → ¿responde el ✅?
2. Revisa que el webhook siga apuntando bien:
   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo"
   ```
   Debe apuntar a la URL del Worker. Si no, corre `deploy_worker.py`.
3. Logs en vivo: panel de Cloudflare → Workers → `sureconomics-bot` → Logs.
4. Si responde "Disculpa, tuve un problema procesando tu mensaje", el error está
   dentro de `handleUpdate`: mira los logs del Worker.

### El newsletter llegó en texto pero sin láminas

Es el modo degradado esperado. El bot avisa "no pude disparar el render de las
láminas". Causas, en orden de probabilidad:

1. **`GITHUB_PAT` vencido** (vence ~28 de julio de 2027). Regenéralo
   fine-grained con Actions read/write sobre `telegram-finance-bot`, ponlo en
   `.env` y corre `deploy_worker.py`.
2. **`entorno.yml` falló.** Mira la corrida en Actions; las láminas quedan
   guardadas como artefacto 30 días, útil para ver qué se generó.

### Las cifras del newsletter salen mal o vacías

```bash
curl "https://sureconomics-bot.sureconomics.workers.dev/entorno?key=SECRET&datos=1"
```

Compara contra la realidad. Si falta el IBC, probablemente cambió el formato del
slug en bolsadecaracas.com (se lee de `cerro-en-X-puntos-23jul`). Si falta la
variación semanal, el histórico en KV está vacío: espera a que el cron de 3 h lo
llene, o llámalo a mano con `/ingest?key=SECRET`.

### Se envió Al Cierre dos veces (o ninguna)

La guarda es `al-cierre/last_sent.txt`, que solo se estampa si el envío fue
exitoso (por eso un fallo permite reintentar). Para forzar un reenvío legítimo:
Actions → Al Cierre → Run workflow con `force: true`.

### Alertas repetidas

`breaking_state.json` guarda los enlaces ya avisados y el workflow lo commitea de
vuelta. Si el paso de guardar falla (tiene `continue-on-error`), la próxima
corrida puede repetir una alerta. Revisa que el commit se esté haciendo.

## Rotar un secreto

Si un token se expone: **revócalo primero**, genera el nuevo, y actualízalo en
los tres lugares que apliquen — `.env` local, GitHub Secrets, y bindings del
Worker (corriendo `deploy_worker.py`).

El token de Telegram se revoca con `/revoke` en @BotFather. Ya pasó una vez
(junio 2026): el token quedó expuesto en un chat, se revocó y se rotó.

⚠️ Al escribir `.env` en Windows, **nunca uses
`Set-Content -Encoding utf8`** (PowerShell 5.1): mete BOM y `python-dotenv` deja
de leer la primera clave. Usa:

```powershell
[System.IO.File]::WriteAllText("$PWD\.env", $contenido, (New-Object System.Text.UTF8Encoding($false)))
```

## Mantenimiento en el calendario

| Cuándo | Qué |
|---|---|
| Cada mes | Actualizar el IPC con `/ipc 13,8 129,8 junio 2026` cuando el BCV lo publique |
| Cada enero | Actualizar las bases anuales (constante `BASES` en `worker.js` o KV `entorno:bases`) |
| ~28 jul 2027 | **Renovar `GITHUB_PAT`** |
| Revisar | Vencimiento del PAT que usa cron-job.org |
