'use client'

/**
 * Exportación de conversaciones como Markdown descargable.
 * Compartido por el hook del chat (conversación activa) y el sidebar
 * (cualquier conversación del historial vía /api/chat/history).
 */

export interface ExportableSource {
  name: string
  url: string
  hostName: string
  snippet?: string
  date?: string | null
}

export interface ExportableMessage {
  role: 'user' | 'assistant'
  content: string
  fullContent?: string
  kind?: 'text' | 'image'
  assetUrl?: string | null
  /** Imagen adjuntada por el usuario (visión). */
  attachmentUrl?: string | null
  sources?: ExportableSource[]
  meta?: { latencyMs?: number | null; mode?: 'instant' | 'reflective' }
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'conversacion'
  )
}

export function buildConversationMarkdown(title: string, messages: ExportableMessage[]): string {
  const lines: string[] = [`# ${title}`, '', `_Exportado desde OE AI · ${new Date().toLocaleString('es-CO')}_`, '']
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`## Tú`, '', m.content, '')
      if (m.attachmentUrl) lines.push(`![Imagen adjunta](${m.attachmentUrl})`, '')
    } else if (m.kind === 'image') {
      lines.push(`## OE AI LLM · imagen generada`, '', m.content ? `> ${m.content}` : '', m.assetUrl ? `![Imagen generada](${m.assetUrl})` : '', '')
    } else {
      lines.push(`## OE AI LLM`, '', m.fullContent || m.content, '')
      if (m.sources?.length) {
        lines.push('**Fuentes web:**', '')
        m.sources.forEach((s, i) => lines.push(`${i + 1}. [${s.name}](${s.url}) — ${s.hostName}`))
        lines.push('')
      }
      const bits: string[] = []
      if (m.meta?.latencyMs) bits.push(`latencia ${(m.meta.latencyMs / 1000).toFixed(1)} s`)
      if (m.meta?.mode === 'reflective') bits.push('modo reflexivo')
      if (bits.length) lines.push(`_${bits.join(' · ')}_`, '')
    }
  }
  return lines.join('\n')
}

function downloadMarkdown(title: string, messages: ExportableMessage[]) {
  const md = buildConversationMarkdown(title, messages)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slugify(title)}.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Exporta la conversación activa (mensajes ya en memoria). */
export function exportMessagesAsMarkdown(title: string, messages: ExportableMessage[]) {
  if (messages.length === 0) return
  downloadMarkdown(title, messages)
}

/** Exporta cualquier conversación del historial descargando sus mensajes. */
export async function exportConversationById(id: string, fallbackTitle: string) {
  try {
    // Token de Supabase (si hay sesión): los chats privados solo los lee su dueño.
    const { getSupabase, supabaseConfigured } = await import('@/lib/supabase')
    const token = supabaseConfigured ? (await getSupabase().auth.getSession()).data.session?.access_token : null
    const res = await fetch(`/api/chat/history?sessionId=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    })
    if (!res.ok) return
    const data = (await res.json()) as { session?: { title?: string }; messages?: Array<Record<string, unknown>> }
    const title = data.session?.title || fallbackTitle
    const messages: ExportableMessage[] = (data.messages ?? []).map((m) => {
      let sources: ExportableSource[] | undefined
      if (typeof m.sourcesJson === 'string' && m.sourcesJson) {
        try {
          const parsed = JSON.parse(m.sourcesJson) as ExportableSource[]
          if (Array.isArray(parsed) && parsed.length) sources = parsed
        } catch {
          // JSON inválido: se ignora
        }
      }
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content ?? ''),
        kind: m.kind === 'image' ? 'image' : 'text',
        assetUrl: m.kind === 'image' && typeof m.assetId === 'string' ? `/api/assets/${m.assetId}` : null,
        sources,
        meta: { latencyMs: (m.latencyMs as number) ?? null },
      }
    })
    downloadMarkdown(title, messages)
  } catch {
    // sin exportación si la red falla; no se simula ningún archivo
  }
}
