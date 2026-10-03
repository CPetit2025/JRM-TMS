'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { AlertTriangle, CalendarClock, Database, FileUp, GitBranch, Lock, Warehouse } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { aptApi } from '@/lib/apt/api'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'
import type { AptSettings } from '@/lib/apt/types'
import { AptFilterBar } from '@/components/apt/AptFilterBar'
import { FlowFilterBar } from '@/components/apt/FlowFilterBar'
import { LoadingBlock } from '@/components/apt/ui'

// Módulo APT — Control y estadía del inventario en el Almacén de Producto Terminado.
// Todo nace de ENTRADA y SALIDA (carga diaria); las pestañas comparten los filtros de la URL.

// Tres secciones para no concentrar todo en una sola vista: la estadía consolidada (FIFO de ENTRADA/SALIDA), el flujo
// entre almacenes (647 → ST VENTAS → cliente, con 540) y los datos (calidad y cargas).
const SECTIONS = [
  {
    key: 'estadia', label: 'Estadía APT', icon: Warehouse, desc: 'Permanencia consolidada del producto terminado (FIFO)',
    tabs: [
      { href: '/apt', label: 'Dashboard' },
      { href: '/apt/clientes', label: 'Cliente · OT · Lote' },
      { href: '/apt/detalle', label: 'Detalle APT' },
      { href: '/apt/productos', label: 'Productos y glosas' },
      { href: '/apt/pareto', label: 'Pareto' },
      { href: '/apt/heatmap', label: 'Mapa de calor' },
      { href: '/apt/fecha-entrega', label: 'FechaEntrega' },
      { href: '/apt/tendencias', label: 'Tendencias' },
    ],
  },
  {
    key: 'flujo', label: 'Flujo multi‑almacén', icon: GitBranch, desc: '647 · 540 · ST VENTAS → cliente, con trazabilidad por guía y lote',
    tabs: [
      { href: '/apt/flujo', label: 'Resumen del flujo' },
      { href: '/apt/flujo/almacenes', label: 'Stock por almacén' },
      { href: '/apt/flujo/etapas', label: 'Tiempos por etapa' },
      { href: '/apt/flujo/st-ventas', label: 'ST VENTAS' },
      { href: '/apt/flujo/adelantos', label: 'Adelantos y 540' },
      { href: '/apt/flujo/trazabilidad', label: 'Trazabilidad' },
      { href: '/apt/flujo/kardex', label: 'Kardex' },
    ],
  },
  {
    key: 'datos', label: 'Datos', icon: Database, desc: 'Calidad de la información y cargas diarias',
    tabs: [
      { href: '/apt/calidad', label: 'Calidad de datos' },
      { href: '/apt/cargas', label: 'Cargas y parámetros' },
    ],
  },
] as const
const NO_FILTERS = ['/apt/calidad', '/apt/cargas', '/apt/flujo/trazabilidad', '/apt/flujo/kardex']

function tabActive(href: string, pathname: string) {
  if (href === '/apt' || href === '/apt/flujo') return pathname === href
  return pathname.startsWith(href)
}

function sectionOf(pathname: string) {
  return SECTIONS.find(s => s.tabs.some(t => tabActive(t.href, pathname))) ?? SECTIONS[0]
}

function Tabs() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const current = sectionOf(pathname)
  // Cada sección conserva sus propios filtros: ?f= en la estadía, ?ff= en el flujo
  const withQs = (href: string, key: string) => {
    const param = key === 'flujo' ? 'ff' : key === 'estadia' ? 'f' : null
    const v = param ? searchParams.get(param) : null
    return v && !NO_FILTERS.includes(href) ? `${href}?${param}=${encodeURIComponent(v)}` : href
  }
  return (
    <div>
      <div className="flex gap-1 overflow-x-auto px-2 pt-2">
        {SECTIONS.map(s => {
          const active = s.key === current.key
          const Icon = s.icon
          return (
            <Link key={s.key} href={withQs(s.tabs[0].href, s.key)} title={s.desc}
              className={`flex items-center gap-2 whitespace-nowrap rounded-t-lg px-4 py-2 text-xs font-black uppercase tracking-wider transition-colors ${
                active ? 'bg-[#002855] text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <Icon className="h-3.5 w-3.5" /> {s.label}
            </Link>
          )
        })}
      </div>
      <nav className="-mb-px flex gap-1 overflow-x-auto border-t-2 border-[#002855] bg-slate-50/70 px-2">
        {current.tabs.map(t => {
          const active = tabActive(t.href, pathname)
          return (
            <Link key={t.href} href={withQs(t.href, current.key)}
              className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
                active ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>
              {t.label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

export default function AptLayout({ children }: { children: React.ReactNode }) {
  const { hasAccess, isLoaded } = usePermissions()
  const pathname = usePathname()
  const [info, setInfo] = useState<AptSettings | null>(null)
  const [secuenciaOk, setSecuenciaOk] = useState(true)
  const allowed = hasAccess('apt') || hasAccess('apt-carga')

  useEffect(() => {
    if (!allowed) return
    const load = () => {
      aptApi.settings().then(setInfo).catch(() => setInfo(null))
      aptApi.coverage().then(c => setSecuenciaOk(c.secuencia_ok)).catch(() => setSecuenciaOk(true))
    }
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
  const isFlow = pathname.startsWith('/apt/flujo')
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
              <p className="text-xs text-slate-500">647 ALM PT · 540 APT LB · ST VENTAS → cliente · Permanencia y trazabilidad por NumRel, producto y guía</p>
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
            {!secuenciaOk && (
              <Link href="/apt/cargas" className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 font-bold text-red-700 hover:bg-red-100">
                <AlertTriangle className="h-3.5 w-3.5" /> Secuencia de fechas incompleta
              </Link>
            )}
            {info?.can_load && (
              <Link href="/apt/cargas" className="flex items-center gap-1.5 rounded-lg bg-[#cf152d] px-3 py-1.5 font-bold text-white shadow-sm hover:bg-[#b01226]">
                <FileUp className="h-3.5 w-3.5" /> Cargar movimientos
              </Link>
            )}
          </div>
        </div>
        <div className="mt-3 border-t border-slate-100">
          <Suspense fallback={null}><Tabs /></Suspense>
        </div>
      </div>
      {showFilters && <Suspense fallback={null}>{isFlow ? <FlowFilterBar /> : <AptFilterBar />}</Suspense>}
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </div>
  )
}
