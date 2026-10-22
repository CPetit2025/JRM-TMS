'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Columns3, Download, FileSearch } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { comercialRef, ordenRef } from '@/lib/apt-analitica/catalog'
import { exportWorkbook, movementRow } from '@/lib/apt-analitica/export'
import { AREA_LABEL, CLASS_LABEL, type Movement } from '@/lib/apt-analitica/types'
import type { Issue, Severity } from '@/lib/apt-analitica/quality'
import { Modal } from '@/components/ui/modal'
import { useAnalitica } from './context'
import { Card, Empty, Notice, Segmented, SeverityBadge, fmtDate, fmtNum } from './ui'

// Explorador de movimientos (búsqueda, orden, columnas, agrupación y exportación) y calidad de datos.

interface Col { id: string; label: string; get: (m: Movement) => string | number | null; num?: boolean; default?: boolean }
const COLS: Col[] = [
  { id: 'fecha', label: 'Fecha', get: m => m.fecha, default: true },
  { id: 'side', label: 'Mov.', get: m => m.side === 'E' ? 'Entrada' : 'Salida', default: true },
  { id: 'tipo', label: 'TipoDocto', get: m => m.tipo, default: true },
  { id: 'clase', label: 'Clase', get: m => CLASS_LABEL[m.clase] },
  { id: 'numero', label: 'Número', get: m => m.numero, default: true },
  { id: 'bodega', label: 'Bodega', get: m => m.bodega, default: true },
  { id: 'area', label: 'Área', get: m => m.area ? AREA_LABEL[m.area] : '' },
  { id: 'producto', label: 'Producto', get: m => m.producto, default: true },
  { id: 'glosa', label: 'Glosa', get: m => m.glosa, default: true },
  { id: 'lote', label: 'Lote', get: m => m.lote, default: true },
  { id: 'qty', label: 'Cantidad', get: m => m.qty, num: true, default: true },
  { id: 'unidad', label: 'Und.', get: m => m.unidad, default: true },
  { id: 'cliente', label: 'Cliente', get: m => m.razonSocial, default: true },
  { id: 'orden', label: 'OT/OP', get: m => ordenRef(m) },
  { id: 'comercial', label: 'Ref. comercial', get: m => comercialRef(m) },
  { id: 'contrato', label: 'Contrato', get: m => m.contrato },
  { id: 'docRel', label: 'DocRel', get: m => m.docRel },
  { id: 'fechaEntrega', label: 'FechaEntrega', get: m => m.fechaEntrega },
  { id: 'peso', label: 'Peso unit.', get: m => m.pesoUnitario, num: true },
  { id: 'status', label: 'Estado', get: m => m.status },
  { id: 'origen', label: 'Hoja · fila', get: m => `${m.sheet} · ${m.row}` },
]
const GROUPS: Array<{ id: string; label: string; get: (m: Movement) => string | null }> = [
  { id: 'none', label: 'Sin agrupar', get: () => null }, { id: 'bodega', label: 'Bodega', get: m => m.bodega }, { id: 'producto', label: 'Producto', get: m => m.producto },
  { id: 'cliente', label: 'Cliente', get: m => m.razonSocial }, { id: 'lote', label: 'Lote', get: m => m.lote }, { id: 'tipo', label: 'TipoDocto', get: m => m.tipo },
  { id: 'fecha', label: 'Fecha', get: m => m.fecha }, { id: 'comercial', label: 'Ref. comercial', get: m => comercialRef(m) ?? m.contrato },
]

