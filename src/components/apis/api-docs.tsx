/**
 * Documentación para desarrolladoras y desarrolladores del Centro de APIs (/apis).
 * Todo el contenido es informativo y honesto: lo que aún no existe se marca
 * explícitamente como «Planificado». Sin secretos, solo nombres de variables.
 */
import { Info } from 'lucide-react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatusBadge } from './status-badge'
import { STATUS_LABELS_ES } from './types'

/** Solo NOMBRES de variables; nunca se publican valores reales. */
const ENV_VAR_NAMES = [
  'AI_DEFAULT_PROVIDER',
  'AI_DEFAULT_MODEL',
  'AI_ROUTER_MODE',
  'AI_FALLBACK_ALLOWED',
  'AI_MAX_DAILY_REQUESTS',
  'AI_CHAT_RPM',
  'AI_API_RPM',
  'OE_AI_MODEL_ROUTES',
  'OE_AI_ADMIN_TOKEN',
  'OE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'NOVITA_API_KEY',
  'CEREBRAS_API_KEY',
  'OVHCLOUD_API_KEY',
  'DEEPINFRA_API_KEY',
  'FIREWORKS_API_KEY',
  'BASETEN_API_KEY',
  'TOGETHER_API_KEY',
  'ZAI_API_KEY',
  'NSCALE_API_KEY',
  'GROQ_API_KEY',
  'SCALEWAY_API_KEY',
  'PUBLICAI_API_KEY',
  'COHERE_API_KEY',
] as const

const CURL_EXAMPLE = `curl -X POST "https://tu-dominio/api/v1/chat/completions" \\
  -H "Authorization: Bearer $OE_AI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Hola"}],"stream":false}'`

interface EndpointRow {
  route: string
  operational: boolean
  note: string
}

const ENDPOINT_ROWS: EndpointRow[] = [
  {
    route: 'GET /api/models',
    operational: true,
    note: 'Catálogo completo con estados y contadores reales.',
  },
  {
    route: 'GET /api/models/{id}',
    operational: true,
    note: 'Detalle de un modelo; el identificador va codificado en la URL (encodeURIComponent).',
  },
  {
    route: 'GET /api/providers',
    operational: true,
    note: 'Proveedores registrados, capacidades y variables requeridas; nunca valores.',
  },
  {
    route: 'POST /api/chat',
    operational: true,
    note: 'Transporte SSE; streaming real de tokens cuando la ruta resuelta tiene streaming verificado (p. ej. OpenRouter).',
  },
  {
    route: 'POST /api/v1/chat/completions',
    operational: true,
    note: 'API pública; requiere OE_AI_API_KEY configurada en el servidor. Admite "stream": true con proveedores verificados.',
  },
  {
    route: 'Streaming de tokens',
    operational: true,
    note: 'Verificado con pruebas reales vía OpenRouter (SSE: deltas + [DONE]). El resto de proveedores continúa en verificación y se rechaza con honestidad.',
  },
  {
    route: 'Panel de claves API autoservicio',
    operational: false,
    note: 'Gestión de claves propias por el usuario final; hoy no implementado.',
  },
  {
    route: 'Comprobaciones programadas de salud',
    operational: false,
    note: 'Salud automática periódica de proveedores y modelos; hoy bajo demanda.',
  },
]

const STATUS_MEANINGS: Array<{ status: keyof typeof STATUS_LABELS_ES; meaning: string }> = [
  { status: 'connected', meaning: 'Comprobación real superada.' },
  { status: 'available_with_config', meaning: 'Adaptador listo; faltan credenciales.' },
  { status: 'not_verified', meaning: 'En catálogo, sin comprobación individual.' },
  { status: 'temporarily_unavailable', meaning: 'La última comprobación falló.' },
  { status: 'planned', meaning: 'Aún no implementado.' },
  { status: 'needs_review', meaning: 'Posible ID inexistente o cambiado.' },
]

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  )
}

