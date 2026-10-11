'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, KeyRound, Loader2, Lock, RefreshCw, ServerCog, ShieldCheck, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface ProviderStatus {
  id: string
  label: string
  configured: boolean
  statusLabel: string
  capabilities: { chat: boolean; streaming: boolean; modelSelection: boolean }
  endpointStatus: string
  envVarNames: string[]
  note: string
  servesDefault: boolean
}

interface RouterInfo {
  mode: string
  fallbackAllowed: boolean
  defaultRouteLabel: string | null
}

interface OverviewData {
  usage: {
    total24h: number
    ok24h: number
    error24h: number
    avgLatencyMs24h: number | null
    byProvider: Array<{ providerId: string; total: number; errors: number; avgLatencyMs: number | null }>
    dailyLimit: number
  }
  providers: Array<{ id: string; label: string; configured: boolean; capabilities: ProviderStatus['capabilities']; endpointStatus: string; envVarNames: string[]; note: string }>
  recentChecks: Array<{ target: string; status: string; note: string | null; latencyMs: number | null; checkedAt: string }>
  config: Record<string, unknown>
}

function ConfiguredBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">Configurado</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Sin credenciales
    </Badge>
  )
}

/** Sección pública: estado de proveedores y del enrutador (sin secretos). */
export function SystemStatusSection() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [router, setRouter] = useState<RouterInfo | null>(null)
  const [publicApi, setPublicApi] = useState<{ enabled: boolean; status: string } | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    fetch('/api/providers')
      .then((r) => {
        if (!r.ok) throw new Error('fetch failed')
        return r.json()
      })
      .then((data: { providers: ProviderStatus[]; router: RouterInfo; publicApi: { enabled: boolean; status: string } }) => {
        setError(false)
        setProviders(data.providers)
        setRouter(data.router)
        setPublicApi(data.publicApi)
      })
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-primary" aria-hidden />
              Estado del sistema
            </CardTitle>
            <CardDescription>
              Proveedores registrados en OE AI LLM y su configuración detectada. Nunca se muestran valores de credenciales.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
            <RefreshCw className="size-3.5" aria-hidden />
            Actualizar
          </Button>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>No se pudo cargar el estado</AlertTitle>
              <AlertDescription>Inténtalo de nuevo en unos segundos.</AlertDescription>
            </Alert>
          )}
          {!error && providers === null && (
            <div className="flex flex-col gap-2">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}
          {!error && providers !== null && (
            <ul className="flex flex-col gap-2" role="list">
              {providers.map((p) => (
                <li key={p.id} className="rounded-lg border border-border/60 bg-card/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ServerCog className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{p.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <ConfiguredBadge configured={p.configured} />
                      <Badge variant="outline" className="text-muted-foreground">
                        {p.statusLabel}
                      </Badge>
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{p.note}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>Variables:</span>
                    {p.envVarNames.map((v) => (
                      <code key={v} className="rounded bg-secondary px-1.5 py-0.5 font-mono">
                        {v}
                      </code>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {!error && router !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="size-4 text-primary" aria-hidden />
              Enrutador OE AI LLM
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-sm">
            <Badge variant="outline">Modo: {router.mode === 'auto' ? 'automático' : 'solo manual'}</Badge>
            <Badge variant="outline">Fallback: {router.fallbackAllowed ? 'permitido (informado)' : 'desactivado'}</Badge>
            <Badge variant="outline">API pública: {publicApi?.enabled ? 'habilitada' : 'no habilitada (503 hasta configurar OE_AI_API_KEY)'}</Badge>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/** Panel de administración protegido por token (solo en servidor: OE_AI_ADMIN_TOKEN). */
export function AdminPanelSection() {
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)

  const [testProvider, setTestProvider] = useState('')
  const [testModel, setTestModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const loadOverview = useCallback(async (t: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/overview', { headers: { 'x-admin-token': t } })
      if (res.status === 503) {
        setEnabled(false)
        setOverview(null)
        return
      }
      setEnabled(true)
      if (res.status === 401) {
        setError('Token inválido. Comprueba OE_AI_ADMIN_TOKEN.')
        setOverview(null)
        return
      }
      if (!res.ok) throw new Error('fetch failed')
      setOverview((await res.json()) as OverviewData)
    } catch {
      setError('No se pudo cargar el panel. Inténtalo de nuevo.')
    } finally {
      setLoading(false)
    }
  }, [])

  async function runTest() {
    if (!testProvider) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/admin/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ providerId: testProvider, modelId: testModel.trim() || null }),
      })
      const data = (await res.json()) as { status?: string; latencyMs?: number | null; note?: string; error?: string }
      setTestResult(
        data.error
          ? `Error: ${data.error}`
          : `Comprobación registrada: ${data.status}${data.latencyMs != null ? ` · ${data.latencyMs} ms` : ''} · ${data.note ?? ''}`,
      )
      await loadOverview(token)
    } catch {
      setTestResult('Error al ejecutar la comprobación.')
    } finally {
      setTesting(false)
    }
  }

  if (!hasToken) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="size-4 text-primary" aria-hidden />
            Panel de administración
          </CardTitle>
          <CardDescription>
            Zona protegida para configuración, pruebas de conexión y métricas agregadas. Requiere el token del servidor
            (variable OE_AI_ADMIN_TOKEN). El token se mantiene solo en esta pestaña del navegador.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              setHasToken(true)
              void loadOverview(token)
            }}
          >
            <label htmlFor="admin-token" className="sr-only">
              Token de administración
            </label>
            <Input
              id="admin-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Token de administración"
              autoComplete="off"
              className="flex-1"
            />
            <Button type="submit" disabled={!token.trim()} className="gap-1.5">
              <KeyRound className="size-4" aria-hidden />
              Entrar
            </Button>
          </form>
          {enabled === false && (
            <Alert className="mt-3">
              <AlertTitle>Panel no habilitado</AlertTitle>
              <AlertDescription>
                Define <code className="rounded bg-secondary px-1 font-mono">OE_AI_ADMIN_TOKEN</code> en las variables de
                entorno del servidor para habilitar el panel.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-primary" aria-hidden />
              Métricas (últimas 24 h)
            </CardTitle>
            <CardDescription>Solo metadatos técnicos: nunca contenido de prompts ni respuestas.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => loadOverview(token)} className="gap-1.5" disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
            Actualizar
          </Button>
        </CardHeader>
        <CardContent>
          {loading && !overview && <Skeleton className="h-24 w-full" />}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
              <AlertDescription>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => setHasToken(false)}>
                  Volver a introducir token
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {overview && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Solicitudes', value: overview.usage.total24h },
                  { label: 'Exitosas', value: overview.usage.ok24h },
                  { label: 'Errores', value: overview.usage.error24h },
                  {
                    label: 'Latencia media',
                    value: overview.usage.avgLatencyMs24h != null ? `${overview.usage.avgLatencyMs24h} ms` : '—',
                  },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-border/60 bg-card/50 p-3">
                    <p className="text-2xl font-semibold tracking-tight">{s.value}</p>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Límite diario configurado: {overview.usage.dailyLimit} solicitudes.
              </p>

              <Separator className="my-4" />

              <h3 className="mb-2 text-sm font-semibold">Comprobaciones recientes</h3>
              {overview.recentChecks.length === 0 ? (
                <p className="text-xs text-muted-foreground">Sin comprobaciones registradas todavía.</p>
              ) : (
                <ul className="max-h-48 space-y-1.5 overflow-y-auto scrollbar-slim pr-1">
                  {overview.recentChecks.map((c) => (
                    <li key={`${c.target}-${c.checkedAt}`} className="rounded border border-border/50 bg-card/40 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono">{c.target}</code>
                        <Badge
                          variant="outline"
                          className={
                            c.status === 'ok'
                              ? 'border-emerald-500/30 text-emerald-300'
                              : c.status === 'error'
                                ? 'border-red-500/30 text-red-300'
                                : 'text-muted-foreground'
                          }
                        >
                          {c.status}
                        </Badge>
                        {c.latencyMs != null && <span className="text-muted-foreground">{c.latencyMs} ms</span>}
                      </div>
                      {c.note && <p className="mt-1 leading-relaxed text-muted-foreground">{c.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Probar conexión</CardTitle>
          <CardDescription>
            Ejecuta UNA comprobación real mínima y registra el resultado. Los modelos solo pasan a “Conectado” si su
            última comprobación fue exitosa.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground" htmlFor="test-provider">
                Proveedor
              </label>
              <Select value={testProvider} onValueChange={setTestProvider}>
                <SelectTrigger id="test-provider">
                  <SelectValue placeholder="Selecciona proveedor" />
                </SelectTrigger>
                <SelectContent>
                  {(overview?.providers ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.configured}>
                      {p.label} {p.configured ? '' : '(sin credenciales)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground" htmlFor="test-model">
                ID de modelo (opcional — vacío = predeterminado del proveedor)
              </label>
              <Input
                id="test-model"
                value={testModel}
                onChange={(e) => setTestModel(e.target.value)}
                placeholder="p. ej. meta-llama/Llama-3.1-8B-Instruct"
              />
            </div>
          </div>
          <Button onClick={runTest} disabled={!testProvider || testing} className="w-fit gap-1.5">
            {testing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Zap className="size-4" aria-hidden />}
            Ejecutar comprobación
          </Button>
          {testResult && (
            <Alert>
              <AlertDescription className="text-xs leading-relaxed">{testResult}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
