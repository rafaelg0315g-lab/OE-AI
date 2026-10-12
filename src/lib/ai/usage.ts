/**
 * UsageTracker — registro de consumo SIN contenido de prompts/respuestas.
 * Solo metadatos técnicos: proveedor, ruta, latencia, tamaños en caracteres,
 * estado y tipo de error.
 */
import { db } from '@/lib/db'

export interface UsageInput {
  requestId: string
  source:
    | 'chat'
    | 'api_v1'
    | 'health_check'
    | 'tool_image'
    | 'tool_svg'
    | 'tool_image_edit'
    | 'tool_video'
    | 'tool_tts'
    | 'tool_asr'
    | 'tool_read_doc'
  providerId?: string | null
  requestedModelId?: string | null
  resolvedModelId?: string | null
  providerReportedModel?: string | null
  task?: string | null
  status: 'ok' | 'error'
  errorType?: string | null
  latencyMs?: number | null
  promptChars?: number | null
  completionChars?: number | null
  fallbackUsed?: boolean
}

export async function recordUsage(input: UsageInput): Promise<void> {
  try {
    await db.usageRecord.create({
      data: {
        requestId: input.requestId,
        source: input.source,
        providerId: input.providerId ?? null,
        requestedModelId: input.requestedModelId ?? null,
        resolvedModelId: input.resolvedModelId ?? null,
        providerReportedModel: input.providerReportedModel ?? null,
        task: input.task ?? null,
        status: input.status,
        errorType: input.errorType ?? null,
        latencyMs: input.latencyMs ?? null,
        promptChars: input.promptChars ?? null,
        completionChars: input.completionChars ?? null,
        fallbackUsed: input.fallbackUsed ?? false,
      },
    })
  } catch {
    // El registro de uso nunca debe romper la respuesta al usuario.
  }
}

export async function countRequestsSince(date: Date): Promise<number> {
  return db.usageRecord.count({ where: { createdAt: { gte: date }, source: { not: 'health_check' } } })
}

export interface UsageSummary {
  total24h: number
  ok24h: number
  error24h: number
  avgLatencyMs24h: number | null
  byProvider: Array<{ providerId: string; total: number; errors: number; avgLatencyMs: number | null }>
  dailyLimit: number
}

export async function getUsageSummary(dailyLimit: number): Promise<UsageSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const records = await db.usageRecord.findMany({
    where: { createdAt: { gte: since }, source: { not: 'health_check' } },
    select: { providerId: true, status: true, latencyMs: true },
  })

  const total = records.length
  const ok = records.filter((r) => r.status === 'ok')
  const latencies = ok.map((r) => r.latencyMs).filter((n): n is number => typeof n === 'number')
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null

  const providerMap = new Map<string, { total: number; errors: number; latencies: number[] }>()
  for (const r of records) {
    const key = r.providerId ?? '(sin proveedor)'
    const acc = providerMap.get(key) ?? { total: 0, errors: 0, latencies: [] }
    acc.total++
    if (r.status === 'error') acc.errors++
    if (typeof r.latencyMs === 'number') acc.latencies.push(r.latencyMs)
    providerMap.set(key, acc)
  }

  return {
    total24h: total,
    ok24h: ok.length,
    error24h: total - ok.length,
    avgLatencyMs24h: avg,
    byProvider: [...providerMap.entries()]
      .map(([providerId, acc]) => ({
        providerId,
        total: acc.total,
        errors: acc.errors,
        avgLatencyMs: acc.latencies.length > 0 ? Math.round(acc.latencies.reduce((a, b) => a + b, 0) / acc.latencies.length) : null,
      }))
      .sort((a, b) => b.total - a.total),
    dailyLimit,
  }
}
