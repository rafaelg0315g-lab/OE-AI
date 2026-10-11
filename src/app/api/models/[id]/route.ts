import { NextResponse } from 'next/server'
import { buildModelDetail } from '@/lib/ai/models-view'

export const dynamic = 'force-dynamic'

/**
 * GET /api/models/[id] — detalle público de un modelo del catálogo.
 * El ID se conserva EXACTO (incluye '/'); Next.js decodifica el parámetro.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const modelId = decodeURIComponent(id)
  try {
    const detail = await buildModelDetail(modelId)
    if (!detail) {
      return NextResponse.json({ error: 'Modelo no encontrado en el catálogo.' }, { status: 404 })
    }
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[api/models/:id] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No se pudo obtener el detalle del modelo.' }, { status: 500 })
  }
}
