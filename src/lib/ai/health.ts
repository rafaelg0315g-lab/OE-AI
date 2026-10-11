/**
 * ModelHealthCheck — comprobaciones controladas de conectividad.
 *
 * Cada comprobación genera UNA petición mínima ("PONG") y registra el resultado
 * con fecha. Los estados "Conectado" del catálogo SOLO provienen de estas
 * comprobaciones reales, nunca de la mera presencia del ID.
 */
import { db } from '@/lib/db'
import { providerRegistry } from './providers'
import type { AdapterChatMessage } from './types-helpers'

export interface CheckResult {
  providerId: string
  modelId: string | null
  status: 'ok' | 'error' | 'not_verifiable'
  latencyMs: number | null
  note: string
  reportedModel: string | null
}

const TEST_MESSAGES: AdapterChatMessage[] = [
  { role: 'user', content: 'Responde exactamente con la palabra: PONG' },
]

export async function runCheck(providerId: string, modelId: string | null): Promise<CheckResult> {
  const adapter = providerRegistry.get(providerId)
  if (!adapter) {
    const result: CheckResult = {
      providerId,
      modelId,
      status: 'not_verifiable',
      latencyMs: null,
      note: 'Proveedor desconocido o sin adaptador registrado.',
      reportedModel: null,
    }
    await persist(result)
    return result
  }

  if (!adapter.isConfigured()) {
    const result: CheckResult = {
      providerId,
      modelId,
      status: 'not_verifiable',
      latencyMs: null,
      note: `Proveedor sin credenciales configuradas (${adapter.envVarNames.join(', ')}).`,
      reportedModel: null,
    }
    await persist(result)
    return result
  }

  if (modelId && !adapter.capabilities.modelSelection) {
    const result: CheckResult = {
      providerId,
      modelId,
      status: 'not_verifiable',
      latencyMs: null,
      note:
        'Este adaptador no permite seleccionar modelos concretos: sirve el modelo predeterminado del proveedor, por lo que la conectividad de este modelo individual no puede verificarse con la integración actual.',
      reportedModel: null,
    }
    await persist(result)
    return result
  }

  const providerModelId = modelId ?? 'default'
  try {
    const completion = await adapter.chat({ messages: TEST_MESSAGES, providerModelId })
    const result: CheckResult = {
      providerId,
      modelId,
      status: 'ok',
      latencyMs: completion.latencyMs,
      note:
        modelId === null
          ? `Prueba real superada contra el modelo predeterminado del proveedor${completion.providerReportedModel ? ` (informado: ${completion.providerReportedModel})` : ''}.`
          : 'Prueba real superada con el modelo solicitado.',
      reportedModel: completion.providerReportedModel,
    }
    await persist(result)
    return result
  } catch (err) {
    const type = err instanceof Error && 'errorType' in err ? String((err as { errorType?: string }).errorType) : 'provider_error'
    const result: CheckResult = {
      providerId,
      modelId,
      status: 'error',
      latencyMs: null,
      note: `La comprobación real falló (${type}). No se marca el modelo como conectado.`,
      reportedModel: null,
    }
    await persist(result)
    return result
  }
}

async function persist(result: CheckResult): Promise<void> {
  try {
    await db.providerCheck.create({
      data: {
        providerId: result.providerId,
        modelId: result.modelId,
        status: result.status,
        latencyMs: result.latencyMs,
        note: result.note,
        reportedBy: 'real_test',
      },
    })
  } catch {
    // No bloquear la comprobación por un fallo de persistencia.
  }
}

/** Última comprobación por modelo (o por proveedor con modelId null). */
export async function latestChecks(): Promise<
  Map<string, { status: string; note: string | null; checkedAt: Date; latencyMs: number | null }>
> {
  const checks = await db.providerCheck.findMany({
    orderBy: { checkedAt: 'desc' },
    take: 500,
  })
  const map = new Map<string, { status: string; note: string | null; checkedAt: Date; latencyMs: number | null }>()
  for (const c of checks) {
    const key = c.modelId ? `model:${c.modelId}` : `provider:${c.providerId}`
    if (!map.has(key)) {
      map.set(key, { status: c.status, note: c.note, checkedAt: c.checkedAt, latencyMs: c.latencyMs })
    }
  }
  return map
}
