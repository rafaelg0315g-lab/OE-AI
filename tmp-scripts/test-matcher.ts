import { shouldAttachBuilderDirective } from '../src/lib/ai/builder-directive'
const cases: Array<[string, boolean]> = [
  ['crea una app de tareas', true],
  ['hazme una página web para mi barbería', true],
  ['quiero un juego de snake', true],
  ['construye un dashboard de ventas fullstack', true],
  ['dame el código de una función que sume', false],
  ['¿cómo creo una app en react?', false],
  ['¿qué es un parámetro?', false],
  ['explícame qué es fullstack', false],
  ['arregla este bug en mi función', false],
  ['necesito una app para gestionar inventario', true],
  ['hola', false],
]
let pass = 0
for (const [msg, expected] of cases) {
  const got = shouldAttachBuilderDirective(msg)
  const ok = got === expected
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'} · "${msg}" → ${got} (esperado ${expected})`)
}
console.log(`${pass}/${cases.length}`)
