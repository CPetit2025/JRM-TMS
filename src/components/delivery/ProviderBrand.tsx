import Image from 'next/image'
import { ShieldCheck } from 'lucide-react'

export function ProviderBrand() {
  return <header className="border-t-4 border-[#cf152d] bg-[#002855] text-white">
    <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <Image src="/logo-jrm.png" alt="JRM · Soluciones integrales de almacenamiento" width={600} height={235} priority className="h-auto w-40 sm:w-48" />
      <div className="text-right"><p className="text-[11px] font-semibold tracking-[0.16em] text-blue-200">GERENCIA DE LOGÍSTICA</p><p className="mt-1 text-sm font-bold sm:text-base">Portal de transportistas</p></div>
    </div>
  </header>
}

export function ProviderFooter() {
  return <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-slate-500 sm:px-8">
    <p>JRM S.A.C. · Torre de Control TMS</p><p className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" />Acceso exclusivo al servicio asignado</p>
  </footer>
}