export function ExplorerTab() {
  const { analysis, drill, closeDrill, base, filters, settings, meta, setRawRow, files } = useAnalitica()
  const [cols, setCols] = useState<string[]>(COLS.filter(c => c.default).map(c => c.id))
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 }>({ id: 'fecha', dir: 1 })
  const [group, setGroup] = useState('none')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [showCols, setShowCols] = useState(false)
  const PAGE = 100
  const source = useMemo(() => drill ? drill.ids.map(id => base.byId.get(id)).filter((m): m is Movement => !!m) : analysis.scope, [drill, base, analysis.scope])
  const rows = useMemo(() => {
    const t = q.trim().toUpperCase()
    const list = t ? source.filter(m => COLS.some(c => { const v = c.get(m); return v !== null && String(v).toUpperCase().includes(t) })) : source
    const col = COLS.find(c => c.id === sort.id)!
    return [...list].sort((a, b) => {
      const x = col.get(a), y = col.get(b)
      if (x === y) return a.id - b.id
      if (x === null) return 1
      if (y === null) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es')) * sort.dir
    })
  }, [source, q, sort])
  const grouped = useMemo(() => {
    const g = GROUPS.find(x => x.id === group)!
    if (group === 'none') return null
    const by = new Map<string, Map<string, { e: number; s: number; n: number }>>()
    for (const m of rows) {
      const k = g.get(m) ?? '(sin dato)'
      const u = by.get(k) ?? new Map(); const v = u.get(m.unidad) ?? { e: 0, s: 0, n: 0 }
      if (m.side === 'E') v.e += m.qty; else v.s += m.qty
      v.n++; u.set(m.unidad, v); by.set(k, u)
    }
    return [...by].flatMap(([k, u]) => [...u].map(([unit, v]) => ({ key: k, unit, ...v }))).sort((a, b) => (b.e + b.s) - (a.e + a.s))
  }, [rows, group])
  useEffect(() => { const t = window.setTimeout(() => setPage(0), 0); return () => window.clearTimeout(t) }, [q, sort, group, drill])
  const shown = COLS.filter(c => cols.includes(c.id))
  const doExport = () => exportWorkbook(`analitica-apt-${new Date().toISOString().slice(0, 10)}.xlsx`, [
    { name: 'Movimientos', rows: rows.map(m => movementRow(m, files)) },
    ...(grouped ? [{ name: 'Agrupado', rows: grouped.map(g => ({ [GROUPS.find(x => x.id === group)!.label]: g.key, Unidad: g.unit, Entradas: g.e, Salidas: g.s, Variación: g.e - g.s, Líneas: g.n })) }] : []),
  ], { filters, cutoff: analysis.cutoff, settings, lastUpdate: meta?.last_change_at ?? null, label: drill ? drill.label : q ? `Filtros globales + búsqueda «${q}»` : undefined })

  return <div className="space-y-3">
    {drill && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#002855]/30 bg-[#002855]/5 px-3 py-2 text-sm">
      <span>Registros que sustentan: <b>{drill.label}</b> ({drill.ids.length.toLocaleString('es-PE')})</span>
      <button type="button" onClick={closeDrill} className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold"><ArrowLeft className="h-3.5 w-3.5" aria-hidden />Volver</button>
    </div>}
    <Card title="Explorador de movimientos" subtitle={`${rows.length.toLocaleString('es-PE')} registros${drill ? '' : ' con los filtros globales'} · cantidades por unidad, sin sumar unidades distintas`}
      actions={<>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar en la tabla…" aria-label="Buscar en la tabla" className="h-8 w-48 rounded-lg border border-slate-300 px-2 text-xs" />
        <select value={group} onChange={e => setGroup(e.target.value)} aria-label="Agrupar por" className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs">
          {GROUPS.map(g => <option key={g.id} value={g.id}>{g.id === 'none' ? 'Sin agrupar' : `Agrupar por ${g.label.toLowerCase()}`}</option>)}</select>
        <div className="relative"><button type="button" onClick={() => setShowCols(s => !s)} aria-expanded={showCols} className="flex h-8 items-center gap-1 rounded-lg border border-slate-300 px-2 text-xs font-semibold">
          <Columns3 className="h-3.5 w-3.5" aria-hidden />Columnas</button>
          {showCols && <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-xl">
            {COLS.map(c => <label key={c.id} className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={cols.includes(c.id)}
              onChange={() => setCols(cs => cs.includes(c.id) ? cs.filter(x => x !== c.id) : [...cs, c.id])} />{c.label}</label>)}</div>}</div>
        <button type="button" onClick={doExport} className="flex h-8 items-center gap-1 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white"><Download className="h-3.5 w-3.5" aria-hidden />Exportar selección</button>
      </>}>
      {grouped && <div className="mb-3 max-h-80 overflow-auto rounded border border-slate-200"><table className="w-full min-w-[36rem] text-xs">
        <thead className="sticky top-0 bg-slate-50"><tr className="text-left"><th className="px-2 py-1">{GROUPS.find(g => g.id === group)!.label}</th><th>Unidad</th><th className="text-right">Entradas</th><th className="text-right">Salidas</th><th className="text-right">Variación</th><th className="px-2 text-right">Líneas</th></tr></thead>
        <tbody>{grouped.slice(0, 500).map(g => <tr key={`${g.key}${g.unit}`} className="border-t border-slate-100"><td className="max-w-[20rem] truncate px-2 py-1" title={g.key}>{g.key}</td><td>{g.unit}</td>
          <td className="text-right tabular-nums">{fmtNum(g.e)}</td><td className="text-right tabular-nums">{fmtNum(g.s)}</td><td className="text-right font-semibold tabular-nums">{fmtNum(g.e - g.s)}</td><td className="px-2 text-right tabular-nums">{g.n}</td></tr>)}</tbody>
      </table></div>}
      {rows.length === 0 ? <Empty title="Sin registros para los filtros aplicados" /> : <>
        <div className="max-h-[36rem] overflow-auto rounded border border-slate-200"><table className="w-full text-xs" style={{ minWidth: `${shown.length * 7}rem` }}>
          <thead className="sticky top-0 z-10 bg-slate-50"><tr>{shown.map(c => <th key={c.id} scope="col" aria-sort={sort.id === c.id ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={`px-2 py-1.5 font-semibold text-slate-700 ${c.num ? 'text-right' : 'text-left'}`}>
            <button type="button" onClick={() => setSort(s => ({ id: c.id, dir: s.id === c.id ? (s.dir === 1 ? -1 : 1) : 1 }))} className="whitespace-nowrap hover:underline">
              {c.label}{sort.id === c.id ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button></th>)}<th className="px-2">Fila</th></tr></thead>
          <tbody>{rows.slice(page * PAGE, page * PAGE + PAGE).map(m => <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50">
            {shown.map(c => { const v = c.get(m); return <td key={c.id} className={`max-w-[16rem] truncate px-2 py-1 ${c.num ? 'text-right tabular-nums' : ''}`} title={v === null ? '' : String(v)}>
              {v === null || v === '' ? <span className="text-slate-400">—</span> : c.num ? fmtNum(Number(v)) : c.id === 'fecha' || c.id === 'fechaEntrega' ? fmtDate(String(v)) : String(v)}</td> })}
            <td className="px-2"><button type="button" onClick={() => setRawRow(m.id)} aria-label="Ver fila original" className="text-[#002855]"><FileSearch className="h-4 w-4" /></button></td></tr>)}</tbody>
        </table></div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-600">
          <span>{page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} de {rows.length.toLocaleString('es-PE')}</span>
          <span className="flex gap-1"><button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Anterior</button>
            <button type="button" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(p => p + 1)} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">Siguiente</button></span>
        </div>
      </>}
    </Card>
  </div>
}

