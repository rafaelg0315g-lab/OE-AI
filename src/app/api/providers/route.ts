import { NextResponse } from 'next/server'
import { buildModelsPayload } from '@/lib/ai/models-view'
import { providerRegistry } from '@/lib/ai/providers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/providers — estado público-seguro de los proveedores registrados.
 * Expone: configurado sí/no, capacidades, nombres de variables de entorno y las
 * rutas realmente servibles (para el selector del chat). Nunca expone valores de
 * credenciales ni URLs privadas.
 */
export async function GET() {
  try {
    const payload = await buildModelsPayload()
    const routes = providerRegistry.availableRoutes().map((r) => ({
      key: r.key,
      label: r.label,
      providerId: r.providerId,
      catalogModelId: r.catalogModelId,
    }))
    return NextResponse.json(
      { providers: payload.providers, router: payload.router, publicApi: payload.publicApi, routes },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[api/providers] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No se pudo obtener el estado de proveedores.' }, { status: 500 })
  }
}

