'use client'

import { Suspense, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CalendarRange, Gauge, Lock, RotateCcw } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { LoadingBlock } from '@/components/apt/ui'

// Módulo Eficiencia de Flota: costo, uso y reemplazo de unidades de transporte, montacargas y equipos de elevación.
// Historia cargada desde Excel y, desde el corte de cada fuente, datos de los módulos del TMS (mantenimiento, Caja,
// despachos y guías). El periodo de análisis vive en la URL (?d=AAAA-MM&h=AAAA-MM) y lo comparten todas las pestañas.

const TABS = [
  { href: '/eficiencia-flota', label: 'Resumen y decisiones' },
  { href: '/eficiencia-flota/transporte', label: 'Unidades de transporte' },
  { href: '/eficiencia-flota/equipos', label: 'Montacargas y elevación' },
  { href: '/eficiencia-flota/rutas', label: 'Rutas y carga' },
  { href: '/eficiencia-flota/recambios', label: 'Recambios' },
  { href: '/eficiencia-flota/datos', label: 'Datos y parámetros' },
]
const active = (href: string, p: string) => (href === '/eficiencia-flota' ? p === href : p.startsWith(href))

function Periodo() {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [d, setD] = useState(sp.get('d') || '')
  const [h, setH] = useState(sp.get('h') || '')
  const apply = (e?: FormEvent, nd = d, nh = h) => {
    e?.preventDefault()
    const qs = new URLSearchParams(sp.toString())
    if (nd) qs.set('d', nd); else qs.delete('d')
    if (nh) qs.set('h', nh); else qs.delete('h')
    router.replace(qs.toString() ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
  return (
    <form onSubmit={apply} className="flex flex-wrap items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5 font-bold text-slate-500"><CalendarRange className="h-4 w-4" /> Periodo</span>
      <label className="flex items-center gap-1">Desde <input type="month" value={d} onChange={e => setD(e.target.value)} className="h-8 rounded-lg border border-slate-200 px-2" aria-label="Desde" /></label>
      <label className="flex items-center gap-1">Hasta <input type="month" value={h} onChange={e => setH(e.target.value)} className="h-8 rounded-lg border border-slate-200 px-2" aria-label="Hasta" /></label>
      <button type="submit" className="h-8 rounded-lg bg-[#002855] px-3 font-bold text-white hover:bg-[#0b3d7a]">Aplicar</button>
      {(sp.get('d') || sp.get('h')) && (
        <button type="button" onClick={() => { setD(''); setH(''); apply(undefined, '', '') }} className="flex h-8 items-center gap-1 rounded-lg px-2 font-semibold text-slate-500 hover:bg-slate-100">
          <RotateCcw className="h-3.5 w-3.5" /> Base del módulo
        </button>
      )}
    </form>
  )
}

function Tabs() {
  const pathname = usePathname()
  const sp = useSearchParams()
  const qs = ['d', 'h'].filter(k => sp.get(k)).map(k => `${k}=${sp.get(k)}`).join('&')
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-t-2 border-[#002855] bg-slate-50/70 px-2">
      {TABS.map(t => (
        <Link key={t.href} href={qs ? `${t.href}?${qs}` : t.href}
          className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide transition-colors ${
            active(t.href, pathname) ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

export default function EficienciaFlotaLayout({ children }: { children: React.ReactNode }) {
  const { hasAccess, isLoaded } = usePermissions()
  const allowed = hasAccess('flota-eficiencia') || hasAccess('flota-eficiencia-carga')
  if (!isLoaded) return <LoadingBlock label="Cargando…" />
  if (!allowed) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-12 text-center">
        <Lock className="h-8 w-8 text-slate-300" />
        <p className="font-semibold text-slate-700">No tiene acceso a Eficiencia de Flota</p>
        <p className="text-sm text-slate-500">Solicite el permiso “Eficiencia de Flota” al administrador.</p>
      </div>
    )
  }
  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#002855] to-[#0b3d7a] text-white shadow">
              <Gauge className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight text-slate-900">Eficiencia de Flota</h1>
              <p className="text-xs text-slate-500">Mantenimiento, combustible, km y peso por unidad · costo por km, por tonelada y por hora · decisión de reemplazo</p>
            </div>
          </div>
          <Suspense fallback={null}><Periodo /></Suspense>
        </div>
        <div className="mt-3 border-t border-slate-100"><Suspense fallback={null}><Tabs /></Suspense></div>
      </div>
      <Suspense fallback={<LoadingBlock />}>{children}</Suspense>
    </div>
  )
}