// ---------------------------------------------------------------------------------------------------------------
export function CalidadTab() {
  const { analysis, openDrill, meta, imports, setTab } = useAnalitica()
  const [sev, setSev] = useState<'TODAS' | Severity>('TODAS')
  const list = analysis.issues.filter(i => sev === 'TODAS' || i.severity === sev)
  const review = imports.filter(i => i.status === 'ACTIVA' && i.rows_review > 0)
  return <div className="space-y-3">
    {review.length > 0 && <Notice tone="warn">{review.reduce((a, i) => a + i.rows_review, 0).toLocaleString('es-PE')} fila(s) en revisión en {review.length} carga(s): no cuentan en los cálculos hasta aceptarlas o descartarlas.
      <button type="button" onClick={() => setTab('cargas')} className="ml-1 font-semibold underline">Revisar en Cargas</button></Notice>}
    {(meta?.bodegas_sin_area?.length ?? 0) > 0 && <Notice>Bodegas sin área asignada (fuera del análisis salvo traspasos): {meta!.bodegas_sin_area.slice(0, 12).join(', ')}{meta!.bodegas_sin_area.length > 12 ? '…' : ''}.</Notice>}
    <Card title="Incidencias de calidad" subtitle="Ordenadas por prioridad e impacto. Cada una indica qué resultados afecta y abre las filas originales."
      actions={<Segmented label="Prioridad" value={sev} onChange={setSev} options={[{ id: 'TODAS', label: 'Todas' }, { id: 'ALTA', label: 'Alta' }, { id: 'MEDIA', label: 'Media' }, { id: 'BAJA', label: 'Baja' }, { id: 'INFO', label: 'Pendientes' }]} />}>
      {list.length === 0 ? <Empty title="Sin incidencias para este filtro" /> : <ul className="divide-y divide-slate-100">
        {list.map((i: Issue) => <li key={i.code} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-3">
          <div className="sm:w-28"><SeverityBadge severity={i.severity} /></div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-800">{i.title}</p>
            <p className="text-xs text-slate-600">{i.description}</p>
            <p className="mt-1 text-[11px] text-slate-600">Afecta: {i.affects.join(', ')}{i.pending && <> · <b className="text-violet-800">Pendiente: {i.pending}</b></>}</p>
          </div>
          <div className="text-right text-xs sm:w-56">
            {i.count > 0 && <p className="font-semibold tabular-nums">{i.count.toLocaleString('es-PE')} fila(s)</p>}
            {Object.entries(i.qtyByUnit).slice(0, 3).map(([u, q]) => <p key={u} className="tabular-nums text-slate-600">{fmtNum(q)} {u}</p>)}
            {i.ids.length > 0 && <button type="button" onClick={() => openDrill(i.title, i.ids)} className="mt-1 font-semibold text-[#002855]">Ver filas →</button>}
          </div>
        </li>)}
      </ul>}
    </Card>
  </div>
}