function DocParagraph({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
}

export function ApiDocs() {
  return (
    <section aria-labelledby="api-docs-heading">
      <h2 id="api-docs-heading" className="text-xl font-semibold tracking-tight sm:text-2xl">
        Documentación de la API
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Referencia práctica de la integración, la autenticación y los endpoints disponibles hoy.
      </p>

      <Accordion
        type="multiple"
        defaultValue={['api-integracion']}
        className="mt-4 rounded-xl border border-border/60 bg-card px-4 py-1 sm:px-6"
      >
        {/* Integración de modelos */}
        <AccordionItem value="api-integracion">
          <AccordionTrigger>Integración de modelos</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <DocParagraph>
              Los modelos se integran mediante adaptadores del lado del servidor (
              <Code>AIProviderAdapter</Code>). Cada adaptador encapsula las particularidades de un
              proveedor: autenticación, formato de las peticiones y normalización de las
              respuestas hacia un contrato común.
            </DocParagraph>
            <DocParagraph>
              El cliente nunca toca credenciales de proveedor: todas las claves viven en el
              entorno del servidor y no se exponen en ninguna respuesta pública de la API.
            </DocParagraph>
            <DocParagraph>
              La URL base y la autenticación de cada proveedor son configurables por entorno, de
              modo que se pueden añadir o sustituir proveedores sin cambiar el código del cliente.
            </DocParagraph>
          </AccordionContent>
        </AccordionItem>

        {/* Autenticación y límites */}
        <AccordionItem value="api-auth">
          <AccordionTrigger>Autenticación y límites</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <DocParagraph>
              La API pública está disponible en <Code>POST /api/v1/chat/completions</Code> y se
              autentica con la cabecera <Code>Authorization: Bearer</Code> usando la clave
              configurada en la variable de servidor <Code>OE_AI_API_KEY</Code>.
            </DocParagraph>
            <DocParagraph>
              Existen límites de tasa por minuto y un límite diario de solicitudes. Cada respuesta
              incluye <Code>X-Request-Id</Code>, útil como referencia al contactar con soporte.
            </DocParagraph>
            <Alert className="border-amber-500/40 bg-amber-500/10">
              <Info className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
              <AlertTitle className="text-amber-700 dark:text-amber-200">
                Estado actual de la API pública
              </AlertTitle>
              <AlertDescription className="text-amber-800/90 dark:text-amber-200/80">
                La API pública devuelve <Code>503</Code> con error <Code>api_not_enabled</Code>{' '}
                mientras no exista <Code>OE_AI_API_KEY</Code> en el servidor; el catálogo de /apis
                funciona de forma informativa con independencia de la API.
              </AlertDescription>
            </Alert>
          </AccordionContent>
        </AccordionItem>

        {/* Endpoints */}
        <AccordionItem value="api-endpoints">
          <AccordionTrigger>Endpoints</AccordionTrigger>
          <AccordionContent>
            <div className="overflow-x-auto scrollbar-slim">
              <Table>
                <TableCaption className="sr-only">
                  Endpoints disponibles y planificados de OE AI
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-0">Método y ruta</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="min-w-0">Notas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ENDPOINT_ROWS.map((row) => (
                    <TableRow key={row.route}>
                      <TableCell className="whitespace-normal font-mono text-xs">
                        {row.route}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={row.operational ? 'connected' : 'planned'}
                          label={row.operational ? 'Operativo' : 'Planificado'}
                        />
                      </TableCell>
                      <TableCell className="whitespace-normal text-xs text-muted-foreground">
                        {row.note}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Variables de entorno */}
        <AccordionItem value="api-env">
          <AccordionTrigger>Variables de entorno</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground/90 scrollbar-slim">
              {ENV_VAR_NAMES.join('\n')}
            </pre>
            <p className="text-xs text-muted-foreground">
              Solo nombres; nunca publiques valores reales.
            </p>
          </AccordionContent>
        </AccordionItem>

        {/* Cómo interpretar los estados */}
        <AccordionItem value="api-estados">
          <AccordionTrigger>Cómo interpretar los estados</AccordionTrigger>
          <AccordionContent>
            <ul className="space-y-2.5">
              {STATUS_MEANINGS.map(({ status, meaning }) => (
                <li key={status} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={status} label={STATUS_LABELS_ES[status]} />
                  <span className="text-sm text-muted-foreground">{meaning}</span>
                </li>
              ))}
            </ul>
          </AccordionContent>
        </AccordionItem>

        {/* Ejemplo de llamada */}
        <AccordionItem value="api-ejemplo">
          <AccordionTrigger>Ejemplo de llamada</AccordionTrigger>
          <AccordionContent className="space-y-3">
            <DocParagraph>
              Llamada a la API pública con autenticación Bearer y el enrutador en modo{' '}
              <Code>auto</Code>:
            </DocParagraph>
            <pre className="overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground/90 scrollbar-slim">
              {CURL_EXAMPLE}
            </pre>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  )
}
