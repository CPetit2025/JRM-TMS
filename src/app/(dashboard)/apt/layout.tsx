'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Lock } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { LoadingBlock } from '@/components/apt/ui'
import { InvHeader } from '@/components/inventario/InvHeader'

// Almacén APT — inventario multi-almacén: un solo módulo con sus cuatro objetivos (stock disponible, estadía,
// trazabilidad y flujo) sobre el libro único de movimientos del ERP. Todas las cifras salen del mismo modelo.
const TABS = [
  { href: '/apt', label: 'Resumen' },
  { href: '/apt/stock', label: 'Stock disponible' },
  { href: '/apt/estadia', label: 'Estadía' },
  { href: '/apt/trazabilidad', label: 'Trazabilidad' },
  { href: '/apt/flujo', label: 'Flujo entre almacenes' },
  { href: '/apt/datos', label: 'Datos y verificación' },
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
  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <InvHeader />
        <nav aria-label="Secciones del inventario" className="mt-3 flex gap-1 overflow-x-auto border-t border-slate-100 px-2">
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
      </div>
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </div>
  )
}
