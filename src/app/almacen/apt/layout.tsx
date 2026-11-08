'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Lock } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { LoadingBlock } from '@/components/apt/ui'
import { InvHeader } from '@/components/inventario/InvHeader'
import { AmbitoSwitch } from '@/components/inventario/ambito'

// Almacén APT en el WMS (fase 4 de docs/plan-wms-inventario-apt.md): el modelo de almacén vive en la base WMS y se
// alimenta con las cargas del ERP de Control › Stock ERP. Las cargas se hacen allí, por eso no hay pestaña de datos.
const BASE = '/almacen/apt'
const TABS = [
  { href: BASE, label: 'Resumen' },
  { href: `${BASE}/contratos`, label: 'Contratos / OT' },
  { href: `${BASE}/stock`, label: 'Stock disponible' },
  { href: `${BASE}/estadia`, label: 'Estadía' },
  { href: `${BASE}/trazabilidad`, label: 'Trazabilidad' },
  { href: `${BASE}/flujo`, label: 'Flujo entre almacenes' },
  { href: `${BASE}/erp`, label: 'ERP: OT, guías y stock' },
  { href: `${BASE}/analitica`, label: 'Analítica APT y Distribución' },
] as const
// Recepción (ingresos y control de etiquetas) usa estas rutas sin el encabezado del inventario
const RECEIPT = [`${BASE}/etiquetado`, `${BASE}/etiquetas-impresas`]
const VIEW = ['almacen-lectura', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor', 'almacen-auditoria', 'almacen-etiquetado']

export default function AptLayout({ children }: { children: React.ReactNode }) {
  const { hasAccess, isLoaded } = usePermissions()
  const pathname = usePathname() || ''
  if (RECEIPT.includes(pathname)) return <>{children}</>
  if (!isLoaded) return <LoadingBlock label="Cargando…" />
  if (!VIEW.some(hasAccess)) {
    return <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-12 text-center">
      <Lock className="h-8 w-8 text-slate-300" />
      <p className="font-semibold text-slate-700">No tiene acceso al inventario del almacén</p>
    </div>
  }
  // El APT clásico trae su propio encabezado, pestañas y filtros
  if (pathname.startsWith(`${BASE}/clasico`)) return <>{children}</>
  if (pathname.startsWith(`${BASE}/analitica`)) {
    return <div className="space-y-3 pb-10">
      <nav aria-label="Almacén APT" className="flex flex-wrap items-center gap-2 text-xs">
        <Link href={BASE} className="font-semibold text-[#002855] hover:underline">← Inventario multi‑almacén</Link>
      </nav>
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </div>
  }
  return <div className="space-y-4 pb-10">
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <InvHeader />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pr-3">
        <nav aria-label="Secciones del inventario" className="flex gap-1 overflow-x-auto px-2">
          {TABS.map(t => {
            const active = t.href === BASE ? pathname === BASE : pathname.startsWith(t.href)
            return <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                active ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>{t.label}</Link>
          })}
        </nav>
        <div className="py-1.5 pl-2"><AmbitoSwitch /></div>
      </div>
    </div>
    <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
  </div>
}
