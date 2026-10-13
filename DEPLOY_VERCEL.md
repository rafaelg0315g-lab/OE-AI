# 🚀 Desplegar OE AI en Vercel (con la IA funcionando)

Guía completa para subir el proyecto a Vercel **sin perder las capacidades de IA**:
chat, visión, generación y edición de imágenes, video, TTS, ASR, búsqueda web y el
Constructor de Apps.

---

## 1) Por qué se caía la IA al desplegar (diagnóstico)

| Pieza | En el sandbox | En Vercel (antes) | Ahora |
|---|---|---|---|
| **Base de datos** | SQLite local | ❌ filesystem de solo lectura → **todo 500** (chats, cuota, imágenes) | ✅ **Supabase Postgres** (pooler IPv4) — ya migrado |
| **Chat (núcleo z-ai)** | ✅ SDK del entorno | ❌ el SDK no tiene credenciales fuera del sandbox | ✅ cascada: z-ai → **Gemini directo** → **OpenRouter** |
| **Chat con imagen (visión)** | ✅ z-ai | ❌ sin respaldo | ✅ respaldo **Gemini (multimodal)** |
| **Imágenes** | ✅ z-ai | ❌ sin respaldo | ✅ cascada: z-ai → **Gemini** → **OpenRouter** → **Pollinations** (gratis, sin clave) |
| **Edición de imágenes** | ✅ z-ai | ❌ sin respaldo | ✅ cascada: z-ai → **Gemini** → **OpenRouter** |
| **Video** | ✅ JSON2Video | ✅ (API externa con clave) | ✅ igual (JSON2Video es primario) |
| **TTS (voz)** | ✅ ElevenLabs | ✅ (API externa) | ✅ igual |
| **ASR (voz→texto)** | ✅ z-ai | ❌ | ✅ respaldo **Gemini audio** |
| **Búsqueda web** | ✅ z-ai | ❌ (se respondía sin fuentes) | ✅ respaldo **Gemini grounding** (google_search) |
| **Constructor de Apps** | ✅ Gemini/Groq/z-ai/OpenRouter | ✅ (ya era cascada con claves por env) | ✅ igual |
| **Modo voz en vivo (WebSocket :3010)** | ✅ servicio aparte | ❌ Vercel no aloja procesos largos | ⚠️ no disponible en Vercel (ver §7) |
| **Bot de Telegram (:3005)** | ✅ servicio aparte | ❌ | ⚠️ requiere otro host (ver §7) |

> **Regla de oro**: el SDK `z-ai-web-dev-sdk` SOLO funciona en este sandbox. Todo lo
> demás son APIs con clave que funcionan en cualquier servidor. Por eso el código
> ahora usa **cascadas**: primero el núcleo del entorno y, si falla, proveedores
> portables con tus claves.

---

## 2) Lo que YA está hecho en el código (no tienes que repetirlo)

- ✅ `prisma/schema.prisma` migrado a **PostgreSQL** (`provider = "postgresql"`).
- ✅ Base creada en tu Supabase (`prisma db push` contra el pooler `aws-0-us-east-1`).
- ✅ Cascadas de respaldo en: `/api/chat` (texto + visión + búsqueda web),
  `/api/tools/image`, `/api/tools/image-edit`, `/api/tools/asr`.
- ✅ `postinstall: prisma generate` (Vercel compila el cliente Prisma solo).
- ✅ Script `build` compatible con Vercel (el `cp` de standalone solo corre fuera de Vercel).
- ✅ `.env` y `db/*.db` **fuera de git** (verifica que `.env` no esté en GitHub).
- ✅ `.env.example` con TODAS las variables documentadas.

---

## 3) Subir el código a GitHub (SIN filtrar secretos)

```bash
cd /home/z/my-project
git status                 # .env y db/custom.db NO deben aparecer
git add -A
git commit -m "OE AI: listo para Vercel (Postgres + cascadas de IA)"
git remote add origin https://github.com/<TU_USUARIO>/<TU_REPO>.git   # si no existe
git push -u origin main
```

> ⚠️ **ANTES de pushear**, mira el historial: si `.env` se comprometió alguna vez,
> **rota TODAS las claves** (Supabase password, OpenRouter, Gemini, ElevenLabs,
> JSON2Video) y considera `git filter-repo`. Con el nuevo `.gitignore` ya no volverá a pasar.

---

## 4) Importar en Vercel

1. **vercel.com → Add New → Project** → importa tu repo de GitHub.
2. Framework preset: **Next.js** (detectado automáticamente). NO toques build settings.
3. **Environment Variables** → añade TODO lo de `.env.example` (ver §5).
4. Deploy. En el primer deploy Prisma genera el cliente (`postinstall`) y la app
   conecta a Supabase Postgres con `DATABASE_URL`.

