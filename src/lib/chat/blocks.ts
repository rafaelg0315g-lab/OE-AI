/**
 * Contrato compartido de bloques del chat OE AI (servidor + cliente).
 *
 * El modelo emite vallas de directiva (`genui` / `imagen` / `documento` /
 * `archivo`); el backend las ejecuta con acciones REALES (generación de
 * imagen, documento persistido, archivo descargable) y entrega al cliente
 * un array de ChatBlock validado. Nada se simula: si una acción falla, el
 * bloque es de tipo 'error' con el mensaje real.
 */
import { z } from 'zod'

// ── Generative UI (especificaciones validadas) ──────────────────────────────

export const GenuiCardsSchema = z.object({
  type: z.literal('cards'),
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        icon: z.string().max(40).optional(), // nombre de icono Lucide (p. ej. "zap")
        title: z.string().min(1).max(120),
        description: z.string().max(400).optional(),
      }),
    )
    .min(1)
    .max(8),
})

export const GenuiMetricsSchema = z.object({
  type: z.literal('metrics'),
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        value: z.string().min(1).max(40),
        hint: z.string().max(160).optional(),
      }),
    )
    .min(1)
    .max(6),
})

export const GenuiTimelineSchema = z.object({
  type: z.literal('timeline'),
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        date: z.string().max(60).optional(),
        title: z.string().min(1).max(140),
        description: z.string().max(400).optional(),
      }),
    )
    .min(2)
    .max(10),
})

export const GenuiChecklistSchema = z.object({
  type: z.literal('checklist'),
  title: z.string().max(120).optional(),
  items: z.array(z.object({ text: z.string().min(1).max(200), done: z.boolean().optional() })).min(2).max(12),
})

export const GenuiStepsSchema = z.object({
  type: z.literal('steps'),
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(140),
        description: z.string().max(400).optional(),
      }),
    )
    .min(2)
    .max(10),
})

export const GenuiCompareSchema = z.object({
  type: z.literal('compare'),
  title: z.string().max(120).optional(),
  columns: z.array(z.string().min(1).max(60)).min(2).max(4),
  rows: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        values: z.array(z.string().max(200)).min(2).max(4),
      }),
    )
    .min(2)
    .max(10),
})

export const GenuiQuizSchema = z.object({
  type: z.literal('quiz'),
  title: z.string().max(120).optional(),
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(160)).min(2).max(6),
  answerIndex: z.number().int().min(0),
  explanation: z.string().max(400).optional(),
})

export const GenuiChartSchema = z.object({
  type: z.literal('chart'),
  title: z.string().max(120).optional(),
  unit: z.string().max(20).optional(),
  items: z.array(z.object({ label: z.string().min(1).max(60), value: z.number() })).min(2).max(8),
})

export const GenuiSpecSchema = z.discriminatedUnion('type', [
  GenuiCardsSchema,
  GenuiMetricsSchema,
  GenuiTimelineSchema,
  GenuiChecklistSchema,
  GenuiStepsSchema,
  GenuiCompareSchema,
  GenuiQuizSchema,
  GenuiChartSchema,
])

export type GenuiSpec = z.infer<typeof GenuiSpecSchema>

// ── ChatBlock (resultado de una directiva ejecutada de verdad) ──────────────

export type ChatBlock =
  | { id: string; type: 'genui'; spec: GenuiSpec }
  | { id: string; type: 'image'; url: string; prompt: string; size: string }
  | {
      id: string
      type: 'document'
      documentId: string
      title: string
      kind: 'writing' | 'code' | 'content' | 'table'
      chars: number
      updatedAt: string
    }
  | { id: string; type: 'file'; fileId: string; url: string; name: string; format: string; size: number }
  | { id: string; type: 'error'; source: 'imagen' | 'documento' | 'archivo' | 'genui'; message: string }

/** Valida un bloque guardado en blocksJson (tolerante: devuelve null si no es válido). */
export function parseChatBlocks(raw: string | null | undefined): ChatBlock[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const blocks: ChatBlock[] = []
    for (const item of parsed) {
      const b = item as Record<string, unknown>
      if (!b || typeof b.id !== 'string' || typeof b.type !== 'string') continue
      if (b.type === 'error') {
        blocks.push({
          id: b.id,
          type: 'error',
          source: (typeof b.source === 'string' ? b.source : 'genui') as 'imagen' | 'documento' | 'archivo' | 'genui',
          message: String(b.message ?? 'Error desconocido'),
        })
        continue
      }
      if (b.type === 'genui') {
        const spec = GenuiSpecSchema.safeParse(b.spec)
        if (spec.success) blocks.push({ id: b.id, type: 'genui', spec: spec.data })
        continue
      }
      if (b.type === 'image' && typeof b.url === 'string') {
        blocks.push({ id: b.id, type: 'image', url: b.url, prompt: String(b.prompt ?? ''), size: String(b.size ?? '') })
        continue
      }
      if (b.type === 'document' && typeof b.documentId === 'string') {
        blocks.push({
          id: b.id,
          type: 'document',
          documentId: b.documentId,
          title: String(b.title ?? 'Documento'),
          kind: (b.kind as 'writing' | 'code' | 'content' | 'table') ?? 'writing',
          chars: Number(b.chars ?? 0),
          updatedAt: String(b.updatedAt ?? ''),
        })
        continue
      }
      if (b.type === 'file' && typeof b.fileId === 'string') {
        blocks.push({
          id: b.id,
          type: 'file',
          fileId: b.fileId,
          url: String(b.url ?? `/api/files/${b.fileId}`),
          name: String(b.name ?? 'archivo'),
          format: String(b.format ?? 'txt'),
          size: Number(b.size ?? 0),
        })
      }
    }
    return blocks
  } catch {
    return []
  }
}

// ── Directivas (vallas reconocidas por el backend) ──────────────────────────

export const DIRECTIVE_KINDS = ['genui', 'imagen', 'documento', 'archivo'] as const
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number]

export function isDirectiveFence(info: string): DirectiveKind | null {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  return (DIRECTIVE_KINDS as readonly string[]).includes(name) ? (name as DirectiveKind) : null
}
