import type { Metadata } from 'next'
import { SiteHeader } from '@/components/layout/site-header'
import { SiteFooter } from '@/components/layout/site-footer'
import { ApiCenter } from '@/components/apis/api-center'

export const metadata: Metadata = {
  title: 'OE AI APIs — Catálogo multimodelo de OE AI LLM',
  description:
    'Descubre los modelos que forman parte del catálogo de OE AI LLM, conoce para qué se utilizan y consulta el estado de conexión de cada integración. Búsqueda, filtros y documentación para desarrolladores.',
  alternates: { canonical: '/apis' },
  openGraph: {
    title: 'OE AI APIs — Un ecosistema multimodelo. Una sola plataforma.',
    description:
      'Catálogo consultable de 128 modelos con estados de integración reales, proveedores y documentación de OE AI LLM.',
    type: 'website',
  },
}

/** Página pública /apis — mismo sistema visual de OE AI, contenido informativo. */
export default function ApisPage() {
  return (
    <>
      <SiteHeader embedded={false} />
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <ApiCenter />
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
