'use client'

/**
 * Placeholder "aurora de puntos" (estilo ChatGPT) mientras se genera un video:
 * fondo oscuro con auroras difusas en movimiento (esmeralda/teal/violeta),
 * rejilla de puntos que se enciende al paso de las auroras, viñeta suave y
 * temporizador honesto de espera. Formato vertical 9:16, acorde al video
 * narrado tipo story que produce JSON2Video.
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Clapperboard } from 'lucide-react'

const DOTS = 'radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1.45px)'

function stageLabel(seconds: number): string {
  if (seconds < 25) return 'Preparando escenas'
  if (seconds < 70) return 'Creando imágenes IA'
  if (seconds < 120) return 'Narrando con voz IA'
  return 'Renderizando el video'
}

export function VideoPendingPlaceholder() {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const stage = stageLabel(seconds)

  return (
    <div
      role="status"
      aria-label={`Generando video: ${stage}. ${seconds} segundos transcurridos.`}
      className="relative aspect-[9/16] w-full max-w-[270px] overflow-hidden rounded-2xl border border-border/60 bg-[#04070b]"
    >
      {/* Auroras difusas en movimiento */}
      <motion.div
        aria-hidden
        className="absolute -left-1/4 -top-1/4 size-[85%] rounded-full bg-emerald-500/50 blur-3xl"
        animate={{ x: ['0%', '38%', '12%', '0%'], y: ['0%', '22%', '48%', '0%'], scale: [1, 1.18, 0.92, 1] }}
        transition={{ duration: 13, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        aria-hidden
        className="absolute -bottom-1/4 -right-1/5 size-[80%] rounded-full bg-teal-400/40 blur-3xl"
        animate={{ x: ['0%', '-30%', '-8%', '0%'], y: ['0%', '-26%', '10%', '0%'], scale: [1, 1.22, 0.95, 1] }}
        transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut', delay: 1.2 }}
      />
      <motion.div
        aria-hidden
        className="absolute left-1/4 top-1/3 size-[65%] rounded-full bg-violet-500/35 blur-3xl"
        animate={{ x: ['0%', '24%', '-20%', '0%'], y: ['0%', '-18%', '22%', '0%'] }}
        transition={{ duration: 19, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }}
      />

      {/* Aurora de puntos: rejilla que se enciende al paso de las auroras */}
      <div aria-hidden className="absolute inset-0 mix-blend-overlay" style={{ backgroundImage: DOTS, backgroundSize: '13px 13px' }} />
      <div
        aria-hidden
        className="oe-aurora-dots absolute inset-0 opacity-40 mix-blend-screen"
        style={{ backgroundImage: DOTS, backgroundSize: '13px 13px', animation: 'oe-aurora-drift 22s linear infinite' }}
      />

      {/* Viñeta suave hacia los bordes */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: 'radial-gradient(120% 90% at 50% 42%, transparent 40%, rgba(0,0,0,0.55) 100%)' }}
      />

      {/* Contenido central */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-4 text-center">
        <motion.span
          className="grid size-12 place-items-center rounded-2xl border border-white/15 bg-white/10 backdrop-blur-sm"
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Clapperboard className="size-6 text-emerald-200" aria-hidden />
        </motion.span>
        <span className="oe-shimmer text-sm font-semibold">Generando video</span>
        <span className="text-xs text-white/60">{stage}…</span>
        <span className="font-mono text-[11px] tabular-nums text-white/45">
          {seconds} s · voz IA + subtítulos
        </span>
      </div>
    </div>
  )
}