---

## 5) Variables de entorno EXACTAS para Vercel

Cópialas de tu `.env` local (mismos valores). Resumen:

| Variable | Nota |
|---|---|
| `DATABASE_URL` | ⚠️ Debe ser el **pooler**: `postgresql://postgres.xrtzzdfgyhfepqbaqskl:<PASS>@aws-0-us-east-1.pooler.supabase.com:5432/postgres` — NO el host `db.…supabase.co` (es IPv6-only y Vercel no lo alcanza) |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xrtzzdfgyhfepqbaqskl.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | del dashboard de Supabase |
| `OPENROUTER_API_KEY` | tu clave `sk-or-v1-…` |
| `OE_AI_MODEL_ROUTES` | copia el valor EXACTO del `.env` local (las 42 rutas) |
| `GEMINI_API_KEY` | clave de AI Studio (respaldo chat/visión/imagen/búsqueda/ASR) |
| `GEMINI_BUILD_MODEL` | `gemini-3.1-pro-preview` |
| `GROQ_API_KEY` + `GROQ_BUILD_MODEL` | opcional (Constructor) |
| `ELEVENLABS_API_KEY` (+ `…_FALLBACK`, `_VOICE_ID`, `_MODEL_ID`) | TTS |
| `JSON2VIDEO_API_KEY` (+ `_TEMPLATE_ID`, `_VOICE`) | video |
| `OE_AI_API_KEY` / `OE_AI_ADMIN_TOKEN` | API pública / panel admin |

> 💡 En Vercel el plan Hobby limita cada función a **60 s**: chat e imágenes caben de
> sobra. El video usa JSON2Video en modo asíncrono (submit + polling), no afectado.

---

## 6) Supabase Auth: permitir tu dominio de Vercel (OBLIGATORIO para login)

Sin este paso el login con Google/GitHub te devuelve error al regresar:

1. **Supabase Dashboard → Authentication → URL Configuration**
2. **Site URL**: `https://<TU-PROYECTO>.vercel.app` (el que asigna Vercel; si usas
   dominio propio, ponlo cuando lo conectes).
3. **Redirect URLs** → añade:
   - `https://<TU-PROYECTO>.vercel.app/**`
   - conserva también la del sandbox si seguirás probando ahí.

> El flujo OAuth ya usa `redirectTo: origin + '/'`, así que con esas URLs el
> registro con Google y GitHub funciona igual que en local.

---

## 7) Limitaciones conocidas en Vercel (honestidad total)

1. **Modo voz en tiempo real** (WebSocket de `oe-voice-ws` en :3010): Vercel no
   aloja procesos persistentes. Opciones:
   - Dejarlo solo en la versión sandbox, o
   - hospedar ese mini-servicio en **Railway / Fly.io / un VPS** y apuntar el
     frontend a esa URL.
2. **Bot de Telegram** (`oe-telegram-bot` en :3005): mismo caso — necesita host
   propio (Railway/VPS) con `pm2`.
3. **Gemini free tier**: se agota por minuto/día (429). Cuando pase, la cascada
   salta automáticamente a OpenRouter/Pollinations — el usuario no nota el fallo.
   Si quieres más cuota: habilita facturación en el proyecto Google o sube de plan
   en OpenRouter.
4. **Cuota de invitados y rate limits por instancia**: funcionan (ahora en
   Postgres), pero el límite por minuto es en memoria por instancia de Vercel;
   es orientativo, no global estricto.
5. **`z-ai-web-dev-sdk`** sigue en `package.json`: es el núcleo del sandbox. En
   Vercel sus llamadas fallan rápido y la cascada continúa (verás en logs
   `route_fallback` / `generada con respaldo …`). No lo elimines si quieres que el
   sandbox siga igual de rápido.

---

## 8) Checklist post-deploy (2 minutos)

1. Abre `https://<tu-proyecto>.vercel.app` → manda un mensaje al chat → **responde**.
2. Recarga la página (F5) → el historial sigue (persistencia en Postgres ✓).
3. Genera una imagen → aparece (z-ai fallará → Gemini/OpenRouter/Pollinations ✓).
4. Login con Google o GitHub → el redirección regresa a tu dominio ✓.
5. Genera un video → JSON2Video entrega la URL ✓.
6. Revisa **Vercel → Functions → Logs** ante cualquier raro: busca
   `[api/chat]`, `route_fallback`, `respaldo`.

---

## 9) Comandos útiles

```bash
bun run lint          # calidad de código
bun run db:push       # sincroniza el schema con Supabase Postgres
bunx prisma studio    # inspeccionar la base en la nube
```
