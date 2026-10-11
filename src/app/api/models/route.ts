import { NextResponse } from 'next/server'
import { buildModelsPayload } from '@/lib/ai/models-view'

export const dynamic = 'force-dynamic'

/**
 * GET /api/models — catálogo público de OE AI con estados reales.
 * Nunca expone credenciales ni configuración interna sensible.
 */
export async function GET() {
  try {
    const payload = await buildModelsPayload()
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    console.error('[api/models] error:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'No se pudo construir el catálogo en este momento.' },
      { status: 500 },
    )
  }
}
