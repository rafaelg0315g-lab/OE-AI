/**
 * models-view — fusiona catálogo fuente + configuración real para producir
 * las vistas públicas de OE AI.
 *
 * MARCO DE PRODUCTO (OE AI LLM):
 * - OE AI LLM es el modelo unificado de OE BUSINESS y está LISTO: la capa de
 *   orquestación opera con el núcleo activo del proveedor conectado.
 * - Los 128 modelos del catálogo CONFORMAN la red de OE AI LLM: se presentan
 *   como miembros de la red (status 'network_member'), sin estados de
 *   verificación individuales.
 * - El chat funciona siempre a través de OE AI LLM (una sola entrada unificada).
 * - Los contadores se calculan SIEMPRE a partir del registro real.
 */
import { CATALOG, CATALOG_FAMILY_INDEX } from './catalog/catalog'
import { CATALOG_SOURCE_NOTE } from './catalog/models.data'
import { providerRegistry } from './providers'
import { PUBLIC_API_KEY_SET, ADMIN_TOKEN_SET, ROUTER_CONFIG } from './config'
import { latestChecks } from './health'
import { PRODUCT_CATEGORIES, STATUS_LABELS, type IntegrationStatus, type ProductCategory } from './types'

export interface PublicProviderLink {
  providerId: string
  providerLabel: string
  configured: boolean
  lastCheckStatus: string | null
  lastCheckedAt: string | null
}

export interface PublicModelView {
  id: string
  familyId: string
  familyLabel: string
  categories: ProductCategory[]
  indicativeUse: string
  status: IntegrationStatus
  statusLabel: string
  /** Capacidades verificadas por comprobación real (normalmente ['chat'] si 'connected'). */
  verifiedCapabilities: string[]
  providers: PublicProviderLink[]
  lastCheckedAt: string | null
  lastCheckNote: string | null
  reviewNote: string | null
  /** Se puede abrir chat con este modelo ahora mismo. */
  chatEnabled: boolean
  /** El panel de administración puede intentar una comprobación. */
  testable: boolean
  detailUrl: string
}

export interface CatalogCounters {
  total: number
  connected: number
  networkMembers: number
  providersConfigured: number
  providersRegistered: number
  visionVerified: number
  codingVerified: number
  families: number
  source: string
}

export interface ModelsPayload {
  oeAiLlm: {
    name: string
    status: 'ready'
    statusLabel: string
    tagline: string
    description: string
    coreProviderId: string
    coreLabel: string
  }
  models: PublicModelView[]
  counters: CatalogCounters
  families: string[]
  categories: readonly ProductCategory[]
  providers: Array<{
    id: string
    label: string
    configured: boolean
    status: IntegrationStatus
    statusLabel: string
    capabilities: { chat: boolean; streaming: boolean; modelSelection: boolean }
    endpointStatus: string
    envVarNames: string[]
    note: string
    servesDefault: boolean
  }>
  router: { mode: string; fallbackAllowed: boolean; defaultRouteLabel: string | null }
  publicApi: { enabled: boolean; status: IntegrationStatus }
  sourceNote: string
}

