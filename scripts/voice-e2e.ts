/**
 * Prueba E2E del modo dictado: voice:audio (PCM16 16 kHz) -> voice:utterance-end
 * -> ElevenLabs Scribe -> runTurn (LLM) -> TTS. Verifica la cadena completa.
 */
import { io } from 'socket.io-client'
import { readFileSync } from 'fs'

const pcm = readFileSync('/tmp/es-test.pcm')
const CHUNK = 3200 // 100 ms a 16 kHz PCM16 mono
const socket = io('http://localhost:3010', { transports: ['websocket'], forceNew: true })

let audioBytes = 0
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

socket.on('connect', () => {
  console.log(`${at()} conectado (${socket.id})`)
  socket.emit('voice:start', { sampleRate: 16000 })
  socket.emit('voice:dictation', { active: true })
  let off = 0
  const timer = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(timer)
      socket.emit('voice:utterance-end', { text: '' }) // sin texto del navegador: Scribe hace el trabajo
      console.log(`${at()} utterance-end enviado (esperando Scribe + LLM + TTS)`)
      setTimeout(() => {
        console.log(`${at()} fin de la prueba`)
        socket.disconnect()
        process.exit(0)
      }, 25000)
      return
    }
    const slice = pcm.subarray(off, Math.min(off + CHUNK, pcm.length))
    off += CHUNK
    socket.emit('voice:audio', { b64: slice.toString('base64'), rms: 0.06 })
  }, 100)
})

socket.on('voice:status', (d) => console.log(`${at()} status: ${d.phase} (turn=${d.turnId})`))
socket.on('voice:user-transcript', (d) => console.log(`${at()} TRANSCRIPCION FINAL: "${d.text}"`))
socket.on('voice:assistant-delta', (d) => process.stdout.write(d.text))
socket.on('voice:tts-chunk', (d) => { audioBytes += d.b64.length })
socket.on('voice:tts-sentence', (d) => console.log(`\n${at()} TTS frase sid=${d.sid} (${d.provider}, ${d.mime})`))
socket.on('voice:assistant-done', (d) => console.log(`\n${at()} RESPUESTA: ${(d.text ?? '').slice(0, 160)}`))
socket.on('voice:no-audio', (d) => console.log(`${at()} AVISO no-audio (voz local narraria) turn=${d.turnId}`))
socket.on('voice:notice', (d) => console.log(`${at()} notice: ${d.message}`))
socket.on('voice:error', (d) => console.log(`${at()} ERROR: ${d.message}`))
socket.on('disconnect', () => console.log(`${at()} desconectado`))
setTimeout(() => socket.disconnect(), 40000)
