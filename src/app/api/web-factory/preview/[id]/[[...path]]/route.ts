import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
}

/**
 * GET /api/web-factory/preview/[id]/[[...path]] — sirve los archivos reales del
 * sitio generado (desde la DB) para previsualización en vivo dentro de OE AI
 * (iframe con tamaños escritorio/tablet/móvil). Solo lectura, sin ejecutar
 * nada del lado del servidor.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> },
) {
  const { id, path } = await params
  if (!/^[a-z0-9-]{10,45}$/i.test(id)) {
    return Response.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
  }

  const requested = (path && path.length > 0 ? path.join('/') : 'index.html')
    .replace(/^\.?\//, '')
    .replace(/\.\./g, '')

  try {
    const file = await db.buildFile.findUnique({
      where: { projectId_path: { projectId: id, path: requested } },
      select: { content: true, language: true },
    })
    if (!file) {
      return new Response(
        `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui;background:#0c0f14;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0"><p>Archivo no encontrado: ${requested}</p></body></html>`,
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
      )
    }
    const ext = requested.split('.').pop() ?? 'html'
    return new Response(file.content, {
      headers: {
        'Content-Type': MIME[ext] ?? 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    })
  } catch (err) {
    console.error('[api/web-factory/preview] error:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'No se pudo servir la vista previa.' }, { status: 500 })
  }
}
