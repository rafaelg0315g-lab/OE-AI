import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isAdminTokenValid, ADMIN_TOKEN_SET, ROUTER_CONFIG, PUBLIC_API_KEY_SET } from '@/lib/ai/config'
import { getUsageSummary } from '@/lib/ai/usage'
import { latestChecks } from '@/lib/ai/health'
import { providerRegistry } from '@/lib/ai/providers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/overview — métricas agregadas y estado de configuración.
 * Protegido con X-Admin-Token (OE_AI_ADMIN_TOKEN). Nunca devuelve valores de secretos.
 */
export async function GET(request: Request) {
  if (!ADMIN_TOKEN_SET) {
    return NextResponse.json(
      { error: 'El panel de administración no está habilitado. Configura OE_AI_ADMIN_TOKEN en el servidor.' },
      { status: 503 },
    )
  }
  const token = request.headers.get('x-admin-token')
  if (!isAdminTokenValid(token)) {
    return NextResponse.json({ error: 'Token de administración inválido.' }, { status: 401 })
  }

  const [usage, checks] = await Promise.all([getUsageSummary(ROUTER_CONFIG.maxDailyRequests), latestChecks()])
  const providers = providerRegistry.list().map((a) => ({
    id: a.id,
    label: a.label,
    configured: a.isConfigured(),
    capabilities: a.capabilities,
    endpointStatus: a.endpointStatus,
    envVarNames: a.envVarNames,
    note: a.note,
  }))

  return NextResponse.json(
    {
      usage,
      providers,
      recentChecks: [...checks.entries()].slice(0, 12).map(([key, v]) => ({
        target: key,
        status: v.status,
        note: v.note,
        latencyMs: v.latencyMs,
        checkedAt: v.checkedAt.toISOString(),
      })),
      config: {
        routerMode: ROUTER_CONFIG.mode,
        fallbackAllowed: ROUTER_CONFIG.fallbackAllowed,
        maxDailyRequests: ROUTER_CONFIG.maxDailyRequests,
        chatRpm: ROUTER_CONFIG.chatRequestsPerMinute,
        apiRpm: ROUTER_CONFIG.apiRequestsPerMinute,
        publicApiEnabled: PUBLIC_API_KEY_SET,
        adminEnabled: ADMIN_TOKEN_SET,
        enabledRoutesSource: 'OE_AI_MODEL_ROUTES',
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
