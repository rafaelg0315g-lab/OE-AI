import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { recordUsage } from '@/lib/ai/usage'
import { consumeGuestChat, guestCookieHeader, resolveChatIdentity } from '@/lib/auth/guest'
import { runWebFactory, WebFactoryError } from '@/lib/web-factory/pipeline'
import { buildErrorMessage } from '@/lib/build/pipeline'
import { languageFromPath } from '@/lib/build/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const GenerateBodySchema = z.object({
  sessionId: z.string().uuid(),
  brief: z.string().min(5).max(6000),
  /** Proyecto existente a modificar (petición tipo "haz el hero más elegante"). */
  projectId: z.string().regex(/^[a-z0-9-]{10,45}$/i).optional(),
})

/**
 * POST /api/web-factory/generate — OE AI Web Factory.
 * El asistente emite la directiva ```oe-web y el cliente llama aquí con el
 * brief; el pipeline (plan con catálogo → shell → páginas paralelas → imágenes
 * → validación) produce un sitio multi-página persistido en BuildProject/
 * BuildFile, con vista previa real y descarga ZIP.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID()

  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'web-factory'), 3, 60_000)
  if (!rl.allowed) {
    return Response.json(
      { error: 'Límite de generaciones alcanzado. Espera un momento e inténtalo de nuevo.', requestId },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)), 'X-Request-Id': requestId } },
    )
  }

  let body: z.infer<typeof GenerateBodySchema>
  try {
    body = GenerateBodySchema.parse(await request.json())
  } catch {
    return Response.json(
      { error: 'Payload inválido: sessionId (uuid) y brief (5-6000 caracteres) son obligatorios.', requestId },
      { status: 400, headers: { 'X-Request-Id': requestId } },
    )
  }

  // Identidad + cuota (turno pesado: misma cuota de usos gratis de la sesión).
  let guestSetCookie: string | null = null
  try {
    const identity = await resolveChatIdentity(request)
    if (identity.kind === 'guest') {
      const quota = await consumeGuestChat(identity.guestId)
      if (!quota.allowed) {
        return Response.json(
          {
            error: `Has usado tus ${quota.limit} usos gratis de esta sesión. Inicia sesión con Google o GitHub para seguir generando webs y conversando sin límite.`,
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
    console.error('[api/web-factory] cuota de invitado no disponible:', quotaErr instanceof Error ? quotaErr.message : quotaErr)
  }

  await db.chatSession.upsert({
    where: { id: body.sessionId },
    create: { id: body.sessionId, title: `Web: ${body.brief.slice(0, 50)}` },
    update: { updatedAt: new Date() },
  })

  const startedAt = Date.now()

  const project = body.projectId
    ? await db.buildProject.update({
        where: { id: body.projectId },
        data: { status: 'building', errorType: null, prompt: body.brief.slice(0, 6000) },
      })
    : await db.buildProject.create({
        data: {
          id: crypto.randomUUID(),
          sessionId: body.sessionId,
          title: 'Diseñando sitio…',
          prompt: body.brief.slice(0, 6000),
          mode: 'web',
          status: 'building',
          stack: 'HTML · CSS · JS · Web Factory',
        },
      })

  try {
    const result = await runWebFactory({
      brief: body.brief,
      sessionId: body.sessionId,
      existingProjectId: body.projectId,
      // Sin request.signal a propósito: si el cliente se desconecta (gateway,
      // recarga a mitad del build), el sitio continúa generándose en el
      // servidor y /api/tools/build-app/status permite recuperarlo sin repetir.
    })

    // Persistencia de archivos (upsert por ruta; los no tocados permanecen).
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
        title: result.title || 'Sitio Web Factory',
        status: 'ready',
        planJson: result.isUpdate ? undefined : result.planJson,
        designJson: result.isUpdate ? undefined : JSON.stringify(result.designSystem),
        provenanceJson: JSON.stringify({
          generatedBy: 'OE AI Web Factory',
          codeOwnership: 'Código escrito íntegramente por OE AI (sin copia de repos).',
          framework: result.framework,
          references: result.references,
          images: result.images,
        }),
        checksJson: JSON.stringify({ checks: result.checks, warnings: result.warnings }),
        summaryNote: result.summary.slice(0, 500) || null,
        stack: result.stack,
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
        designSystem: result.designSystem,
        references: result.references,
        checks: result.checks,
        warnings: result.warnings,
        images: result.images,
        stack: result.stack,
        // Vista previa iframe solo para sitios HTML estáticos (React requiere
        // npm install/dev: se muestra la guía en el README y las tarjetas).
        ...(result.framework === 'html' ? { previewUrl: `/api/web-factory/preview/${updated.id}/index.html` } : {}),
        latencyMs: Date.now() - startedAt,
      },
      { headers: { 'X-Request-Id': requestId, ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}) } },
    )
  } catch (err) {
    const { message, errorType } =
      err instanceof WebFactoryError
        ? { message: err.message, errorType: err.errorType }
        : buildErrorMessage(err)
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
    const status = errorType === 'aborted' ? 499 : errorType === 'rate_limited' ? 429 : 502
    return Response.json(
      { error: message, errorType, projectId: project.id, requestId },
      { status, headers: { 'X-Request-Id': requestId, ...(guestSetCookie ? { 'Set-Cookie': guestSetCookie } : {}) } },
    )
  }
}
