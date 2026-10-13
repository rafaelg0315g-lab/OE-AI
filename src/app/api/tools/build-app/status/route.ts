import { z } from 'zod'
import { db } from '@/lib/db'
import { checkRateLimit, clientKeyFromHeaders } from '@/lib/ai/ratelimit'
import { resolveAuthUser } from '@/lib/auth/guest'

export const dynamic = 'force-dynamic'

const QuerySchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().regex(/^[a-z0-9-]{6,45}$/i).optional(),
})

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Un build legítimo nunca supera ~5 min (el peor caso Web Factory midió 4.3).
 * Si un proyecto sigue 'building' pasado ese margen es un HUÉRFANO: el proceso
 * que lo construía murió (reinicio del servidor, crash, deploy). Se reporta y
 * persiste como error para que el cliente deje de sondear y muestre un mensaje
 * honesto en vez de quedarse cargando para siempre. (6 min < deadline de 8 min
 * del sondeo del cliente: el cliente ve el error, no su propio timeout.) */
const ORPHAN_BUILD_MS = 6 * 60_000

async function resolveOrphanBuild<
  P extends { id: string; status: string; updatedAt: Date; errorType: string | null },
>(p: P): Promise<P> {
  if (p.status !== 'building') return p
  if (Date.now() - p.updatedAt.getTime() < ORPHAN_BUILD_MS) return p
  const errorType = 'build_interrupted'
  await db.buildProject
    .update({ where: { id: p.id }, data: { status: 'error', errorType } })
    .catch(() => null)
  return { ...p, status: 'error', errorType }
}

/**
 * GET /api/tools/build-app/status?sessionId=<uuid>[&projectId=<id>]
 * Estado REAL de la construcción (apps del Constructor y sitios Web Factory).
 * - Sin projectId: lista ligera de los últimos proyectos de la sesión + detalle
 *   completo del más reciente.
 * - Con projectId: detalle completo de ese proyecto (si pertenece a la sesión).
 * El cliente lo usa para que las tarjetas de archivos aparezcan solas aunque la
 * conexión del POST se corte (gateway, recarga a mitad de build): el build sigue
 * en el servidor y el estado aquí es la verdad. Solo lectura, sin cuota.
 */
export async function GET(request: Request) {
  const rl = checkRateLimit(clientKeyFromHeaders(request.headers, 'build-status'), 150, 60_000)
  if (!rl.allowed) {
    return Response.json({ error: 'Demasiadas consultas de estado.' }, { status: 429 })
  }

  const url = new URL(request.url)
  const parsed = QuerySchema.safeParse({
    sessionId: url.searchParams.get('sessionId') ?? '',
    projectId: url.searchParams.get('projectId') ?? undefined,
  })
  if (!parsed.success) {
    return Response.json({ error: 'sessionId (uuid) es obligatorio.' }, { status: 400 })
  }
  const { sessionId, projectId } = parsed.data

  // PRIVACIDAD: si el chat tiene propietario, solo su dueño ve sus builds.
  // Para cualquier otra persona la respuesta es vacía (indistinguible de una
  // sesión sin proyectos).
  const session = await db.chatSession.findUnique({ where: { id: sessionId }, select: { ownerKey: true } })
  if (session?.ownerKey) {
    const caller = await resolveAuthUser(request)
    if (!caller || caller.supabaseId !== session.ownerKey) {
      return Response.json({ project: null, projects: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }
  }

  const toDetail = (
    p: {
      id: string
      title: string
      status: string
      mode: string
      stack: string
      errorType: string | null
      summaryNote: string | null
      designJson: string | null
      provenanceJson: string | null
      checksJson: string | null
      createdAt: Date
      files: Array<{ path: string; language: string | null; bytes: number | null }>
    },
  ) => {
    const isWeb = p.mode === 'web'
    const provenance = safeParse<{ references?: unknown }>(p.provenanceJson, {})
    const checks = safeParse<{ checks?: unknown; warnings?: unknown }>(p.checksJson, {})
    const hasStaticIndex = p.files.some((f) => f.path === 'index.html')
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      mode: p.mode,
      stack: p.stack,
      errorType: p.errorType,
      summary: p.summaryNote ?? '',
      createdAt: p.createdAt.toISOString(),
      files: p.files.map((f) => ({ path: f.path, language: f.language ?? undefined, bytes: f.bytes ?? undefined })),
      ...(isWeb
        ? {
            // Vista previa iframe SOLO si hay index.html estático (React se
            // ejecuta con npm run dev, no en el iframe).
            ...(hasStaticIndex ? { previewUrl: `/api/web-factory/preview/${p.id}/index.html` } : {}),
            designSystem: safeParse<Record<string, unknown> | undefined>(p.designJson, undefined),
            references: Array.isArray(provenance.references) ? provenance.references : undefined,
            checks: Array.isArray(checks.checks) ? checks.checks : undefined,
            warnings: Array.isArray(checks.warnings) ? checks.warnings : undefined,
          }
        : {}),
    }
  }

  if (projectId) {
    const project = await db.buildProject.findFirst({
      where: { id: projectId, sessionId },
      include: { files: { select: { path: true, language: true, bytes: true }, orderBy: { path: 'asc' } } },
    })
    if (!project) return Response.json({ project: null }, { headers: { 'Cache-Control': 'no-store' } })
    const resolved = await resolveOrphanBuild(project)
    return Response.json(
      { project: toDetail(resolved) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const recentRows = await db.buildProject.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, title: true, status: true, mode: true, errorType: true, createdAt: true, updatedAt: true },
  })
  const recent = await Promise.all(recentRows.map((p) => resolveOrphanBuild(p)))

  const latest =
    recent.length > 0
      ? await db.buildProject.findFirst({
          where: { id: recent[0].id },
          include: { files: { select: { path: true, language: true, bytes: true }, orderBy: { path: 'asc' } } },
        })
      : null

  return Response.json(
    {
      project: latest ? toDetail(await resolveOrphanBuild(latest)) : null,
      projects: recent.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        mode: p.mode,
        errorType: p.errorType,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
