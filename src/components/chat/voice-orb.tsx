'use client'

/**
 * VoiceOrb — orbe de OE AI para el modo voz (canvas 2D, 60 fps).
 *
 * Diseño minimalista y premium:
 *  · Resplandor ambiental que respira según el estado.
 *  · Anillo de 64 barras radiales que reaccionan al micrófono (escucha) o
 *    siguen una onda orgánica sintética (hablando).
 *  · Núcleo oscuro con anillo de titanio y la placa OE en el centro.
 *  · Pensando: tres satélites orbitando + arco giratorio.
 *  · Silenciado: barras planas grises; error: tinte rojo.
 */
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { OeLogo } from './oe-logo'
import type { VoicePhase } from '@/hooks/use-voice-mode'

const BARS = 64
const BASE_R = 0.315 // radio del anillo de barras (fracción del tamaño)
const CORE_R = 0.245 // radio del núcleo
const MAX_BAR = 0.085 // longitud máxima de barra (fracción del tamaño)

/** Ruido determinista suave por barra (variedad orgánica, sin aleatoriedad). */
function organic(i: number, t: number): number {
  const a = Math.sin(t * 0.0011 + i * 0.62)
  const b = Math.sin(t * 0.0007 - i * 1.31)
  const c = Math.sin(t * 0.0019 + i * 0.17)
  return 0.5 + 0.25 * a + 0.15 * b + 0.1 * c
}

/** Onda "hablando" sintética: parecida a la voz humana (sílabas). */
function speakWave(i: number, t: number): number {
  const syl = Math.abs(Math.sin(t * 0.0042 + i * 0.5)) // sílabas lentas
  const fine = Math.abs(Math.sin(t * 0.011 + i * 1.9)) // detalle fino
  return Math.min(1, 0.18 + syl * 0.62 + fine * 0.2 * syl)
}

