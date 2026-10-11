# Bot de Telegram de OE AI (`oe-telegram-bot`)

Mini-servicio **sin dependencias externas** (solo Bun + `fetch` nativo) que convierte Telegram en una interfaz de chat de **OE AI**: cada mensaje que le escribas se responde llamando a la **API pública v1 del propio proyecto** (`POST http://127.0.0.1:3000/api/v1/chat/completions` con la clave `OE_AI_API_KEY`), igual que haría cualquier cliente estilo OpenAI.

- **Puerto del health-check:** `3005` (`GET /` → `{"ok":true,"bot":true,"username":"..."}`)
- **Chatea con la API v1** del proyecto (modelo `auto`, sin streaming).
- **Todo en español**, respuestas breves estilo Telegram, texto plano (sin markdown complejo).

---

## 1. Crear tu bot con @BotFather (2 minutos)

1. Abre Telegram y busca **@BotFather** (cuenta verificada con distintivo).
2. Envía `/newbot` y sigue los pasos:
   - **Nombre visible** del bot (p. ej. `OE AI`).
   - **Nombre de usuario** que debe terminar en `bot` (p. ej. `MiOEBot`).
3. BotFather te dará un **token** con esta forma:
   ```
   123456789:AAEjemploDeTokenNoCompartasEsto
   ```
   Cópialo **completo** (incluye los dos puntos).

> 💡 Más tarde podrás cambiar nombre, foto y descripción con `/setname`, `/setuserpic` y `/setdescription` en BotFather.

## 2. Guardar el token

**Opción recomendada** — crea el archivo `mini-services/telegram-bot/.env` con esta línea:

```
TELEGRAM_BOT_TOKEN=123456789:AA...
```

**Opción alternativa** — añade la misma línea al `.env` raíz del proyecto (`/home/z/my-project/.env`).

Precedencia: `mini-services/telegram-bot/.env` › variable de proceso › `.env` raíz.

⚠️ **Seguridad:** el token y las claves viven solo en archivos `.env` del servidor. No los subas a git ni los compartas.

## 3. Arrancar

```bash
cd mini-services/telegram-bot
bun run dev          # desarrollo con --hot (recarga al editar archivos)
# o sin recarga:
bun index.ts
# o en segundo plano:
nohup bun run dev > /tmp/oe-telegram-bot.log 2>&1 &
# o con pm2:
pm2 start --name oe-telegram-bot -- bun run dev
```

- Si **falta el token**, el bot **no crashea**: imprime instrucciones en la consola y queda en modo espera releyendo los `.env` cada 30 s. En cuanto crees el archivo `.env`, se conecta solo (con `bun --hot` basta con editar cualquier archivo).
- Comprueba que está vivo:
  ```bash
  curl http://localhost:3005/
  # {"ok":true,"bot":true,"username":"MiOEBot"}   ← con token
  # {"ok":true,"bot":false,"username":null}       ← sin token (sigue esperando)
  ```

## 4. Usarlo

Busca tu bot en Telegram (el nombre que le diste en BotFather) y escríbele:

| Comando  | Qué hace |
|----------|----------|
| `/start` | Mensaje de bienvenida. |
| `/reset` | Borra el historial de ese chat (empezamos de cero). |
| Texto    | Se envía a la API v1 de OE AI y responde en español. |

## 5. Cómo funciona por dentro

- **Health-check:** servidor HTTP mínimo en el puerto `3005` (`GET /`).
- **Recepción:** long-polling infinito a `getUpdates?timeout=25` con reintentos automáticos (fallo de red → espera 5 s; token inválido → 30 s; otro proceso consultando → 10 s). **Nunca crashea.**
- **Contexto:** historial en memoria por chat (`Map<chatId, mensajes[]>`), se envían los **últimos 12 mensajes** más un system prompt: *"Eres OE AI. Responde SIEMPRE en español, con mensajes breves de Telegram (máx ~150 palabras), sin markdown complejo."*
- **Respuestas:** `choices[0].message.content` de la API v1, enviadas **sin `parse_mode`** (texto plano); si superan 4000 caracteres se dividen en varios mensajes.
- **Rate-limit:** máximo **1 petición a la API v1 por chat cada 2 s**; si hay una en curso responde `Espera un momento…`.
- El historial vive en memoria: se pierde al reiniciar el proceso (no persiste nada).

## 6. Solución de problemas

| Síntoma | Causa y arreglo |
|---|---|
| Log repite «Sin TELEGRAM_BOT_TOKEN todavía…» | Aún no creaste `mini-services/telegram-bot/.env` (o el `.env` raíz no tiene la variable). Créalo; se detecta solo en ≤30 s. |
| `Telegram rechazó el token (401)` | Token copiado mal o revocado. Genera otro con `/token` en BotFather y actualiza el `.env`. |
| `Otro proceso ya está consultando getUpdates (409)` | Hay **dos** instancias del bot (u otro servicio) con el mismo token. Deja solo una (revisa `pm2 ls` / procesos `bun`). |
| El bot responde «no tiene configurada la clave…» | Falta `OE_AI_API_KEY` en el `.env` raíz, o el servidor principal (`http://127.0.0.1:3000`) no está arrancado. |
| El bot responde «API saturada» (429) | Límite de la API v1 (30 req/min) o del proveedor; espera unos segundos. |
| El puerto 3005 está ocupado | Otro proceso lo usa; el bot reintenta cada 5 s, o libera el puerto (`lsof -i :3005`). |
| No responde tras reiniciar el proyecto | El historial es en memoria; envía `/reset` o simplemente escribe de nuevo. |

## 7. Notas

- Solo lee archivos del propio mini-servicio y el `.env`; **no toca** ningún otro archivo del proyecto.
- Las claves (`TELEGRAM_BOT_TOKEN`, `OE_AI_API_KEY`) nunca salen del servidor: el bot habla con la API v1 por `127.0.0.1`.
