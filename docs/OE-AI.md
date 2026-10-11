# OE AI — Plataforma multimodelo de OE BUSINESS

OE AI es el producto de inteligencia artificial de OE BUSINESS. **OE AI LLM** es su capa
central de orquestación: selecciona y llama a modelos adecuados a través de proveedores
compatibles, normaliza las respuestas y las devuelve a la interfaz. **OE AI LLM no es un
modelo fundacional propio**: coordina modelos de terceros. Si en el futuro OE BUSINESS
incorpora modelos propios, aparecerán diferenciados de los externos en el catálogo.

## Instalación y ejecución local

```bash
bun install
cp .env.example .env      # rellena solo lo que uses; nunca commitear valores reales
bun run db:push           # sincroniza el esquema Prisma (SQLite)
bun run dev               # servidor de desarrollo en el puerto 3000
bun run lint              # comprobación de calidad
```

## Arquitectura

| Componente | Ubicación | Función |
|---|---|---|
| Catálogo fuente | `src/lib/ai/catalog/models.data.ts` | 128 IDs exactos del material fuente (deduplicados, versionados) |
| Derivación de catálogo | `src/lib/ai/catalog/catalog.ts` | Familias, categorías orientativas y notas de revisión |
| Adaptadores | `src/lib/ai/providers/` | `zai.ts` (real, verificado) y `openai-compatible.ts` (genérico) |
| Enrutador | `src/lib/ai/router.ts` | Selección manual/automática por tarea + fallback informado |
| Uso | `src/lib/ai/usage.ts` | Métricas sin contenido de prompts/respuestas |
| Salud | `src/lib/ai/health.ts` | Comprobaciones reales que alimentan los estados |
| Límites | `src/lib/ai/ratelimit.ts` + `config.ts` | Rate limiting por IP, límites diarios y por minuto |
| Vistas públicas | `src/lib/ai/models-view.ts` | Estados y contadores dinámicos de `/apis` |

## Configuración de proveedores

1. Añade la clave del proveedor en el servidor (p. ej. `GROQ_API_KEY`). Nada en el
   cliente ve ese valor; los endpoints públicos solo exponen **nombres** de variables.
2. Declara qué modelos puede servir mediante `OE_AI_MODEL_ROUTES`, por ejemplo:
   `OE_AI_MODEL_ROUTES=groq:meta-llama/Llama-3.1-8B-Instruct`
   (opcionalmente `groq:meta-llama/Llama-3.1-8B-Instruct>llama-3.1-8b-instant:fast`
   si el proveedor usa un identificador interno distinto).
3. El modelo pasa a **“Disponible con configuración”**.
4. Ejecuta una comprobación real desde el panel (pestaña *Estado* → *Panel de
   administración* → *Probar conexión*). Solo si la comprobación es exitosa el modelo
   pasa a **“Conectado”**.

### Proveedor z-ai (conectado en este entorno)

Verificado con pruebas reales: el SDK responde correctamente, pero **no permite
seleccionar modelos concretos** (ignora el parámetro `model`; el campo `model` de la
respuesta informa el modelo predeterminado del proveedor, p. ej. `glm-4-plus`). Por
honestidad, los modelos `zai-org/*` del catálogo permanecen **“No verificados”**
individualmente y el chat usa la entrada virtual *“modelo predeterminado del proveedor”*.
El streaming no está verificado de forma estable y no se anuncia.

## Cómo interpretar los estados del catálogo

| Estado | Significado |
|---|---|
| **Conectado** | Ruta configurada y última comprobación real superada |
| **Disponible con configuración** | Adaptador listo; faltan credenciales o la primera comprobación |
| **No verificado** | En catálogo, sin ruta configurada (estado inicial de los 128) |
| **Temporalmente no disponible** | Ruta configurada cuya última comprobación falló |
| **En planificación** | Sin endpoint/adaptador completado aún (p. ej. API pública sin clave) |
| **Revisión necesaria** | Posible ID inexistente, mal escrito o retirado (ver nota) |