export function VoiceOrb({
  phase,
  level,
  muted,
  className,
}: {
  phase: VoicePhase
  level: number
  muted: boolean
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // El bucle rAF lee el estado por ref: sin re-crear el loop en cada render.
  const stateRef = useRef({ phase, level, muted })
  useEffect(() => {
    stateRef.current = { phase, level, muted }
  }, [phase, level, muted])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return

    let raf = 0
    let smooth = 0 // nivel suavizado para el anillo
    let glow = 0 // brillo ambiental suavizado

    const draw = (t: number) => {
      const { phase: ph, level: lv, muted: mu } = stateRef.current
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const size = canvas.clientWidth || 288
      if (canvas.width !== Math.round(size * dpr)) {
        canvas.width = Math.round(size * dpr)
        canvas.height = Math.round(size * dpr)
      }
      const c = size / 2
      const g = ctx2d
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, size, size)

      const speaking = ph === 'speaking'
      const listening = ph === 'listening' && !mu
      const thinking = ph === 'thinking'
      const connecting = ph === 'connecting' || ph === 'transcribing'
      const error = ph === 'error'
      const idle = ph === 'idle'

      // Amplitud objetivo según estado.
      const target = error ? 0.08 : speaking ? 0.78 : listening ? Math.min(1, lv) : thinking ? 0.16 : 0.1
      smooth += (target - smooth) * (target > smooth ? 0.28 : 0.08)
      const glowTarget = error ? 0.25 : speaking ? 0.6 + Math.sin(t * 0.005) * 0.18 : listening ? 0.35 + smooth * 0.45 : thinking ? 0.4 : 0.22
      glow += (glowTarget - glow) * 0.06

      // ── Resplandor ambiental ────────────────────────────────────────────
      const hue = error ? '248,113,113' : '52,211,153' // rojo / esmeralda
      const glowR = size * 0.5
      const rg = g.createRadialGradient(c, c, size * 0.06, c, c, glowR)
      rg.addColorStop(0, `rgba(${hue},${(0.16 * glow).toFixed(3)})`)
      rg.addColorStop(0.55, `rgba(${hue},${(0.07 * glow).toFixed(3)})`)
      rg.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = rg
      g.fillRect(0, 0, size, size)

      // ── Anillo de barras ────────────────────────────────────────────────
      const r0 = size * BASE_R
      const maxBar = size * MAX_BAR
      for (let i = 0; i < BARS; i++) {
        const ang = (i / BARS) * Math.PI * 2 - Math.PI / 2
        let amp: number
        if (speaking) amp = speakWave(i, t) * smooth
        else if (listening) amp = smooth * organic(i, t)
        else if (thinking) amp = 0.1 + 0.25 * Math.abs(Math.sin(t * 0.003 + i * 0.8))
        else if (connecting) amp = 0.08 + 0.2 * Math.abs(Math.sin(t * 0.006 + i * 1.2))
        else if (idle) amp = 0.05 + 0.06 * (0.5 + 0.5 * Math.sin(t * 0.0016 + i * 0.35))
        else amp = 0.05 // silenciado / error: barras planas
        const len = Math.max(2.5, amp * maxBar)
        const x0 = c + Math.cos(ang) * r0
        const y0 = c + Math.sin(ang) * r0
        const x1 = c + Math.cos(ang) * (r0 + len)
        const y1 = c + Math.sin(ang) * (r0 + len)
        const alpha = mu && !error ? 0.16 : 0.28 + amp * 0.65
        g.strokeStyle = error ? `rgba(248,113,113,${alpha.toFixed(3)})` : `rgba(52,211,153,${alpha.toFixed(3)})`
        g.lineWidth = size * 0.008
        g.lineCap = 'round'
        g.beginPath()
        g.moveTo(x0, y0)
        g.lineTo(x1, y1)
        g.stroke()
      }

      // ── Núcleo: disco oscuro con anillo fino ────────────────────────────
      const coreR = size * CORE_R * (1 + smooth * 0.05)
      const core = g.createRadialGradient(c - coreR * 0.35, c - coreR * 0.4, coreR * 0.1, c, c, coreR)
      if (error) {
        core.addColorStop(0, '#2a1012')
        core.addColorStop(1, '#120607')
      } else {
        core.addColorStop(0, '#131a19')
        core.addColorStop(1, '#070a0a')
      }
      g.fillStyle = core
      g.beginPath()
      g.arc(c, c, coreR, 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = speaking ? 'rgba(52,211,153,0.55)' : `rgba(185,192,201,${(0.22 + smooth * 0.4).toFixed(3)})`
      g.lineWidth = 1.4
      g.beginPath()
      g.arc(c, c, coreR, 0, Math.PI * 2)
      g.stroke()

      // ── Pensando: arco giratorio + satélites ────────────────────────────
      if (thinking || connecting) {
        g.save()
        g.translate(c, c)
        g.rotate(t * 0.0016)
        g.strokeStyle = 'rgba(52,211,153,0.5)'
        g.lineWidth = 1.6
        g.setLineDash([6, 10])
        g.beginPath()
        g.arc(0, 0, coreR + size * 0.028, 0, Math.PI * 2)
        g.stroke()
        g.setLineDash([])
        for (let k = 0; k < 3; k++) {
          const a = t * 0.0021 + (k * Math.PI * 2) / 3
          const r = coreR + size * 0.028
          g.fillStyle = 'rgba(110,231,183,0.85)'
          g.beginPath()
          g.arc(Math.cos(a) * r, Math.sin(a) * r, 2.2, 0, Math.PI * 2)
          g.fill()
        }
        g.restore()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className={cn('relative grid place-items-center', className)} aria-hidden>
      <canvas ref={canvasRef} className="size-full" />
      <OeLogo size="lg" animated={phase !== 'idle'} className="absolute scale-[0.62] drop-shadow-[0_0_18px_rgba(52,211,153,0.25)]" />
    </div>
  )
}
