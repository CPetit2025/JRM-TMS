'use client'

import { useRef, type KeyboardEvent } from 'react'
import { BarChart3, Loader2 } from 'lucide-react'
import { AnaliticaProvider, TABS, useAnalitica, type Tab } from '@/components/apt-analitica/context'
import { FiltersBar } from '@/components/apt-analitica/filters'
import { ResumenTab } from '@/components/apt-analitica/resumen'
import { AptTab, DistTab } from '@/components/apt-analitica/areas'
import { TrazaTab } from '@/components/apt-analitica/traza'
import { CalidadTab, ExplorerTab, RawRowModal } from '@/components/apt-analitica/explorer'
import { CargasTab } from '@/components/apt-analitica/cargas'
import { ConfigTab } from '@/components/apt-analitica/config'
import { Notice, fmtDate, fmtDateTime } from '@/components/apt-analitica/ui'

// Analítica logística APT y Distribución: flujos, permanencia, avance, trazabilidad y calidad sobre los movimientos
// importados del ERP. Reglas de cálculo: docs/apt-analitica.md

export default function AnaliticaPage() {
  return <AnaliticaProvider><Analitica /></AnaliticaProvider>
}

function Analitica() {
  const { status, error, progress, tab, setTab, base, meta, analysis, reload } = useAnalitica()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
    if (n < 0) return
    e.preventDefault(); setTab(TABS[n].id); refs.current[n]?.focus()
  }
  const noData = status === 'ready' && base.all.length === 0
  const panel = (t: Tab) => {
    if (t === 'cargas') return <CargasTab />
    if (t === 'config') return <ConfigTab />
    if (noData) return <Notice>No hay datos importados todavía. Cargue los reportes de Entradas y Salidas del ERP en la pestaña «Cargas»; las fechas del período se toman de los datos.</Notice>
    switch (t) {
      case 'resumen': return <ResumenTab />
      case 'apt': return <AptTab />
      case 'dist': return <DistTab />
      case 'traza': return <TrazaTab />
      case 'calidad': return <CalidadTab />
      default: return <ExplorerTab />
    }
  }
  return (
    <div className="space-y-3">
      <header className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-black text-[#002855]"><BarChart3 className="h-5 w-5" aria-hidden />Analítica APT y Distribución</h1>
            <p className="mt-0.5 max-w-3xl text-xs text-slate-600">Ingresos, salidas, acumulación, permanencia y trazabilidad hasta la fila original. Los resultados se marcan como <b>calculados</b>, <b>estimados</b> o <b>no disponibles</b> por falta de información.</p>
          </div>
          {status === 'ready' && base.minDate && <dl className="grid grid-cols-2 gap-x-4 text-[11px] text-slate-600">
            <dt>Datos</dt><dd className="font-semibold text-slate-800">{fmtDate(base.minDate)} – {fmtDate(base.maxDate)}</dd>
            <dt>Fecha de corte</dt><dd className="font-semibold text-slate-800">{fmtDate(analysis.cutoff)}</dd>
            <dt>Última actualización</dt><dd className="font-semibold text-slate-800">{fmtDateTime(meta?.last_change_at ?? meta?.last_import_at)}</dd>
            <dt>Cargas vigentes</dt><dd className="font-semibold text-slate-800">{meta?.imports_active ?? 0}</dd>
          </dl>}
        </div>
        <div role="tablist" aria-label="Secciones de la analítica" className="mt-3 flex gap-1 overflow-x-auto border-t border-slate-100 pt-2">
          {TABS.map((t, i) => <button key={t.id} ref={el => { refs.current[i] = el }} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="analitica-panel"
            tabIndex={tab === t.id ? 0 : -1} onKeyDown={e => onKey(e, i)} onClick={() => setTab(t.id)}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide ${tab === t.id ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{t.label}</button>)}
        </div>
      </header>
      {status === 'loading' && <p className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-10 text-sm text-slate-600" role="status"><Loader2 className="h-4 w-4 animate-spin" />{progress ?? 'Cargando…'}</p>}
      {status === 'error' && <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-800" role="alert">
        <p>No se pudo leer la información: {/permission|permiso/i.test(error ?? '') ? 'no tiene acceso (permiso «APT — Estadía de inventario»).' : error}</p>
        <button type="button" onClick={() => void reload()} className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold">Reintentar</button></div>}
      {status === 'ready' && progress && <p className="flex items-center gap-2 text-xs text-slate-600" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />Actualizando: {progress}</p>}
      {status === 'ready' && <>
        {!noData && tab !== 'cargas' && tab !== 'config' && <FiltersBar />}
        <div id="analitica-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>{panel(tab)}</div>
      </>}
      <RawRowModal />
    </div>
  )
}
