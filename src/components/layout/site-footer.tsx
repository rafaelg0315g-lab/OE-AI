export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <span className="font-medium text-foreground/80">OE AI</span> · producto de OE BUSINESS · OE AI LLM es el
          modelo unificado que coordina la red de 128 modelos; no es un modelo fundacional propio.
        </p>
        <p aria-label="Aviso de disponibilidad">
          La disponibilidad de los modelos depende del proveedor, las credenciales configuradas y el estado del servicio.
        </p>
      </div>
    </footer>
  )
}