Los contadores de `/apis` se calculan siempre desde el registro real y las
comprobaciones; un cero significa que aún no hay comprobación superada.

## Cómo añadir modelos nuevos

1. Añade el ID **exacto** a la lista de `scripts/gen-catalog.ts` y re-ejecuta
   `bun scripts/gen-catalog.ts` (valida duplicados y emite el archivo de datos).
2. Si un ID resultara inexistente o cambiara, NO lo borres: añade una entrada en
   `CATALOG_REVIEW_NOTES` (`src/lib/ai/catalog/catalog.ts`) y quedará marcado como
   *“Revisión necesaria”*.
3. Habilita su ruta con `OE_AI_MODEL_ROUTES` y verifica con el panel.

## API pública (/api/v1)

`POST /api/v1/chat/completions` — implementada de verdad (no es una maqueta):

- Activación: define `OE_AI_API_KEY` en el servidor; sin ella responde **503**
  `api_not_enabled`. El catálogo de `/apis` funciona de forma informativa con
  independencia de la API.
- Autenticación: `Authorization: Bearer <OE_AI_API_KEY>`.
- Límites: rate limit por minuto (`AI_API_RPM`) y límite diario global
  (`AI_MAX_DAILY_REQUESTS`), más cabecera `X-Request-Id` para soporte.
- Solo `stream: false` (el streaming no está verificado; devuelve 400
  `streaming_not_supported`).
- Errores consistentes: 400 validación · 401 clave · 404 modelo/ruta no configurada ·
  429 límites · 502 fallo del proveedor (sin respuesta simulada) · 503 no habilitado.

Ejemplo:

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer $OE_AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hola"}],"stream":false}'
```

## Seguridad y privacidad

- Todas las llamadas a proveedores ocurren en el servidor (`src/lib/ai/providers`).
- No se registra el contenido de prompts/respuestas en logs ni métricas (solo
  metadatos: proveedor, latencia, tamaños, tipo de error).
- Comparación de tokens admin/API en tiempo constante; el panel responde 503 sin
  `OE_AI_ADMIN_TOKEN`.
- Rate limiting en memoria (limitación documentada: válido para una instancia).
- Sesiones de chat anónimas identificadas por UUID del cliente; cualquiera con el
  UUID puede leer esa conversación (equivalente a un enlace compartible).
- Sin promesas de cifrado de extremo a extremo: la UI lo advierte explícitamente.

## Verificación y pruebas

El proyecto no incluye suites de tests automatizados en esta fase; se verificó con
lint, `tsc --noEmit` (sobre `src/`), sondas reales del SDK
(`scripts/probe-zai.ts`, `scripts/probe-stream.ts`) y pruebas end-to-end en navegador
(chat, catálogo, filtros, panel). Para validar una integración:

```bash
# 1) Catálogo y estados
curl -s http://localhost:3000/api/models | head -c 400
# 2) Chat (SSE)
curl -N -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"sessionId":"<uuid>","message":"Responde: PONG","model":"auto"}'
# 3) Comprobación admin (requiere OE_AI_ADMIN_TOKEN)
curl -X POST http://localhost:3000/api/admin/test \
  -H "x-admin-token: $OE_AI_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"providerId":"zai-org"}'
```

## Limitaciones conocidas

- Los 128 modelos están **catalogados pero no verificados** salvo verificación
  explícita por proveedor; el material fuente no incluye la relación modelo→proveedor,
  por lo que ninguna disponibilidad se asume.
- El adaptador z-ai disponible no permite selección de modelo ni streaming estable.
- Rate limiting y caché en memoria: para múltiples instancias se requiere una capa
  externa (fuera del alcance actual).
- Los endpoints `baseten`, `nscale` y `publicai` están sin URL base confirmada
  (“En planificación”).
- Sin sistema de cuentas: la API pública usa una clave de entorno; un panel de claves
  autoservicio con hashes queda **Planificado**.
