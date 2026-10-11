import JSZip from 'jszip'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'oe-app'
  )
}

/**
 * GET /api/tools/build-app/[id]/download — descarga del proyecto construido.
 * - Sin `path`: empaqueta TODOS los archivos en un .zip descargable.
 * - Con `path`: descarga ese archivo individual como attachment.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const project = await db.buildProject.findUnique({
      where: { id },
      select: { title: true, status: true },
    })
    if (!project) return Response.json({ error: 'Proyecto no encontrado.' }, { status: 404 })

    const singlePath = new URL(request.url).searchParams.get('path')

    if (singlePath) {
      const file = await db.buildFile.findUnique({
        where: { projectId_path: { projectId: id, path: singlePath } },
        select: { path: true, content: true },
      })
      if (!file) return Response.json({ error: 'Archivo no encontrado en el proyecto.' }, { status: 404 })
      const filename = file.path.split('/').pop() || 'archivo.txt'
      return new Response(file.content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const files = await db.buildFile.findMany({
      where: { projectId: id },
      select: { path: true, content: true },
    })
    if (files.length === 0) {
      return Response.json({ error: 'El proyecto aún no tiene archivos.' }, { status: 409 })
    }

    const zip = new JSZip()
    const root = zip.folder(slugify(project.title))
    for (const f of files) {
      root?.file(f.path, f.content)
    }

    const buffer = await zip.generateAsync({ type: 'uint8array' })
    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slugify(project.title)}.zip"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[api/tools/build-app/:id/download] error:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'No se pudo empaquetar el proyecto.' }, { status: 500 })
  }
}
