import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'
import { runBuild, runBuildUpdate, buildErrorMessage, normalizeMode } from '@/lib/build/pipeline'
import { languageFromPath } from '@/lib/build/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BuildBodySchema = z.object({
  sessionId: z.string().uuid(),
  brief: z.string().min(5).max(6000),
  mode: z.enum(['fullstack', 'frontend']).optional(),
  /** Proyecto existente a modificar (la directiva del modelo lo incluye). */
  projectId: z.string().regex(/^[a-z0-9_-]{6,45}$/i).optional(),
})

/**
 * POST /api/tools/build-app — constructor de apps del chat principal.
 * El asistente emite la directiva ```oe-build y el cliente llama aquí con el
 * brief; el pipeline (plan → código) produce archivos completos persistidos
 * en BuildProject/BuildFile, descargables desde las tarjetas del mensaje.
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

  let body: z.infer<typeof BuildBodySchema>
  try {
    body = BuildBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: sessionId (uuid) y brief (5-6000 caracteres) son obligatorios.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  // Identidad + cuota: construir una app es un turno pesado para invitados
  // (misma cuota de N usos gratis por sesión de navegador).
  let guestSetCookie: string | null = null
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} usos gratis de esta sesión. Inicia sesión con Google o GitHub para seguir construyendo apps y conversando sin límite.`,
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
    console.error('[api/tools/build-app] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
  }

  await db.chatSession.upsert({
    where: { id: body.sessionId },
    create: { id: body.sessionId, title: `App: ${body.brief.slice(0, 50)}` },
    update: { updatedAt: new Date() },
  })

  const startedAt = Date.now()
  const mode = normalizeMode(body.mode)

  // Modo modificación: cargar el proyecto existente con sus archivos.
  let existing: { id: string; title: string; files: Array<{ path: string; content: string }> } | null = null
  if (body.projectId) {
    const project = await db.buildProject.findUnique({
      where: { id: body.projectId },
      select: { id: true, title: true, files: { select: { path: true, content: true, bytes: true } } },
    })
    if (!project) {
      return Response.json(
        { error: 'El proyecto a modificar no existe o fue eliminado. Pide una app nueva.', requestId },
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
          title: 'Construyendo app…',
          prompt: body.brief.slice(0, 6000),
          mode,
          status: 'building',
        },
      })

  try {
    const result = existing
      // Sin request.signal a propósito: si el cliente se desconecta (gateway,
      // recarga a mitad del build), la construcción continúa en el servidor y
      // /api/tools/build-app/status permite recuperarla sin repetirla.
      ? await runBuildUpdate({ changeRequest: body.brief, currentFiles: existing.files })
      : await runBuild({ brief: body.brief, mode })

    // Persistencia de archivos (upsert por ruta; los no incluidos permanecen).
    for (const f of result.files) {
      await db.buildFile.upsert({
        where: { projectId_path: { projectId: project.id, path: f.path } },
        create: {
          projectId: project.id,
          path: f.path,
          content: f.content,
          language: languageFromPath(f.path),
          bytes: Buffer.byteLength(f.content, 'utf8'),
        },
        update: {
          content: f.content,
          language: languageFromPath(f.path),
          bytes: Buffer.byteLength(f.content, 'utf8'),
        },
      })
    }

    const finalFiles = await db.buildFile.findMany({
      where: { projectId: project.id },
      select: { path: true, language: true, bytes: true },
      orderBy: { path: 'asc' },
    })

    const updated = await db.buildProject.update({
      where: { id: project.id },
      data: {
        title: result.isUpdate ? (existing?.title || 'App OE AI') : result.title || 'App OE AI',
        status: 'ready',
        planJson: result.isUpdate ? undefined : JSON.stringify(result.plan),
        summaryNote: result.summary.slice(0, 500) || null,
        stack: mode === 'fullstack' ? 'HTML · CSS · JS · Node.js' : 'HTML · CSS · JS',
      },
      select: { id: true, title: true, status: true, mode: true },
    })

    await recordUsage({
      requestId,
      source: 'chat',
      task: 'coding',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    })

    return Response.json(
      {
        id: updated.id,
        title: updated.title,
        summary: result.summary,
        mode: updated.mode,
        status: updated.status,
        isUpdate: result.isUpdate,
        changedPaths: result.changedPaths,
        files: finalFiles,
        latencyMs: Date.now() - startedAt,
      },
      { headers: { 'X-Request-Id': requestId, ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}) } },
    )
  } catch (err) {
    const { message, errorType } = buildErrorMessage(err)
    await db.buildProject.update({
      where: { id: project.id },
      data: { status: 'error', errorType: errorType.slice(0, 60) },
    }).catch(() => undefined)
    await recordUsage({
      requestId,
      source: 'chat',
      task: 'coding',
      status: 'error',
      errorType,
      latencyMs: Date.now() - startedAt,
    })
    const status = errorType === 'aborted' ? 499 : errorType === 'rate_limited' ? 429 : 502
    return Response.json(
      { error: message, errorType, projectId: project.id, requestId },
      { status, headers: { 'X-Request-Id': requestId, ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}) } },
    )
  }
}

