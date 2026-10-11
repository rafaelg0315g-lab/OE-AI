'use client'

/**
 * SettingsDialog — Ajustes de OE AI (Task 19-e).
 *
 * Secciones:
 * - Voz: voz ElevenLabs (10 premade verificadas) + velocidad 0.7-1.2 + prueba
 *   de voz real (POST /api/tools/tts → audio reproducido en el navegador).
 * - Traductor: modo intérprete del Modo Voz (TRANSLATOR_LANGS).
 * - Instrucciones: texto personal (≤2000) que la IA sigue en todos los chats.
 * - Memoria: datos que la IA recuerda del usuario (GET/POST/DELETE /api/memory;
 *   el backend también detecta frases "recuerda que…" automáticamente).
 *
 * Persistencia: voz/velocidad/traductor se guardan al instante con
 * saveOeSettings() (localStorage 'oe-settings'); las instrucciones usan botón
 * Guardar. Sin ThemeProvider de next-themes en el proyecto: no hay sección
 * Apariencia (la app es oscura por diseño).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Play, Plus, Settings2, Sparkles, Volume2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/components/auth/auth-provider'
import { readOeSettings, saveOeSettings } from '@/lib/settings'
import { ELEVEN_PREMADE_VOICES, TRANSLATOR_LANGS } from '@/lib/voices'

interface MemoryItem {
  id: string
  fact: string
  createdAt: string
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { getAccessToken } = useAuth()
  // Voz + traductor: persistencia inmediata (sin botón)
  const [voiceId, setVoiceId] = useState('')
  const [speed, setSpeed] = useState(1)
  const [translatorTarget, setTranslatorTarget] = useState('')
  // Instrucciones: borrador local + botón Guardar
  const [instructions, setInstructions] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)
  // Prueba de voz
  const [testingVoice, setTestingVoice] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Memoria
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryInput, setMemoryInput] = useState('')
  const [memoryBusy, setMemoryBusy] = useState(false)

  const authedFetch = useCallback(
    async (input: string, init?: RequestInit) => {
      const token = await getAccessToken().catch(() => null)
      return fetch(input, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
    },
    [getAccessToken],
  )

  const refreshMemory = useCallback(async () => {
    setMemoryLoading(true)
    try {
      const res = await authedFetch('/api/memory', { cache: 'no-store' })
      const data = (await res.json().catch(() => null)) as { items?: MemoryItem[] } | null
      setMemoryItems(res.ok && data?.items ? data.items : [])
    } catch {
      setMemoryItems([])
    } finally {
      setMemoryLoading(false)
    }
  }, [authedFetch])

  // Al abrir: lee los ajustes guardados y refresca la memoria.
  useEffect(() => {
    if (!open) return
    const s = readOeSettings()
    setVoiceId(s.voiceId)
    setSpeed(s.speed)
    setTranslatorTarget(s.translatorTarget)
    setInstructions(s.customInstructions)
    void refreshMemory()
  }, [open, refreshMemory])

  const voiceName = ELEVEN_PREMADE_VOICES.find((v) => v.id === voiceId)?.name ?? 'Sarah'

  function changeVoice(id: string) {
    const voice = ELEVEN_PREMADE_VOICES.find((v) => v.id === id)
    if (!voice) return
    setVoiceId(voice.id)
    saveOeSettings({ voiceId: voice.id, voiceName: voice.name })
  }

  function changeSpeed(values: number[]) {
    const raw = values[0] ?? 1
    // Slider step 0.05: se redondea para evitar valores intermedios del arrastre.
    const next = Math.min(1.2, Math.max(0.7, Math.round(raw * 20) / 20))
    setSpeed(next)
    saveOeSettings({ speed: next })
  }

  function changeTranslator(code: string) {
    setTranslatorTarget(code)
    saveOeSettings({ translatorTarget: code })
  }

  async function saveInstructions() {
    setSavingInstructions(true)
    try {
      saveOeSettings({ customInstructions: instructions.slice(0, 2000) })
      toast.success('Instrucciones guardadas', {
        description: 'La IA las seguirá en todos tus chats.',
      })
    } finally {
      setSavingInstructions(false)
    }
  }

  /** Prueba real de la voz: sintetiza una frase corta y la reproduce. */
  async function testVoice() {
    if (testingVoice) return
    setTestingVoice(true)
    try {
      const res = await fetch('/api/tools/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Hola, soy ${voiceName}. Así sueno yo.`,
          voiceId,
          speed,
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error ?? `No se pudo generar el audio de prueba (error ${res.status}).`)
      }
      const contentType = res.headers.get('Content-Type') ?? 'audio/mpeg'
      const blob = new Blob([await res.arrayBuffer()], { type: contentType })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (audioRef.current === audio) audioRef.current = null
      }
      await audio.play()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo reproducir la voz de prueba.')
    } finally {
      setTestingVoice(false)
    }
  }

  async function addMemory() {
    const fact = memoryInput.trim().slice(0, 300)
    if (!fact || memoryBusy) return
    setMemoryBusy(true)
    try {
      const res = await authedFetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) throw new Error(data?.error ?? 'No se pudo guardar el recuerdo.')
      setMemoryInput('')
      await refreshMemory()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar el recuerdo.')
    } finally {
      setMemoryBusy(false)
    }
  }

  async function deleteMemory(id: string) {
    try {
      const res = await authedFetch(`/api/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(data?.error ?? 'No se pudo borrar el recuerdo.')
      }
      setMemoryItems((prev) => prev.filter((m) => m.id !== id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo borrar el recuerdo.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden rounded-2xl border-border/70 bg-secondary/80 backdrop-blur-xl sm:max-w-lg sm:rounded-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings2 className="size-4 text-emerald-300" aria-hidden />
            Ajustes
          </DialogTitle>
          <DialogDescription>
            Voz, traductor, instrucciones y memoria. Los cambios se guardan en este navegador.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="voz" className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Lista de secciones: vertical en escritorio, horizontal en móvil */}
          <TabsList className="flex h-auto w-full shrink-0 flex-row overflow-x-auto sm:w-44 sm:flex-col sm:overflow-visible">
            <TabsTrigger value="voz" className="flex-1 justify-start gap-2 sm:justify-start">
              <Volume2 className="size-4 shrink-0" aria-hidden />
              Voz
            </TabsTrigger>
            <TabsTrigger value="traductor" className="flex-1 justify-start gap-2 sm:justify-start">
              <Sparkles className="size-4 shrink-0" aria-hidden />
              Traductor
            </TabsTrigger>
            <TabsTrigger value="instrucciones" className="flex-1 justify-start gap-2 sm:justify-start">
              <Settings2 className="size-4 shrink-0" aria-hidden />
              Instrucciones
            </TabsTrigger>
            <TabsTrigger value="memoria" className="flex-1 justify-start gap-2 sm:justify-start">
              <Plus className="size-4 shrink-0" aria-hidden />
              Memoria
            </TabsTrigger>
          </TabsList>

          <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto pr-0.5">
            {/* ── Voz ── */}
            <TabsContent value="voz" className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="settings-voice">Voz del modo hablado</Label>
                <Select value={voiceId} onValueChange={changeVoice}>
                  <SelectTrigger id="settings-voice" className="w-full bg-background/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ELEVEN_PREMADE_VOICES.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="settings-speed">Velocidad</Label>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground" aria-live="polite">
                    {speed.toFixed(2)}x
                  </span>
                </div>
                <Slider
                  id="settings-speed"
                  value={[speed]}
                  min={0.7}
                  max={1.2}
                  step={0.05}
                  onValueChange={changeSpeed}
                  aria-label="Velocidad de la voz"
                />
                <div className="flex justify-between font-mono text-[10px] text-muted-foreground" aria-hidden>
                  <span>0.70x</span>
                  <span>1.20x</span>
                </div>
              </div>

              <Button
                variant="outline"
                onClick={() => void testVoice()}
                disabled={testingVoice}
                className="gap-2 border-border/60 bg-background/40"
              >
                {testingVoice ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Generando audio…
                  </>
                ) : (
                  <>
                    <Play className="size-4" aria-hidden />
                    Probar voz
                  </>
                )}
              </Button>
            </TabsContent>

            {/* ── Traductor ── */}
            <TabsContent value="traductor" className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="settings-translator">Idioma destino (Modo Voz)</Label>
                <Select
                  value={translatorTarget || 'off'}
                  onValueChange={(code) => changeTranslator(code === 'off' ? '' : code)}
                >
                  <SelectTrigger id="settings-translator" className="w-full bg-background/60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Radix Select no admite value="" en los ítems: «Desactivado»
                        usa el sentinel 'off' y se mapea de vuelta a ''. */}
                    {TRANSLATOR_LANGS.map((l) => (
                      <SelectItem key={l.code || 'off'} value={l.code || 'off'}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">
                En Modo Voz, la IA traducirá lo que digas al idioma elegido. Con «Desactivado» conversa normal en
                español.
              </p>
            </TabsContent>

            {/* ── Instrucciones ── */}
            <TabsContent value="instrucciones" className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="settings-instructions">Instrucciones personales</Label>
                <Textarea
                  id="settings-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value.slice(0, 2000))}
                  placeholder="Ej: Responde siempre en español neutro y sé breve. Llámame por mi nombre."
                  rows={6}
                  className="resize-none bg-background/60"
                />
                <span className="self-end font-mono text-[10px] text-muted-foreground" aria-live="polite">
                  {instructions.length}/2000
                </span>
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                La IA seguirá estas instrucciones en todos tus chats.
              </p>
              <Button
                onClick={() => void saveInstructions()}
                disabled={savingInstructions}
                className="gap-2 self-start bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500"
              >
                {savingInstructions ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Guardando…
                  </>
                ) : (
                  'Guardar'
                )}
              </Button>
            </TabsContent>

            {/* ── Memoria ── */}
            <TabsContent value="memoria" className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  value={memoryInput}
                  onChange={(e) => setMemoryInput(e.target.value.slice(0, 300))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void addMemory()
                    }
                  }}
                  placeholder="Añadir recuerdo…"
                  aria-label="Añadir recuerdo"
                  className="bg-background/60"
                  maxLength={300}
                />
                <Button
                  onClick={() => void addMemory()}
                  disabled={memoryBusy || memoryInput.trim().length === 0}
                  className="shrink-0 gap-1.5 bg-gradient-to-br from-emerald-400 to-teal-600 text-emerald-950 hover:from-emerald-300 hover:to-teal-500"
                >
                  {memoryBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                  Añadir
                </Button>
              </div>

              {memoryLoading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-emerald-300" aria-hidden />
                  Cargando memoria…
                </div>
              ) : memoryItems.length === 0 ? (
                <p className="rounded-xl border border-border/60 bg-background/40 px-3 py-3 text-[13px] leading-relaxed text-muted-foreground">
                  Todavía no recuerdo nada sobre ti. Dime cosas como «Recuérdame que trabajo en OE».
                </p>
              ) : (
                <div className="scrollbar-slim max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-background/30">
                  <ul className="flex flex-col gap-1 p-2">
                    {memoryItems.map((item) => (
                      <li
                        key={item.id}
                        className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-snug transition-colors hover:bg-accent/60"
                      >
                        <span className="min-w-0 flex-1 break-words">{item.fact}</span>
                        <button
                          type="button"
                          onClick={() => void deleteMemory(item.id)}
                          aria-label={`Olvidar: ${item.fact}`}
                          title="Olvidar"
                          className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                El backend también detecta automáticamente frases tipo «recuerda que…» en tus mensajes.
              </p>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
