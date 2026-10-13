import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'
import { buildErrorMessage, normalizeMode, runBuild, runBuildUpdate } from '@/lib/build/pipeline'
import { languageFromPath } from '@/lib/build/types'
import { runWebFactory, WebFactoryError } from '@/lib/web-factory/pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BuildStreamSchema = z.object({
  sessionId: z.string().uuid(),
  brief: z.string().min(5).max(6000),
  kind: z.enum(['app', 'web']).default('app'),
  mode: z.enum(['fullstack', 'frontend']).optional(),
  projectId: z.string().regex(/^[a-z0-9_-]{6,45}$/i).optional(),
})

/**
 * POST /api/tools/build-stream — constructor de apps/sitios EN VIVO (SSE).
 * Mismo pipeline y misma persistencia que /api/tools/build-app y
 * /api/web-factory/generate, pero cada archivo se emite (y persiste) en cuanto
 * está listo: el chat muestra las tareas, el código y las descargas al vuelo.
 *
 * Eventos SSE: meta, build_meta, todos, todo, note, file, done, error.
 * Política anti-desconexión: sin request.signal a propósito — si el cliente se
 * corta, el build continúa y /api/tools/build-app/status lo recupera.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'tools-build'), 4, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de construcciones alcanzado. Espera un momento e inténtalo de nuevo.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof BuildStreamSchema>
  try {
    body = BuildStreamSchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: sessionId (uuid), brief (5-6000) y kind (app|web) son obligatorios.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  // Identidad + cuota de invitado (mismo turno pesado que las rutas clásicas).
  let guestSetCookie: string | null = null
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} usos gratis de esta sesión. Inicia sesión con Google o GitHub para seguir construyendo sin límite.`,
            errorType: 'guest_limit_reached',
            used: quota.used,
            limit: quota.limit,
            requestId,
          },
          {
            status: 403,
            headers: {
              'X-Request-Id': requestId,
              ...(identity.isNewGuest ? { 'Set-Cookie': guestCookieHeader(identity.guestId) } : {}),
            },
          },
        )
      }
      if (identity.isNewGuest) guestSetCookie = guestCookieHeader(identity.guestId)
    }
  } catch (quotaErr) {
    console.error('[api/tools/build-stream] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
  }

  await db.chatSession.upsert({
    where: { id: body.sessionId },
    create: { id: body.sessionId, title: `App: ${body.brief.slice(0, 50)}` },
    update: { updatedAt: new Date() },
  })

  const isWeb = body.kind === 'web'
  const mode = normalizeMode(body.mode)

  // Proyecto a modificar (modo edición) o nuevo proyecto.
  let existing: { id: string; title: string; files: Array<{ path: string; content: string }> } | null = null
  if (body.projectId) {
    const project = await db.buildProject.findUnique({
      where: { id: body.projectId },
      select: { id: true, title: true, files: { select: { path: true, content: true } } },
    })
    if (!project) {
      return Response.json(
        { error: 'El proyecto a modificar no existe o fue eliminado. Pide uno nuevo.', requestId },
        { status: 404, headers: { 'X-Request-Id': requestId } },
      )
    }
    existing = { id: project.id, title: project.title, files: project.files.map((f) => ({ path: f.path, content: f.content })) }
  }

  const project = existing
    ? await db.buildProject.update({
        where: { id: existing.id },
        data: { status: 'building', errorType: null, prompt: body.brief.slice(0, 6000) },
      })
    : await db.buildProject.create({
        data: {
          id: crypto.randomUUID(),
          sessionId: body.sessionId,
          title: isWeb ? 'Construyendo sitio…' : 'Construyendo app…',
          prompt: body.brief.slice(0, 6000),
          mode: isWeb ? 'web' : mode,
          status: 'building',
          ...(isWeb ? { stack: 'HTML · CSS · JS · Web Factory' } : {}),
        },
      })

  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Request-Id': requestId,
    ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}),
  }

  const startedAt = Date.now()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // cliente desconectado: el build sigue (política anti-desconexión)
        }
      }

      const persistFile = async (path: string, content: string) => {
        await db.buildFile.upsert({
          where: { projectId_path: { projectId: project.id, path } },
          create: {
            projectId: project.id,
            path,
            content,
            language: languageFromPath(path),
            bytes: Buffer.byteLength(content, 'utf8'),
          },
          update: {
            content,
            language: languageFromPath(path),
            bytes: Buffer.byteLength(content, 'utf8'),
          },
        })
      }

      send('meta', {
        requestId,
        kind: body.kind,
        projectId: project.id,
        isUpdate: Boolean(existing),
        coreLabel: isWeb ? 'OE Web Factory' : 'OE Builder',
      })

      // Latido SSE: nota de progreso con segundos transcurridos cada 7 s para
      // que la conexión nunca quede en silencio durante las fases largas de
      // código (buffers intermedios) y el panel muestre tiempo real.
      // Declarado FUERA del try: si el cuerpo falla antes de crearse, el
      // finally no debe romperse con ReferenceError (ocurrió con un chunk
      // stale de Turbopack y convertía el fallo en un 500 sin eventos).
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const buildStartedAt = Date.now()

      try {
        heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - buildStartedAt) / 1000)
          send('note', { note: `Trabajando en tu ${body.kind === 'web' ? 'sitio' : 'app'}… (${elapsed} s)` })
        }, 7_000)

        const onProgress = (evt:
          | { type: 'title'; title: string; summary: string }
          | { type: 'todos'; items: Array<{ id: string; label: string; status: string }> }
          | { type: 'todo_update'; id: string; status: string }
          | { type: 'stage_note'; note: string }
          | { type: 'file_done'; path: string; language: string; bytes: number; content: string }) => {
          if (evt.type === 'title') send('build_meta', { title: evt.title, summary: evt.summary })
          else if (evt.type === 'todos') send('todos', { items: evt.items })
          else if (evt.type === 'todo_update') send('todo', { id: evt.id, status: evt.status })
          else if (evt.type === 'stage_note') send('note', { note: evt.note })
          else if (evt.type === 'file_done') {
            // Persistencia TEMPRANA: la descarga individual existe desde ya.
            void persistFile(evt.path, evt.content)
              .then(() => {
                send('file', {
                  path: evt.path,
                  language: evt.language,
                  bytes: evt.bytes,
                  content: evt.content,
                  url: `/api/tools/build-app/${project.id}/download?path=${encodeURIComponent(evt.path)}`,
                })
              })
              .catch((err) => console.error('[api/tools/build-stream] persistencia de archivo falló:', err instanceof Error ? err.message : err))
          }
        }

        if (isWeb) {
          const webResult = await runWebFactory({
            brief: body.brief,
            sessionId: body.sessionId,
            existingProjectId: existing?.id,
            onProgress,
          })
          await db.buildProject.update({
            where: { id: project.id },
            data: {
              title: webResult.title || 'Sitio Web Factory',
              status: 'ready',
              planJson: webResult.isUpdate ? undefined : webResult.planJson,
              designJson: webResult.isUpdate ? undefined : JSON.stringify(webResult.designSystem),
              provenanceJson: JSON.stringify({
                generatedBy: 'OE AI Web Factory',
                codeOwnership: 'Código escrito íntegramente por OE AI (sin copia de repos).',
                framework: webResult.framework,
                references: webResult.references,
                images: webResult.images,
              }),
              checksJson: JSON.stringify({ checks: webResult.checks, warnings: webResult.warnings }),
              summaryNote: webResult.summary.slice(0, 500) || null,
              stack: webResult.stack,
            },
            select: { id: true },
          })
          const finalFiles = await db.buildFile.findMany({
            where: { projectId: project.id },
            select: { path: true, language: true, bytes: true },
            orderBy: { path: 'asc' },
          })
          send('done', {
            id: project.id,
            title: webResult.title,
            summary: webResult.summary,
            kind: 'web',
            mode: 'web',
            status: 'ready',
            isUpdate: webResult.isUpdate,
            changedPaths: webResult.changedPaths,
            stack: webResult.stack,
            framework: webResult.framework,
            designSystem: webResult.designSystem,
            references: webResult.references,
            checks: webResult.checks,
            warnings: webResult.warnings,
            images: webResult.images,
            files: finalFiles.map((f) => ({
              ...f,
              url: `/api/tools/build-app/${project.id}/download?path=${encodeURIComponent(f.path)}`,
            })),
            zipUrl: `/api/tools/build-app/${project.id}/download`,
            ...(webResult.framework === 'html' ? { previewUrl: `/api/web-factory/preview/${project.id}/index.html` } : {}),
            latencyMs: Date.now() - startedAt,
          })
        } else {
          const appResult = existing
            ? await runBuildUpdate({ changeRequest: body.brief, currentFiles: existing.files, onProgress })
            : await runBuild({ brief: body.brief, mode, onProgress })
          for (const f of appResult.files) {
            await persistFile(f.path, f.content)
          }
          const finalFiles = await db.buildFile.findMany({
            where: { projectId: project.id },
            select: { path: true, language: true, bytes: true },
            orderBy: { path: 'asc' },
          })
          await db.buildProject.update({
            where: { id: project.id },
            data: {
              title: appResult.isUpdate ? existing?.title || 'App OE AI' : appResult.title || 'App OE AI',
              status: 'ready',
              planJson: appResult.isUpdate ? undefined : JSON.stringify(appResult.plan),
              summaryNote: appResult.summary.slice(0, 500) || null,
              stack: mode === 'fullstack' ? 'HTML · CSS · JS · Node.js' : 'HTML · CSS · JS',
            },
            select: { id: true },
          })
          send('done', {
            id: project.id,
            title: appResult.isUpdate ? existing?.title || 'App OE AI' : appResult.title,
            summary: appResult.summary,
            kind: 'app',
            mode,
            status: 'ready',
            isUpdate: appResult.isUpdate,
            changedPaths: appResult.changedPaths,
            stack: mode === 'fullstack' ? 'HTML · CSS · JS · Node.js' : 'HTML · CSS · JS',
            files: finalFiles.map((f) => ({
              ...f,
              url: `/api/tools/build-app/${project.id}/download?path=${encodeURIComponent(f.path)}`,
            })),
            zipUrl: `/api/tools/build-app/${project.id}/download`,
            latencyMs: Date.now() - startedAt,
          })
        }

        await recordUsage({
          requestId,
          source: 'chat',
          task: 'coding',
          status: 'ok',
          latencyMs: Date.now() - startedAt,
        })
      } catch (err) {
        const { message, errorType } =
          err instanceof WebFactoryError
            ? { message: err.message, errorType: err.errorType }
            : buildErrorMessage(err)
        console.error('[api/tools/build-stream] build falló:', message)
        await db.buildProject
          .update({ where: { id: project.id }, data: { status: 'error', errorType: errorType.slice(0, 60) } })
          .catch(() => undefined)
        await recordUsage({
          requestId,
          source: 'chat',
          task: 'coding',
          status: 'error',
          errorType,
          latencyMs: Date.now() - startedAt,
        })
        send('error', { message, errorType, projectId: project.id, requestId })
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // ya cerrado por desconexión
        }
      }
    },
  })

  return new Response(stream, { headers: sseHeaders })
}
