'use client'

/**
 * Compuerta de cuota para invitados: 5 chats gratis por sesión de navegador.
 *
 * - GuestQuotaPill: contador discreto "X de 5" para usuarios sin sesión.
 * - GuestGateOverlay: cubre el composer cuando la cuota se agota y ofrece
 *   iniciar sesión con Google o GitHub (usuarios verificados: chats ilimitados).
 * - GuestGateDialog: aviso prominente que se abre una sola vez al agotarse.
 *
 * La cuota la aplica SIEMPRE el servidor (cookie de sesión oe_guest +
 * validación de token Supabase); la interfaz solo refleja ese estado.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Lock, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAuth } from '@/components/auth/auth-provider'
import { LoginButtons } from '@/components/auth/login-buttons'
import { cn } from '@/lib/utils'
import { useChat } from './chat-context'

/* ── Píldora de cuota (solo invitados) ─────────────────────────────────────── */

export function GuestQuotaPill({ className }: { className?: string }) {
  const chat = useChat()
  const { user } = useAuth()
  const quota = chat.guestQuota

  if (user || !quota) return null

  const critical = quota.remaining <= 1

  return (
    <div
      className={cn(
        'mx-auto flex w-fit items-center gap-2 rounded-full border border-border/60 bg-secondary/40 px-3.5 py-1.5 text-[12px] text-muted-foreground backdrop-blur',
        className,
      )}
      role="status"
      aria-label={`Chats gratis usados: ${quota.used} de ${quota.limit}. ${quota.remaining > 0 ? `Te quedan ${quota.remaining}.` : 'Cuota agotada: inicia sesión para continuar.'}`}
    >
      <Sparkles className={cn('size-3.5', critical ? 'text-amber-300' : 'text-emerald-300')} aria-hidden />
      <span>
        Chats gratis: <span className={cn('font-semibold text-foreground', critical && 'text-amber-200')}>{quota.used}</span>
        {' de '}
        {quota.limit} esta sesión
      </span>
      {/* Puntos de progreso */}
      <span className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: quota.limit }, (_, i) => (
          <span
            key={i}
            className={cn(
              'size-1.5 rounded-full transition-colors',
              i < quota.used ? 'bg-emerald-400' : 'bg-border',
            )}
          />
        ))}
      </span>
      {!quota.exhausted && (
        <span className="hidden sm:inline">· Inicia sesión para chats ilimitados</span>
      )}
    </div>
  )
}

/* ── Overlay del composer al agotarse la cuota ─────────────────────────────── */

export function GuestGateOverlay() {
  const chat = useChat()
  const { user, loading } = useAuth()
  const active = chat.guestBlocked && !user && !loading

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
          animate={{ opacity: 1, backdropFilter: 'blur(10px)' }}
          exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="absolute inset-0 z-20 flex items-center justify-center rounded-[28px] bg-background/60 p-3"
          role="alertdialog"
          aria-label="Cuota de chats gratis agotada"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border/70 bg-secondary/70 p-3.5 text-center shadow-[0_16px_60px_-20px_oklch(0_0_0/0.6)] sm:p-5">
            <div className="mx-auto hidden size-11 place-items-center rounded-full border border-amber-500/30 bg-amber-500/15 sm:grid">
              <Lock className="size-5 text-amber-300" aria-hidden />
            </div>
            <h3 className="text-[14px] font-semibold text-foreground sm:mt-3 sm:text-[15px]">Has usado tus 5 chats gratis</h3>
            <p className="mt-1 hidden text-[13px] leading-relaxed text-muted-foreground sm:block">
              Es la cuota de esta sesión. Inicia sesión con Google o GitHub para seguir conversando con OE AI LLM sin límite.
            </p>
            <div className="mt-2.5 flex justify-center sm:mt-4">
              <LoginButtons layout="block" />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/* ── Diálogo prominente (se abre una vez al agotarse la cuota) ─────────────── */

export function GuestGateDialog() {
  const chat = useChat()
  const { user } = useAuth()
  const [dismissed, setDismissed] = useState(false)
  const open = chat.guestBlocked && !user && !dismissed
  const announcedRef = useRef(false)

  // Aviso tipo toast una sola vez por sesión agotada (el diálogo es dismissible).
  useEffect(() => {
    if (open && !announcedRef.current) {
      announcedRef.current = true
      import('sonner').then(({ toast }) =>
        toast('Cuota de invitado agotada', {
          description: 'Usaste tus 5 chats gratis de esta sesión. Inicia sesión para continuar.',
        }),
      )
    }
    if (!open) announcedRef.current = false
  }, [open])

  // Al quedar liberada la compuerta (inicio de sesión) se permite volver a avisar.
  useEffect(() => {
    if (!chat.guestBlocked || user) setDismissed(false)
  }, [chat.guestBlocked, user])

  return (
    <Dialog open={open} onOpenChange={(next) => setDismissed(!next)}>
      <DialogContent className="max-w-md rounded-2xl border-border/70 bg-secondary/80 backdrop-blur-xl sm:rounded-2xl">
        <DialogHeader className="items-center text-center sm:text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-full border border-amber-500/30 bg-amber-500/15">
            <Lock className="size-5 text-amber-300" aria-hidden />
          </div>
          <DialogTitle className="text-lg">5 de 5 chats gratis usados</DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Cada sesión de navegador incluye 5 chats gratis con OE AI LLM. Inicia sesión con Google o GitHub para
            continuar sin límite: tu historial y tus herramientas (imágenes, búsqueda web) quedan disponibles igualmente.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center pb-1">
          <LoginButtons layout="block" />
        </div>
        <p className="text-center text-[11px] text-muted-foreground">
          La cuota se aplica por sesión de navegador y la verifica el servidor.
        </p>
      </DialogContent>
    </Dialog>
  )
}
