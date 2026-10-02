'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { CalendarClock, FileUp, Lock, Warehouse } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { aptApi } from '@/lib/apt/api'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'
import type { AptSettings } from '@/lib/apt/types'
import { AptFilterBar } from '@/components/apt/AptFilterBar'
import { LoadingBlock } from '@/components/apt/ui'

// Módulo APT — Control y estadía del inventario en el Almacén de Producto Terminado.
// Todo nace de ENTRADA y SALIDA (carga diaria); las pestañas comparten los filtros de la URL.

const TABS = [
  { href: '/apt', label: 'Dashboard' },
  { href: '/apt/detalle', label: 'Detalle APT' },
  { href: '/apt/productos', label: 'Productos y glosas' },
  { href: '/apt/pareto', label: 'Pareto' },
  { href: '/apt/heatmap', label: 'Mapa de calor' },
  { href: '/apt/fecha-entrega', label: 'FechaEntrega' },
  { href: '/apt/tendencias', label: 'Tendencias' },
  { href: '/apt/calidad', label: 'Calidad de datos' },
  { href: '/apt/cargas', label: 'Cargas y parámetros' },
]
const NO_FILTERS = ['/apt/calidad', '/apt/cargas']

function Tabs() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const f = searchParams.get('f')
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto">
      {TABS.map(t => {
        const active = t.href === '/apt' ? pathname === '/apt' : pathname.startsWith(t.href)
        const href = f && !NO_FILTERS.includes(t.href) ? `${t.href}?f=${encodeURIComponent(f)}` : t.href
        return (
          <Link key={t.href} href={href}
            className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
              active ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

export default function AptLayout({ children }: { children: React.ReactNode }) {
  const { hasAccess, isLoaded } = usePermissions()
  const pathname = usePathname()
  const [info, setInfo] = useState<AptSettings | null>(null)
  const allowed = hasAccess('apt') || hasAccess('apt-carga')

  useEffect(() => {
    if (!allowed) return
    const load = () => { aptApi.settings().then(setInfo).catch(() => setInfo(null)) }
    load()
    window.addEventListener('apt:updated', load)
    return () => window.removeEventListener('apt:updated', load)
  }, [allowed])

  if (!isLoaded) return <LoadingBlock label="Cargando…" />
  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-12 text-center">
        <Lock className="h-8 w-8 text-slate-300" />
        <p className="font-semibold text-slate-700">No tiene acceso al módulo APT</p>
        <p className="text-sm text-slate-500">Solicite el permiso “APT — Estadía de inventario” al administrador.</p>
      </div>
    )
  }

  const showFilters = !NO_FILTERS.some(p => pathname.startsWith(p))
  const st = info?.state
  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#002855] to-[#0b3d7a] text-white shadow">
              <Warehouse className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-slate-900">Control y estadía — Almacén de Producto Terminado</h1>
              <p className="text-xs text-slate-500">Bodega 647-04 ALM PT · Permanencia del inventario por NumRel, producto y glosa (FIFO)</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 rounded-lg border border-[#002855]/20 bg-[#002855]/5 px-3 py-1.5 font-semibold text-[#002855]">
              <CalendarClock className="h-3.5 w-3.5" /> Corte: {fmtDate(st?.cutoff)}
              {info?.settings.cutoff_date ? <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-700">manual</span> : null}
            </span>
            <span className="hidden rounded-lg border border-slate-200 px-3 py-1.5 text-slate-500 md:inline">
              Datos: {fmtDate(st?.data_min)} – {fmtDate(st?.data_max)}
            </span>
            {info?.last_upload && (
              <span className="hidden rounded-lg border border-slate-200 px-3 py-1.5 text-slate-500 lg:inline" title={info.last_upload.file_name}>
                Última carga: {fmtDateTime(info.last_upload.applied_at)}
              </span>
            )}
            {info?.can_load && (
              <Link href="/apt/cargas" className="flex items-center gap-1.5 rounded-lg bg-[#cf152d] px-3 py-1.5 font-bold text-white shadow-sm hover:bg-[#b01226]">
                <FileUp className="h-3.5 w-3.5" /> Cargar ENTRADA / SALIDA
              </Link>
            )}
          </div>
        </div>
        <div className="mt-3 border-t border-slate-100 px-3">
          <Suspense fallback={null}><Tabs /></Suspense>
        </div>
      </div>
      {showFilters && <Suspense fallback={null}><AptFilterBar /></Suspense>}
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </div>
  )
}