export async function buildModelsPayload(): Promise<ModelsPayload> {
  const checks = await latestChecks()
  const adapters = providerRegistry.list()
  const routes = providerRegistry.availableRoutes()

  const models: PublicModelView[] = CATALOG.map((entry) => {
    const servingRoutes = routes.filter((r) => r.catalogModelId === entry.id)
    const providerLinks: PublicProviderLink[] = servingRoutes.map((r) => {
      const adapter = providerRegistry.get(r.providerId)
      const check = checks.get(`model:${entry.id}`)
      return {
        providerId: r.providerId,
        providerLabel: adapter?.label ?? r.providerId,
        configured: adapter?.isConfigured() ?? false,
        lastCheckStatus: check?.status ?? null,
        lastCheckedAt: check ? check.checkedAt.toISOString() : null,
      }
    })

    const check = checks.get(`model:${entry.id}`)
    // Estados honestos: "Conectado" SOLO con comprobación real superada;
    // el resto de miembros de la red se presentan como 'network_member'.
    const checkOk = check?.status === 'ok'
    const status: IntegrationStatus = checkOk ? 'connected' : 'network_member'

    return {
      id: entry.id,
      familyId: entry.familyId,
      familyLabel: entry.familyLabel,
      categories: entry.categories,
      indicativeUse: entry.indicativeUse,
      status,
      statusLabel: STATUS_LABELS[status],
      verifiedCapabilities: checkOk ? ['chat'] : [],
      providers: providerLinks,
      lastCheckedAt: check ? check.checkedAt.toISOString() : null,
      lastCheckNote: check?.note ?? null,
      reviewNote: entry.reviewNote,
      chatEnabled: true, // el chat opera siempre a través de OE AI LLM
      testable: servingRoutes.length > 0 || adapters.some((a) => a.id === 'zai-org'),
      detailUrl: `/apis?model=${encodeURIComponent(entry.id)}`,
    }
  })

  const providers = adapters.map((a) => {
    const configured = a.isConfigured()
    const providerCheck = checks.get(`provider:${a.id}`)
    let status: IntegrationStatus
    if (configured && (providerCheck?.status === 'ok' || a.endpointStatus === 'verified')) status = 'connected'
    else if (configured) status = 'available_with_config'
    else if (a.endpointStatus === 'planned') status = 'planned'
    else status = 'available_with_config'
    return {
      id: a.id,
      label: a.label,
      configured,
      status,
      statusLabel: STATUS_LABELS[status],
      capabilities: a.capabilities,
      endpointStatus: a.endpointStatus,
      envVarNames: a.envVarNames,
      note: a.note,
      servesDefault: a.routableRoutes().some((r) => r.catalogModelId === null),
    }
  })

  const counters: CatalogCounters = {
    total: CATALOG.length,
    connected: models.filter((m) => m.status === 'connected').length,
    networkMembers: models.filter((m) => m.status === 'network_member').length,
    providersConfigured: providers.filter((p) => p.configured).length,
    providersRegistered: providers.length,
    visionVerified: models.filter((m) => m.verifiedCapabilities.includes('vision')).length,
    codingVerified: models.filter((m) => m.verifiedCapabilities.includes('coding')).length,
    families: CATALOG_FAMILY_INDEX.length,
    source: 'Contadores calculados dinámicamente desde el registro real del catálogo.',
  }

  const coreAdapter = adapters.find((a) => a.id === 'zai-org')

  const oeAiLlm = {
    name: 'OE AI LLM',
    status: 'ready' as const,
    statusLabel: 'Listo',
    tagline: `Red unificada de ${CATALOG.length} modelos`,
    description:
      'OE AI LLM es el modelo unificado de OE BUSINESS: una capa de orquestación que coordina la red de 128 modelos de distintos proveedores, enruta cada solicitud y devuelve una respuesta normalizada. No es un modelo fundacional: es la red, el enrutador y las políticas funcionando como un solo modelo.',
    coreProviderId: 'zai-org',
    coreLabel: coreAdapter?.label ?? 'Z.ai (SDK de entorno OE)',
  }

  const defaultRoute = routes.find((r) => r.catalogModelId === null)

  return {
    oeAiLlm,
    models,
    counters,
    families: CATALOG_FAMILY_INDEX,
    categories: PRODUCT_CATEGORIES,
    providers,
    router: {
      mode: ROUTER_CONFIG.mode,
      fallbackAllowed: ROUTER_CONFIG.fallbackAllowed,
      defaultRouteLabel: defaultRoute?.label ?? null,
    },
    publicApi: {
      enabled: PUBLIC_API_KEY_SET,
      status: PUBLIC_API_KEY_SET ? 'connected' : 'planned',
    },
    sourceNote: CATALOG_SOURCE_NOTE,
  }
}

export interface ModelDetailView extends PublicModelView {
  checks: Array<{ status: string; note: string | null; checkedAt: string; latencyMs: number | null }>
  familyNote: string | null
  costNote: string
  contextNote: string
}

export async function buildModelDetail(id: string): Promise<ModelDetailView | null> {
  const payload = await buildModelsPayload()
  const model = payload.models.find((m) => m.id === id)
  if (!model) return null
  const checks = await dbChecksFor(id)
  return {
    ...model,
    checks,
    familyNote: networkFamilyNote(model.familyId),
    costNote:
      'Sin datos de precio verificados. Los valores que pudiera contener el material fuente no se presentan como precios vigentes; consulta siempre la tarifa actual del proveedor.',
    contextNote: 'Sin fuente vigente no se publica ningún valor de contexto.',
  }
}

async function dbChecksFor(modelId: string) {
  const { db } = await import('@/lib/db')
  const rows = await db.providerCheck.findMany({
    where: { modelId },
    orderBy: { checkedAt: 'desc' },
    take: 5,
  })
  return rows.map((r) => ({
    status: r.status,
    note: r.note,
    checkedAt: r.checkedAt.toISOString(),
    latencyMs: r.latencyMs,
  }))
}

/** Nota de red: cómo participa esta familia dentro de OE AI LLM. */
function networkFamilyNote(familyId: string): string | null {
  return familyId === 'zai-org'
    ? 'La familia zai-org está conectada en el entorno actual y aporta el núcleo activo con el que OE AI LLM procesa las solicitudes en este momento.'
    : 'Esta familia forma parte de la red que conforma OE AI LLM. El núcleo activo actual corresponde al proveedor conectado en este entorno.'
}

export { ADMIN_TOKEN_SET }
