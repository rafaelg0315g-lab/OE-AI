# OE AI — Modelo unificado de OE BUSINESS

Interfaz premium de chat con **OE AI LLM**, el modelo unificado de OE BUSINESS: una capa de
orquestación que coordina una **red de 128 modelos** de distintas familias y proveedores,
enruta cada solicitud y devuelve una respuesta normalizada como un solo modelo.

> OE AI LLM no es un modelo fundacional propio: es la red, el enrutador y las políticas
> (límites, trazabilidad, fallback) funcionando como un único modelo. **OE AI LLM está listo.**

---

## Novedades: proveedor OpenRouter conectado (real)

Con la clave `OPENROUTER_API_KEY` configurada en el servidor:

- **42 de los 128 IDs del catálogo están servibles en vivo** vía OpenRouter
  (8 coincidencias exactas + 34 que OpenRouter resuelve por mayúsculas/minúsculas).
- **Streaming SSE real verificado** con pruebas (deltas token a token + `[DONE]`):
  el chat y la API pública v1 transmiten en tiempo real cuando la ruta resuelta es OpenRouter.
- **Estados honestos**: solo los modelos con comprobación real superada se muestran
  «Conectado» (p. ej. `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `microsoft/phi-4`,
  `meta-llama/Llama-3.1-8B-Instruct`, verificados con latencias 836–3661 ms);
  el resto de la red aparece como miembro de OE AI LLM y sale por el núcleo activo.
- Modo **Automático**: prioriza rutas con comprobación real superada; si no hay,
  usa el núcleo activo. Selección manual de modelo: se respeta siempre.
- Diálogo **Conexiones**: píldoras de modelos servibles con acción «Usar en el chat»,
  badge de contaje en vivo y leyenda de estados (Conectado / Servible / Miembro).

---

## Qué incluye

### Interfaz de chat premium (`/`)
- Logo oficial de OE (placa oscura con «O» titanio y barras «E») en sidebar, topbar, bienvenida,
  `/apis` y favicon (`/oe-logo.svg`).
- Shell estilo GPT/Meta AI: sidebar colapsable con **Nuevo chat** (Ctrl+Shift+O),
  **Buscar** (Ctrl+K), **Conexiones** y **Historial** multi-conversación persistente (SQLite)
  con **renombrar**, **exportar (.md)** y eliminar por conversación.
- Pantalla de bienvenida animada: saludo con texto aurora, composer centrado y chips de sugerencia
  (incluye generación de imágenes y búsqueda web).
- Composer premium: entrada auto-expandible, botón «+» con acciones rápidas, selector de modo
  **Instantáneo / Reflexivo**, **dictado por voz** (Web Speech API), **búsqueda web** y envío con degradado.
- Herramientas del núcleo:
  - `/imagen <descripción>` o el botón «+»: **generación de imágenes** reales, guardadas y
    re-visibles desde el historial, con descarga, copia de prompt y «volver a generar».
  - `/buscar <consulta>` o el globo: **búsqueda web real** antes de responder, con bloque de
    **fuentes citadas** (enlaces numerados), badge «Búsqueda web» y aviso honesto si no hubo fuentes.
  - **Leer en voz alta** (experimental): botón «Escuchar» en cada respuesta (TTS del proveedor).
- Edición de mensajes: **Editar** en cualquier burbuja propia recorta la rama posterior (servidor
  y cliente) y reenvía el texto corregido.
- Sugerencias de seguimiento tras cada respuesta y botón flotante **ir al final**.
- Respuestas con **revelación progresiva** (máquina de escribir adaptativa), render **markdown**
  (tablas, citas y bloques de código con copia), badges de ruta (`OE AI LLM · Núcleo`),
  latencia, **Copiar** y **Regenerar**, botón **Detener** y reintento honesto ante errores.
- Diálogo de **Conexiones**: diagrama radial animado del núcleo OE AI LLM conectado a las
  26 familias, búsqueda en la red y píldoras por modelo con copia rápida del ID exacto.
- Animaciones Framer Motion (sidebar, mensajes, diálogos), soporte `prefers-reduced-motion`
  y diseño responsive completo (drawer móvil, targets táctiles ≥ 44 px).

### Centro de APIs (`/apis`)
- Hero con el estado del modelo unificado y contadores calculados del registro real
  (128 modelos · 26 familias · proveedores configurados).
- Catálogo consultable: búsqueda con debounce, filtros por familia/categoría, ordenación,
  tabla con cabecera fija en escritorio y tarjetas en móvil.
- Panel de detalles por modelo (ID exacto, familia, categorías orientativas, notas).
- Diagrama del flujo OE AI LLM y documentación para desarrolladores (endpoints operativos y
  planificados claramente etiquetados).

### Núcleo de orquestación (`src/lib/ai/`)
| Módulo | Rol |
| --- | --- |
| `catalog/` | Fuente versionada con los **128 IDs exactos** (dedupe, familias, categorías orientativas) |
| `providers/` | Adaptadores `AIProviderAdapter`: z-ai real (verificado) + OpenRouter real (chat y streaming verificados) + OpenAI-compatible genérico |
| `router.ts` | Model Router: selección automática/manual, fallback informado |
| `usage.ts` | Registro de uso con metadatos (nunca contenido de prompts/respuestas) |
| `ratelimit.ts` | Límite por IP (ventana deslizante en memoria) + límite diario global |
| `health.ts` | Comprobaciones reales de conectividad (`ProviderCheck`) |
| `models-view.ts` | Vistas públicas: red de modelos, contadores y detalles |

### API
| Endpoint | Estado | Descripción |
| --- | --- | --- |
| `POST /api/chat` | Operativo | Chat SSE (`meta` → `stage/search` → `delta` → `done` \| `error`), modo `instant/reflective`, `webSearch` |
| `POST /api/tools/image` | Operativo | Generación de imágenes (persistidas en `GeneratedAsset`) |
| `GET /api/assets/[id]` | Operativo | Sirve el binario de una imagen generada |
| `POST /api/tools/tts` | Operativo | Lectura en voz alta (WAV, máx. ~950 caracteres) |
| `GET /api/chat/history?sessionId=` | Operativo | Mensajes de una conversación (texto, imágenes y fuentes) |
| `GET /api/chat/sessions` | Operativo | Historial para el sidebar |
| `PATCH /api/chat/sessions/[id]` | Operativo | Renombrar conversación |
| `DELETE /api/chat/sessions/[id]` | Operativo | Eliminar conversación |
| `POST /api/chat/trim` | Operativo | Recorte de rama al editar un mensaje |
| `GET /api/models` · `GET /api/models/[id]` | Operativo | Catálogo de la red y detalle |
| `GET /api/providers` | Operativo | Rutas servibles |
| `POST /api/v1/chat/completions` | Operativo | API pública (requiere `OE_AI_API_KEY`; 503 si no está habilitada; admite `"stream": true` con proveedores verificados) |
| `GET /api/admin/overview` · `POST /api/admin/test` | Operativo | Administración (cabecera `X-Admin-Token`) |

## Seguridad
- Las llamadas a proveedores ocurren **solo en el servidor**; las claves nunca llegan al cliente.
- Sin contenido de prompts/respuestas en logs técnicos; trazabilidad por metadatos e IDs.
- Validación con Zod, límites por IP y por día, mensajes de error seguros (sin cuerpos del proveedor).

## Puesta en marcha
```bash
bun install
cp .env.example .env   # solo nombres; rellena valores en el servidor
bun run db:push
bun run dev            # http://localhost:3000
```

## Stack
Next.js 16 (App Router) · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · Prisma (SQLite) ·
Framer Motion · z-ai-web-dev-sdk · Zustand.
