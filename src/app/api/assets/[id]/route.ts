import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/assets/[id] — sirve el contenido binario de un activo generado
 * (imágenes). Nunca expone datos del proveedor; solo el binario persistido.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[a-z0-9_-]{10,40}$/i.test(id)) {
    return Response.json({ error: 'Identificador de activo inválido.' }, { status: 400 })
  }
  try {
    const asset = await db.generatedAsset.findUnique({ where: { id }, select: { mime: true, data: true } })
    if (!asset) {
      return Response.json({ error: 'Activo no encontrado.' }, { status: 404 })
    }
    const body = new Uint8Array(asset.data)
    return new Response(body, {
      headers: {
        'Content-Type': asset.mime || 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (err) {
    console.error('[api/assets/:id] error:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'No se pudo obtener el activo.' }, { status: 500 })
  }
}
