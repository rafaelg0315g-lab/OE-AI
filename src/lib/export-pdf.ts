'use client'

/**
 * Exportación de conversaciones a PDF vía el diálogo de impresión del
 * navegador (window.print sobre un iframe oculto): sin dependencias nuevas.
 *
 * - HTML imprimible con estilos inline simples (máx. 700 px, fuente system).
 * - Roles visibles: «Tú» (negrita) / «OE AI LLM»; saltos de línea preservados.
 * - Imágenes adjuntas y generadas incluidas como <img>.
 * - El nombre sugerido del documento es el título de la conversación (el
 *   navegador lo toma del <title> del documento impreso).
 */

import type { ExportableMessage } from './export-chat'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const BASE_STYLE = [
  'margin:0',
  'padding:32px 24px',
  'background:#ffffff',
  'color:#1a202c',
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  'font-size:13px',
  'line-height:1.6',
].join(';')

const PAGE_STYLE = ['max-width:700px', 'margin:0 auto'].join(';')

const ROLE_USER_STYLE = [
  'margin:24px 0 4px',
  'font-size:12px',
  'font-weight:700',
  'text-transform:uppercase',
  'letter-spacing:0.06em',
  'color:#047857',
].join(';')

const ROLE_AI_STYLE = ROLE_USER_STYLE.replace('color:#047857', 'color:#374151')

const TEXT_STYLE = [
  'margin:0',
  'white-space:pre-wrap',
  'overflow-wrap:break-word',
  'font-size:13.5px',
].join(';')

const IMG_STYLE = ['display:block', 'max-width:100%', 'height:auto', 'margin:8px 0', 'border-radius:8px', 'border:1px solid #e5e7eb'].join(';')

const CAPTION_STYLE = ['margin:2px 0 0', 'font-size:11px', 'color:#6b7280', 'font-style:italic'].join(';')

/** Construye el HTML imprimible de la conversación. */
export function buildConversationPrintHtml(title: string, messages: ExportableMessage[]): string {
  const dateLabel = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' })
  const body: string[] = [
    `<h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;color:#111827">${escapeHtml(title)}</h1>`,
    `<p style="margin:0 0 8px;font-size:11.5px;color:#6b7280">Exportado desde OE AI · ${escapeHtml(dateLabel)}</p>`,
    '<hr style="margin:16px 0;border:0;border-top:1px solid #e5e7eb" />',
  ]

  for (const m of messages) {
    const isImage = m.kind === 'image'
    const roleLabel = m.role === 'user' ? 'Tú' : isImage ? 'OE AI LLM · imagen generada' : 'OE AI LLM'
    const roleStyle = m.role === 'user' ? ROLE_USER_STYLE : ROLE_AI_STYLE
    body.push(`<p style="${roleStyle}">${escapeHtml(roleLabel)}</p>`)
    const text = m.role === 'user' ? m.content : m.fullContent || m.content
    if (text) body.push(`<div style="${TEXT_STYLE}">${escapeHtml(text)}</div>`)
    const imgSrc = m.role === 'user' ? m.attachmentUrl : isImage ? m.assetUrl : null
    if (imgSrc) {
      body.push(`<img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(m.role === 'user' ? 'Imagen adjunta' : 'Imagen generada')}" style="${IMG_STYLE}" />`)
      if (isImage && m.content) body.push(`<p style="${CAPTION_STYLE}">${escapeHtml(m.content)}</p>`)
    }
    if (m.sources?.length) {
      const items = m.sources
        .map((s, i) => `<li style="margin:2px 0">${i + 1}. ${escapeHtml(s.name)} — <span style="color:#6b7280">${escapeHtml(s.hostName)}</span></li>`)
        .join('')
      body.push(`<p style="margin:6px 0 0;font-size:11.5px;color:#6b7280">Fuentes web:</p><ol style="margin:4px 0 0;padding-left:20px;font-size:11.5px">${items}</ol>`)
    }
  }

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
</head>
<body style="${BASE_STYLE}">
<div style="${PAGE_STYLE}">
${body.join('\n')}
</div>
</body>
</html>`
}

/** Imprime el HTML en un iframe oculto y limpia después del diálogo. */
function printHtmlInHiddenFrame(html: string, frameId: string) {
  document.getElementById(frameId)?.remove()
  const iframe = document.createElement('iframe')
  iframe.id = frameId
  iframe.title = 'Documento de impresión'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('tabindex', '-1')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.style.visibility = 'hidden'
  document.body.appendChild(iframe)

  const win = iframe.contentWindow
  const doc = iframe.contentDocument
  if (!win || !doc) {
    iframe.remove()
    return
  }
  doc.open()
  doc.write(html)
  doc.close()

  // Se espera a que las imágenes carguen (con tope de 3 s) antes de imprimir.
  const images = Array.from(doc.images)
  const loaded = Promise.all(
    images.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          }),
    ),
  )
  const cap = new Promise<void>((resolve) => window.setTimeout(resolve, 3000))

  void Promise.race([loaded, cap]).then(() => {
    const cleanup = () => window.setTimeout(() => iframe.remove(), 400)
    try {
      win.addEventListener('afterprint', cleanup, { once: true })
    } catch {
      // navegadores sin afterprint: queda el respaldo temporizado
    }
    try {
      win.focus()
      win.print()
    } catch {
      // sin diálogo de impresión (p. ej. headless): solo limpiar
    }
    // Respaldo si el navegador nunca dispara afterprint.
    window.setTimeout(() => {
      if (iframe.isConnected) iframe.remove()
    }, 60000)
  })
}

/** Exporta la conversación activa (mensajes en memoria) como PDF. */
export function exportMessagesAsPdf(title: string, messages: ExportableMessage[]) {
  if (messages.length === 0) return
  printHtmlInHiddenFrame(buildConversationPrintHtml(title, messages), 'oe-pdf-print-frame')
}

/** Exporta cualquier conversación del historial como PDF (vía /api/chat/history). */
export async function exportConversationByIdAsPdf(id: string, fallbackTitle: string) {
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
    const messages: ExportableMessage[] = (data.messages ?? []).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content ?? ''),
      kind: m.kind === 'image' ? 'image' : 'text',
      assetUrl: m.kind === 'image' && typeof m.assetId === 'string' ? `/api/assets/${m.assetId}` : null,
      attachmentUrl: m.role === 'user' && typeof m.attachmentAssetId === 'string' ? `/api/assets/${m.attachmentAssetId}` : null,
      fullContent: String(m.content ?? ''),
    }))
    if (messages.length === 0) return
    printHtmlInHiddenFrame(buildConversationPrintHtml(title, messages), 'oe-pdf-print-frame')
  } catch {
    // sin exportación si la red falla; no se simula ningún documento
  }
}