// ---------------------------------------------------------------------------------------------------------------
export function RawRowModal() {
  const { rawRow, setRawRow } = useAnalitica()
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<{ raw: Record<string, unknown> | null; movement: Record<string, unknown>; file_name: string; source_type: string; import_status: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (rawRow === null) return
    let alive = true
    void supabase.rpc('apa_raw_row', { p_movement: rawRow }).then(({ data: d, error }) => {
      if (!alive) return
      if (error) setErr(error.message); else { setErr(null); setData(d as never) }
    })
    return () => { alive = false; setData(null) }
  }, [rawRow, supabase])
  if (rawRow === null) return null
  const mv = data?.movement as { sheet?: string; row_number?: number; status?: string; reasons?: string[] } | undefined
  return <Modal isOpen onClose={() => setRawRow(null)} title="Fila original" maxWidth="max-w-3xl">
    {err ? <Notice tone="warn">{err}</Notice> : !data ? <p className="text-sm text-slate-500">Cargando…</p> : <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-600">Archivo <b>{data.file_name}</b> · hoja <b>{mv?.sheet}</b> · fila <b>{mv?.row_number}</b> · estado {mv?.status} · carga {data.import_status.toLowerCase()}</p>
      {mv?.reasons?.length ? <Notice tone="warn">{mv.reasons.join(' · ')}</Notice> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <section><h4 className="mb-1 text-xs font-bold uppercase text-slate-500">Tal como vino</h4>
          <dl className="max-h-96 overflow-auto rounded border border-slate-200 text-xs">{Object.entries(data.raw ?? {}).map(([k, v]) => <div key={k} className="grid grid-cols-2 border-b border-slate-100 px-2 py-1">
            <dt className="font-semibold text-slate-600">{k}</dt><dd className="break-all">{v === null ? <span className="text-slate-400">vacío</span> : String(v)}</dd></div>)}</dl></section>
        <section><h4 className="mb-1 text-xs font-bold uppercase text-slate-500">Normalizada</h4>
          <dl className="max-h-96 overflow-auto rounded border border-slate-200 text-xs">{Object.entries(data.movement).filter(([k]) => !['import_id', 'reviewed_at', 'review_note'].includes(k)).map(([k, v]) => <div key={k} className="grid grid-cols-2 border-b border-slate-100 px-2 py-1">
            <dt className="font-semibold text-slate-600">{k}</dt><dd className="break-all">{v === null ? <span className="text-slate-400">sin dato</span> : Array.isArray(v) ? v.join(' · ') : String(v)}</dd></div>)}</dl></section>
      </div>
    </div>}
  </Modal>
}
