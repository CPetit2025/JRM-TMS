'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Lock } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { LoadingBlock } from '@/components/apt/ui'
import { InvHeader } from '@/components/inventario/InvHeader'
import { AmbitoSwitch } from '@/components/inventario/ambito'

// Almacén APT — inventario multi-almacén: un solo módulo con sus cuatro objetivos (stock disponible, estadía,
// trazabilidad y flujo) sobre el libro único de movimientos del ERP. Todas las cifras salen del mismo modelo.
// Por defecto se mira el APT (647 · 540 · ST); «Todas las bodegas» sirve para seguir un lote fuera del APT.
const TABS = [
  { href: '/apt', label: 'Resumen' },
  { href: '/apt/contratos', label: 'Contratos / OT' },
  { href: '/apt/stock', label: 'Stock disponible' },
  { href: '/apt/estadia', label: 'Estadía' },
  { href: '/apt/trazabilidad', label: 'Trazabilidad' },
  { href: '/apt/flujo', label: 'Flujo entre almacenes' },
  { href: '/apt/datos', label: 'Datos y verificación' },
  { href: '/apt/analitica', label: 'Analítica APT y Distribución' },
] as const

export default function AptLayout({ children }: { children: React.ReactNode }) {
  const { hasAccess, isLoaded } = usePermissions()
  const pathname = usePathname()
  const allowed = hasAccess('apt') || hasAccess('apt-carga')

  if (!isLoaded) return <LoadingBlock label="Cargando…" />
  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-12 text-center">
        <Lock className="h-8 w-8 text-slate-300" />
        <p className="font-semibold text-slate-700">No tiene acceso al inventario</p>
        <p className="text-sm text-slate-500">Solicite el permiso «APT — Estadía de inventario» al administrador.</p>
      </div>
    )
  }
  // La analítica tiene su propio encabezado, filtros y pestañas (no usa el ámbito del inventario)
  if (pathname.startsWith('/apt/analitica')) {
    return (
      <div className="space-y-3 pb-10">
        <nav aria-label="Almacén APT" className="flex flex-wrap items-center gap-2 text-xs">
          <Link href="/apt" className="font-semibold text-[#002855] hover:underline">← Inventario multi‑almacén</Link>
        </nav>
        <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
      </div>
    )
  }
  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <InvHeader />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pr-3">
        <nav aria-label="Secciones del inventario" className="flex gap-1 overflow-x-auto px-2">
          {TABS.map(t => {
            const active = t.href === '/apt' ? pathname === '/apt' : pathname.startsWith(t.href)
            return (
              <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                  active ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>
                {t.label}
              </Link>
            )
          })}
        </nav>
        <div className="py-1.5 pl-2"><AmbitoSwitch /></div>
        </div>
      </div>
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </div>
  )
}
