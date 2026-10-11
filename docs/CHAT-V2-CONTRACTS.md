# CONTRATO — Upgrade del chat OE AI (Writing Blocks · Canvas · Generative UI · Archivos · Imágenes)

Marco de integración acordado para los Task ID **11-a (backend)** y **11-b (frontend)**.
Ambos agentes DEBEN respetar este contrato al pie de la letra. El archivo compartido
`src/lib/chat/blocks.ts` YA EXISTE (tipos + zod + helpers) — no reescribirlo, solo importarlo.

## Principios innegociables
- TODO REAL, nada simulado: las imágenes se generan de verdad (z-ai SDK), los archivos se
  crean de verdad (bytes en DB, descargables), los documentos se persisten de verdad.
- Si una acción falla, el bloque es `{ type: 'error', source, message }` con el mensaje real.
- Sin secretos en el cliente. Sin emojis en la UI. Español (es) en todos los textos.
- Prohibido `any`. Lint limpio (`bun run lint`).

## 1. Protocolo de directivas (el modelo las emite como vallas)
```
```genui
{"type":"metrics","items":[{"label":"Usuarios","value":"1.2k"}]}
```
```imagen
{"prompt":"descripción rica de la imagen","size":"1024x1024"}
```
```documento
{"title":"Carta al cliente","kind":"writing","content":"# ...markdown completo..."}
```
```archivo
{"filename":"informe","format":"pdf","content":"...texto/markdown..."}
```
```
- `kind` de documento: `writing | code | content | table`.
- `format` de archivo: `txt | md | csv | json | pdf` (pdf genera PDF REAL con pdfkit).
- Las vallas de código normales (```js etc.) NO son directivas: pasan como markdown.

## 2. Flujo SSE de /api/chat (eventos, en orden)
- `meta` (igual que hoy) → `stage` → `search`/`search_error` (si webSearch)
- `delta` `{ text }` — SOLO texto plano visible (el contenido de las vallas de directiva
  se retiene con un state-machine; al cerrar la valla se ejecuta la acción real)
- `block` `{ block: ChatBlock }` — al completarse cada directiva (después de ejecutarla)
- `done` `{ messageId, latencyMs, ..., blocks: ChatBlock[] }` — incluye los bloques finales
- `error` (igual que hoy)
El `content` persistido del asistente lleva las directivas REEMPLAZADAS por marcadores
compactos: `[Documento: Título]`, `[Imagen: prompt]`, `[Archivo: name.ext]`; las vallas
`genui` se eliminan del texto. `blocksJson` guarda el array ChatBlock completo.

## 3. APIs nuevas (backend 11-a)
- `GET /api/documents/[id]` → `{ document: { id, title, kind, format, language, content, version, createdAt, updatedAt }, versions: [{ id, version, note, createdAt }] }`
- `PATCH /api/documents/[id]` body `{ content?, title? }` → guarda (versión nueva si cambia el contenido) → `{ document }`
- `POST /api/documents/[id]/edit` body `{ instruction }` → edición incremental con LLM:
  se envía SOLO el documento + la instrucción (nunca el historial del chat). Doc > 24000
  caracteres: enviar esquema (encabezados) + sección relevante. Crea versión con nota.
  → `{ document, note }`
- `POST /api/documents/[id]/restore` body `{ versionId }` → `{ document }`
- `GET /api/documents/[id]/export?format=md|txt|pdf` → descarga real (pdf con pdfkit)
- `GET /api/files/[id]` → binario real con `Content-Disposition: attachment`
- `GET /api/chat/history` → DEBE incluir `blocks` (parsear blocksJson con parseChatBlocks)
- Contexto LLM (`src/lib/chat/context.ts`): últimos 12 mensajes íntegros; anteriores
  truncados a 500 chars. Los documentos NUNCA se reenvían completos (solo marcadores).

## 4. Frontend (11-b) — integración
- `use-oe-chat.ts`: manejar evento `block` (append a mensaje actual), mapear `blocks` en
  history/done; exponer `openCanvas(documentId)` vía ui-store (`canvasDocumentId`, `canvasOpen`).
- `message-list.tsx`: renderizar markdown del texto + debajo los ChatBlock en orden
  (GenuiBlock, imagen inline con caption, WritingBlockCard, FileCard, error Alert).
- `oe-ai-app.tsx`: panel Canvas lateral (react-resizable-panels, ya instalado) con
  `canvas-panel.tsx`; móvil = pantalla completa (Sheet o overlay).
- `canvas-panel.tsx`: carga documento, editor (textarea; mono si kind=code), autoguardado
  con debounce (PATCH), input "Pedir cambio a OE AI" (POST edit), versiones (restore),
  Copiar, Exportar (md/txt/pdf), Cerrar. Estados de carga/guardado visibles.
- `markdown.tsx`: instalar `remark-gfm` (`bun add remark-gfm`) y estilizar tablas markdown
  (thead sticky no necesario; bordes sutiles, filas zebra, scroll horizontal en móvil).
- Componentes genui en `src/components/chat/genui/`: cards, metrics, timeline, checklist
  (interactiva con progreso), steps, compare (shadcn Table), quiz (interactivo: revela
  respuesta), chart (barras CSS con valores). Todos dark-theme, accesibles, sin emojis.
- Icono Lucide por nombre: mapear con `icons` de `lucide-react` (import dinámico seguro)
  o un mapa curado de ~24 iconos comunes; fallback `Info`.

## 5. Sistema prompt (backend 11-a) — cuándo usar cada bloque
- Pregunta sencilla → markdown puro (rápido y legible). NO envolver todo en bloques.
- Tablas → siempre markdown (se renderizan de verdad).
- Datos comparables/métricas/cronologías/planes → `genui` (máx. 2-3 por respuesta).
- Cartas, correos, propuestas, informes, prompts, posts, documentos editables →
  `documento` con contenido ÍNTEGRO en `content`; en el chat solo 1-2 frases de
  introducción (NUNCA duplicar el contenido fuera del bloque).
- Usuario pide archivo explícito o contenido muy extenso → `archivo` (formato adecuado).
- Usuario pide imagen o el tema se beneficia claramente → `imagen` con prompt rico.
- Siempre en español. JSON válido en cada valla (una sola línea permitida).

## 6. Reparto de archivos (DISJUNTO — no tocar los del otro)
- 11-a: `src/lib/chat/directives.ts`, `src/lib/chat/context.ts`, `src/lib/export/pdf.ts`,
  `src/lib/ai/tools/image-gen.ts` (extraer de api/tools/image), `src/app/api/chat/route.ts`,
  `src/app/api/chat/history/route.ts`, `src/app/api/documents/**`, `src/app/api/files/**`.
- 11-b: `src/components/chat/**`, `src/hooks/use-oe-chat.ts`, `src/lib/store/ui-store.ts`,
  `src/app/globals.css` (solo estilos de tablas/bloques), `bun add remark-gfm`.
- Compartido (solo lectura): `src/lib/chat/blocks.ts` (creado por el orquestador).
