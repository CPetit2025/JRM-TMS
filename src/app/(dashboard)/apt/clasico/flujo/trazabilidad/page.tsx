'use client'

import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FileText, Layers, Route, Search, X } from 'lucide-react'
import { flowApi } from '@/lib/apt/api'
import { fmtDate, fmtTn } from '@/lib/apt/format'
import { traceHref } from '@/lib/apt/useFlowFilters'
import { esBusquedaOt, type FlowTrace, type FlowTraceBuscar, type OtFamilia } from '@/lib/apt/flowTypes'
import { EmptyState, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { short } from '@/components/apt/dashCharts'
import { TrazaGuia } from '@/components/apt/flow/TrazaGuia'
import { TrazaLote } from '@/components/apt/flow/TrazaLote'
import { OtFamiliaFicha, OtFamiliaStrip } from '@/components/apt/flow/OtFamilia'

// Trazabilidad: de una guía hacia atrás (qué producción o stock previo se despachó y cuánto tardó) o de un lote hacia adelante
// (todos sus movimientos por almacén hasta las guías). Una OT (16339) abre su familia: madre, subcontratos, errores,
// garantías, retornos y posibles errores de digitación. La búsqueda vive en la URL (?q=) para poder compartir el enlace.

const EJEMPLOS = ['T001-00006696', '16339', '16339-S001']

function SearchBar({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(initial)
  const submit = (e: FormEvent) => { e.preventDefault(); onSearch(text.trim()) }
  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <label htmlFor="traza-q" className="text-[11px] font-black uppercase tracking-wider text-slate-500">Buscar guía, OT o lote</label>
      <div className="mt-2 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
          <input id="traza-q" value={text} onChange={e => setText(e.target.value)} autoFocus={!initial} autoComplete="off" spellCheck={false}
            placeholder="Guía (T001-00006696), OT con toda su familia (16339) o lote (16339-S001)"
            className="w-full rounded-xl border border-slate-300 bg-slate-50 py-3 pl-11 pr-10 font-mono text-base text-slate-900 outline-none transition focus:border-[#002855] focus:bg-white focus:ring-4 focus:ring-[#002855]/10" />
          {text && (
            <button type="button" aria-label="Limpiar" onClick={() => { setText(''); onSearch('') }}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button type="submit" disabled={text.trim().length < 2}
          className="rounded-xl bg-[#002855] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#001a3a] disabled:opacity-40">
          Trazar
        </button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Ejemplos:{' '}
        {EJEMPLOS.map((x, i) => (
          <span key={x}>{i > 0 && ' · '}<Link href={traceHref(x)} className="font-mono font-semibold text-[#002855] hover:underline">{x}</Link></span>
        ))}
        . También puede escribir parte de un lote o de una guía para ver sugerencias.
      </p>
    </form>
  )
}

function SugList({ title, icon, children, n }: { title: string; icon: ReactNode; children: ReactNode; n: number }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-800">{icon}{title}<span className="text-xs font-normal text-slate-400">({n})</span></header>
      {n ? <ul className="max-h-[480px] divide-y divide-slate-100 overflow-auto">{children}</ul> : <p className="p-4 text-sm text-slate-500">Sin coincidencias.</p>}
    </section>
  )
}

function Sugerencias({ d, q }: { d: FlowTraceBuscar; q: string }) {
  if (!d.guias.length && !d.lotes.length) {
    return <EmptyState title={`No se encontró “${q}”`}>Revise el número de guía (serie y correlativo, p. ej. T001-00006696) o el lote. Solo se buscan movimientos ya cargados en APT.</EmptyState>
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">No hay una coincidencia exacta para <b className="font-mono">{q}</b>. Elija una de las sugerencias:</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <SugList title="Guías" icon={<FileText className="h-4 w-4 text-[#2563eb]" />} n={d.guias.length}>
          {d.guias.map(g => (
            <li key={g.documento}>
              <Link href={traceHref(g.documento)} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block font-mono font-bold text-[#002855]">{g.documento}</span>
                  <span className="block truncate text-slate-500" title={g.cliente || ''}>{fmtDate(g.fecha)} · {short(g.cliente, 50)}</span>
                </span>
                <span className="whitespace-nowrap font-semibold tabular-nums text-slate-700">{fmtTn(g.tn)} TN</span>
              </Link>
            </li>
          ))}
        </SugList>
        <SugList title="Lotes" icon={<Layers className="h-4 w-4 text-[#002855]" />} n={d.lotes.length}>
          {d.lotes.map(l => (
            <li key={l.lote}>
              <Link href={traceHref(l.lote)} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block font-mono font-bold text-[#002855]">{l.lote}</span>
                  <span className="block truncate text-slate-500" title={l.cliente || ''}>{short(l.cliente, 60)}</span>
                </span>
                <span className="whitespace-nowrap font-semibold tabular-nums text-slate-700">{fmtTn(l.tn)} TN</span>
              </Link>
            </li>
          ))}
        </SugList>
      </div>
    </div>
  )
}

function Trace() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const q = (searchParams.get('q') || '').trim()
  const [nonce, setNonce] = useState(0)
  const reqKey = `${q}|${nonce}`
  const [res, setRes] = useState<{ key: string; data: FlowTrace | null; error: string | null } | null>(null)
  // Familia de la OT: para una OT (16339) es la vista principal; para un lote (16339-S001) es la franja de contexto
  const conFamilia = /^\d{3,}/.test(q)
  const [fam, setFam] = useState<{ key: string; data: OtFamilia | null } | null>(null)

  useEffect(() => {
    if (q.length < 2) return
    let alive = true
    flowApi.trace(q)
      .then(data => { if (alive) setRes({ key: reqKey, data, error: null }) })
      .catch((e: unknown) => { if (alive) setRes({ key: reqKey, data: null, error: e instanceof Error ? e.message : 'No se pudo trazar' }) })
    if (conFamilia) {
      flowApi.familia(q)
        .then(data => { if (alive) setFam({ key: reqKey, data }) })
        .catch(() => { if (alive) setFam({ key: reqKey, data: null }) })
    }
    return () => { alive = false }
  }, [q, reqKey, conFamilia])

  const onSearch = (next: string) => {
    const qs = new URLSearchParams(searchParams.toString())
    if (next) qs.set('q', next)
    else qs.delete('q')
    const s = qs.toString()
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false })
  }

  const current = res?.key === reqKey ? res : null
  const famCur = conFamilia ? (fam?.key === reqKey ? fam : undefined) : null
  const familia = famCur?.data && famCur.data.miembros.length > 0 ? famCur.data : null
  const vistaOt = esBusquedaOt(q)
  let body: ReactNode
  if (q.length < 2) {
    body = (
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
          <p className="flex items-center gap-1.5 font-bold text-slate-800"><FileText className="h-4 w-4 text-[#2563eb]" /> Por guía</p>
          <p className="mt-1 text-xs">De dónde vino cada línea despachada: producción del periodo o stock previo, por qué almacén pasó (647, 540, ST) y cuántos días tardó en cada etapa. Incluye el estado del despacho en el TMS.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
          <p className="flex items-center gap-1.5 font-bold text-slate-800"><Route className="h-4 w-4 text-[#0d9488]" /> Por lote</p>
          <p className="mt-1 text-xs">Línea de tiempo de todos los movimientos del lote: producción, traspasos entre almacenes, cambios de lote (adelanto → contrato), consumos y guías, con el saldo que queda en cada almacén.</p>
        </div>
      </div>
    )
  } else if (!current || (vistaOt && famCur === undefined)) {
    body = <LoadingBlock label={`Trazando ${q}…`} className="h-80" />
  } else if (vistaOt && familia && (familia.miembros.length > 1 || current.data?.modo !== 'lote')) {
    body = (
      <div className="space-y-4">
        <OtFamiliaFicha key={`fam-${q}`} d={familia} />
        {current.data?.modo === 'lote' && (
          <details className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-slate-700">Línea de tiempo solo del lote madre {q}</summary>
            <div className="border-t border-slate-100 p-4"><TrazaLote key={`lote-${q}`} d={current.data} /></div>
          </details>
        )}
      </div>
    )
  } else if (current.error || !current.data) {
    body = <ErrorBlock message={current.error || 'No se pudo trazar'} onRetry={() => setNonce(n => n + 1)} />
  } else if (current.data.modo === 'guia') {
    body = <TrazaGuia key={`guia-${q}`} d={current.data} />
  } else if (current.data.modo === 'lote') {
    body = (
      <div className="space-y-4">
        {familia && familia.miembros.length > 1 && (
          <OtFamiliaStrip d={familia} current={current.data.lote.lote} footer={
            <div className="mt-3 border-t border-slate-200/70 pt-3 text-xs">
              <Link href={traceHref(familia.ot)} className="font-bold text-[#002855] hover:underline">Ver la familia completa de la OT {familia.ot} →</Link>
            </div>
          } />
        )}
        <TrazaLote key={`lote-${q}`} d={current.data} />
      </div>
    )
  } else {
    body = <Sugerencias d={current.data} q={q} />
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-black text-slate-900">Trazabilidad guía ↔ lote</h2>
        <p className="text-xs text-slate-500">Siga el material desde la producción hasta la guía al cliente (o al revés), pasando por 647, 540 y ST VENTAS.</p>
      </div>
      <SearchBar key={`buscar-${q}`} initial={q} onSearch={onSearch} />
      {body}
    </div>
  )
}

export default function TrazabilidadPage() {
  return (
    <Suspense fallback={<LoadingBlock className="h-80" />}>
      <Trace />
    </Suspense>
  )
}
