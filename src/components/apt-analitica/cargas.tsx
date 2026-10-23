'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, FileUp, Loader2, RotateCcw, ShieldAlert, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import type { ParsedSheet } from '@/lib/apt-analitica/normalize'
import { filePeriod, importAnaliticaFile } from '@/lib/apt-analitica/importFile'
import { MAX_FILE_BYTES, fileHash, parseWorkbook, type WorkbookParse } from '@/lib/apt-analitica/workbook'
import type { SourceType } from '@/lib/apt-analitica/types'
import { Modal } from '@/components/ui/modal'
import { useAnalitica, type ImportRow } from './context'
import { Card, Empty, Notice, Segmented, fmtDate, fmtDateTime, fmtNum } from './ui'

// Asistente de carga: tipo de fuente → archivos → vista previa con validación → importación por bloques → resumen.
// Historial de importaciones con reversión y revisión de filas pendientes.

const SOURCES: Array<{ id: SourceType; label: string; help: string }> = [
  { id: 'ENTRADAS', label: 'Entradas', help: 'Reporte de entradas del ERP (Cantidad positiva).' },
  { id: 'SALIDAS', label: 'Salidas', help: 'Reporte de salidas del ERP (Cantidad negativa).' },
  { id: 'MOVIMIENTOS', label: 'Movimientos (mixto)', help: 'Libro con entradas y salidas: el lado lo define el signo de Cantidad.' },
  { id: 'SALDO_INICIAL', label: 'Saldo inicial', help: 'Bodega, Producto, Lote, Unidad, Cantidad y FechaCorte (o la fecha indicada).' },
  { id: 'COMPROMISOS', label: 'Compromisos', help: 'Pedido, Línea, Producto, Unidad, Cantidad, FechaCompromiso, Versión, Estado.' },
  { id: 'RECEPCIONES', label: 'Recepciones', help: 'Despacho (documento), Producto, Unidad, CantidadAceptada, CantidadRechazada, FechaRecepcion, Motivo.' },
]
const family = (s: string) => ['ENTRADAS', 'SALIDAS', 'MOVIMIENTOS'].includes(s) ? 'MOV' : s

interface Prepared { file: File; hash: string; parse: WorkbookParse; error?: string }

export function CargasTab() {
  const { meta, imports, reload, base } = useAnalitica()
  const supabase = useMemo(() => createClient(), [])
  const [source, setSource] = useState<SourceType>('ENTRADAS')
  const [cutoff, setCutoff] = useState('')
  const [prepared, setPrepared] = useState<Prepared[]>([])
  const [reading, setReading] = useState(false)
  const [ack, setAck] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [summary, setSummary] = useState<Array<{ file: string; ok: boolean; text: string }>>([])
  const [reviewFor, setReviewFor] = useState<ImportRow | null>(null)
  const [revertFor, setRevertFor] = useState<ImportRow | null>(null)
  const canOperate = !!meta?.can_operate
  const today = new Date().toISOString().slice(0, 10)

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return
    setReading(true); setSummary([]); setAck(false)
    const out: Prepared[] = []
    for (const file of [...list]) {
      if (file.size > MAX_FILE_BYTES) { out.push({ file, hash: '', parse: { sheets: [], skipped: [] }, error: `Supera el límite de ${MAX_FILE_BYTES / 1048576} MB` }); continue }
      try {
        const buf = await file.arrayBuffer()
        await new Promise(r => setTimeout(r, 0))
        const parse = parseWorkbook(buf, source, { today, cutoff: cutoff || null })
        out.push({ file, hash: await fileHash(buf), parse, error: parse.sheets.length ? undefined : parse.skipped.map(s => `${s.sheet}: ${s.reason}`).join(' · ') || 'Sin hojas válidas' })
      } catch (e) { out.push({ file, hash: '', parse: { sheets: [], skipped: [] }, error: e instanceof Error ? e.message : 'No se pudo leer el archivo' }) }
    }
    setPrepared(out); setReading(false)
  }

  const period = (p: Prepared) => filePeriod(p.parse)
  const already = (p: Prepared) => imports.find(i => i.status === 'ACTIVA' && i.file_hash === p.hash && i.source_type === source)
  const overlaps = (p: Prepared) => { const { from, to } = period(p); return from && to ? imports.filter(i => i.status === 'ACTIVA' && family(i.source_type) === family(source) && i.period_from && i.period_to && i.period_from <= to && i.period_to >= from) : [] }
  const anyOverlap = prepared.some(p => overlaps(p).length > 0)
  const valid = prepared.filter(p => !p.error && !already(p))

  const run = async () => {
    const res: typeof summary = []
    for (const p of valid) res.push({ file: p.file.name, ...await importAnaliticaFile(supabase, p, source, cutoff || null, setRunning) })
    setRunning(null); setSummary(res); setPrepared([])
    if (res.some(r => r.ok)) { toast.success('Carga aplicada'); await reload() }
  }

  return <div className="space-y-4">
    {!canOperate && <Notice tone="warn">Solo consulta: para cargar o revertir archivos se necesita el permiso «Carga diaria ENTRADA/SALIDA y parámetros» (apt-carga).</Notice>}
    {canOperate && <Card title="Asistente de carga" subtitle="1. Tipo de fuente · 2. Archivos · 3. Vista previa y validación · 4. Importar">
      <div className="space-y-3">
        <Segmented label="Tipo de fuente" value={source} onChange={v => { setSource(v); setPrepared([]) }} options={SOURCES.map(s => ({ id: s.id, label: s.label }))} />
        <p className="text-xs text-slate-600">{SOURCES.find(s => s.id === source)!.help} Se conserva cada fila original con su archivo, hoja y fila. Fechas seriales de Excel y de texto (dd/mm/aaaa) se convierten; la columna vacía inicial se ignora.</p>
        {source === 'SALDO_INICIAL' && <label className="block text-xs"><span className="font-semibold">Fecha de corte (si el archivo no la trae)</span>
          <input type="date" value={cutoff} onChange={e => setCutoff(e.target.value)} className="ml-2 h-8 rounded border border-slate-300 px-2" /></label>}
        <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 p-6 text-center hover:border-[#002855]">
          <FileUp className="h-6 w-6 text-slate-400" aria-hidden /><span className="text-sm font-semibold text-slate-700">Seleccionar archivos Excel o CSV</span>
          <span className="text-xs text-slate-500">Máximo 40 MB y 400.000 filas por hoja</span>
          <input type="file" multiple accept=".xlsx,.xls,.xlsm,.csv" className="sr-only" onChange={e => void onFiles(e.target.files)} />
        </label>
        {reading && <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Leyendo y validando…</p>}
        {prepared.map(p => <FilePreview key={p.file.name + p.hash} p={p} dup={already(p)} overlaps={overlaps(p)} />)}
        {prepared.length > 0 && <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          {anyOverlap && <label className="flex items-start gap-2 text-xs text-amber-900"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="mt-0.5" />
            Hay períodos superpuestos con cargas vigentes. Entiendo que las líneas iguales a otra carga quedarán en revisión (no se suman dos veces ni se eliminan).</label>}
          <button type="button" disabled={!valid.length || !!running || (anyOverlap && !ack)} onClick={() => void run()}
            className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}Importar {valid.length} archivo(s)</button>
          {running && <span className="text-xs text-slate-600" role="status">{running}</span>}
        </div>}
        {summary.length > 0 && <ul className="space-y-1" role="status">{summary.map(s => <li key={s.file} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${s.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-800'}`}>
          {s.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}<span><b>{s.file}</b>: {s.text}</span></li>)}</ul>}
      </div>
    </Card>}

    <Card title="Historial de importaciones" subtitle={`${imports.filter(i => i.status === 'ACTIVA').length} vigentes · ${imports.length} en total`}>
      {imports.length === 0 ? <Empty title="Todavía no hay importaciones" /> : <div className="overflow-x-auto"><table className="w-full min-w-[60rem] text-xs">
        <thead><tr className="text-left text-slate-600"><th className="py-1">Archivo</th><th>Tipo</th><th>Período</th><th className="text-right">Filas</th><th className="text-right">Aceptadas</th>
          <th className="text-right">Rechazadas</th><th className="text-right">Revisión</th><th className="text-right">Descartadas</th><th>Estado</th><th>Cargado</th><th></th></tr></thead>
        <tbody>{imports.map(i => <tr key={i.id} className={`border-t border-slate-100 ${i.status === 'REVERTIDA' ? 'text-slate-500' : ''}`}>
          <td className="max-w-[16rem] truncate py-1.5 font-medium" title={`${i.file_name} · huella ${i.file_hash.slice(0, 12)}…`}>{i.file_name}</td><td>{SOURCES.find(s => s.id === i.source_type)?.label ?? i.source_type}</td>
          <td className="whitespace-nowrap">{fmtDate(i.period_from)} – {fmtDate(i.period_to)}</td><td className="text-right tabular-nums">{fmtNum(i.rows_total)}</td>
          <td className="text-right tabular-nums">{fmtNum(i.rows_accepted)}</td><td className="text-right tabular-nums">{fmtNum(i.rows_rejected)}</td>
          <td className={`text-right tabular-nums ${i.rows_review ? 'font-bold text-amber-700' : ''}`}>{fmtNum(i.rows_review)}</td><td className="text-right tabular-nums">{fmtNum(i.rows_discarded)}</td>
          <td>{i.status === 'ACTIVA' ? 'Vigente' : <span title={i.revert_reason ?? ''}>Revertida {fmtDateTime(i.reverted_at)}{i.reverted_by ? ` · ${i.reverted_by}` : ''}</span>}</td>
          <td className="whitespace-nowrap">{fmtDateTime(i.created_at)}<span className="block text-[10px] text-slate-500">{i.created_by}</span></td>
          <td className="whitespace-nowrap text-right">{canOperate && i.status === 'ACTIVA' && <>
            {i.rows_review > 0 && <button type="button" onClick={() => setReviewFor(i)} className="mr-2 font-semibold text-amber-700">Revisar</button>}
            <button type="button" onClick={() => setRevertFor(i)} className="inline-flex items-center gap-1 font-semibold text-[#cf152d]"><RotateCcw className="h-3 w-3" aria-hidden />Revertir</button></>}</td>
        </tr>)}</tbody>
      </table></div>}
      {base.all.length > 0 && <p className="mt-2 text-[11px] text-slate-500">En el análisis: {fmtNum(base.all.length)} filas (bodegas con área, traspasos y filas no aceptadas). Fuera del alcance: {fmtNum(meta?.outside_scope ?? 0)} · descartadas: {fmtNum(meta?.discarded ?? 0)}.</p>}
    </Card>
    {reviewFor && <ReviewModal imp={reviewFor} onClose={() => setReviewFor(null)} />}
    {revertFor && <RevertModal imp={revertFor} onClose={() => setRevertFor(null)} />}
  </div>
}

function FilePreview({ p, dup, overlaps }: { p: Prepared; dup?: ImportRow; overlaps: ImportRow[] }) {
  const [sheetIdx, setSheetIdx] = useState(0)
  const s: ParsedSheet | undefined = p.parse.sheets[sheetIdx]
  const cols = s?.header.columns.filter(c => c.ignored !== 'vacia') ?? []
  const sameRows = s ? s.rows.filter(r => r.dup > 1).length : 0
  return <div className="rounded-xl border border-slate-200 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="text-sm font-bold text-slate-800">{p.file.name}</p><p className="text-[11px] text-slate-500">{fmtNum(p.file.size / 1024, 0)} KB · huella {p.hash.slice(0, 16)}…</p></div>
      {p.parse.sheets.length > 1 && <select value={sheetIdx} onChange={e => setSheetIdx(Number(e.target.value))} className="h-8 rounded border border-slate-300 text-xs" aria-label="Hoja">
        {p.parse.sheets.map((x, i) => <option key={x.sheet} value={i}>{x.sheet}</option>)}</select>}
    </div>
    {p.error && <Notice tone="warn">{p.error}</Notice>}
    {dup && <Notice tone="warn">Este archivo ya está importado ({dup.file_name}, {fmtDateTime(dup.created_at)}): no se volverá a cargar. Revierta esa importación si necesita reemplazarla.</Notice>}
    {overlaps.length > 0 && <Notice tone="warn">Período superpuesto con: {overlaps.map(o => `${o.file_name} (${fmtDate(o.period_from)}–${fmtDate(o.period_to)})`).join(', ')}.</Notice>}
    {s && <div className="mt-2 space-y-2">
      <div className="flex flex-wrap gap-3 text-xs">
        <span>Período en los datos: <b>{fmtDate(s.periodFrom)} – {fmtDate(s.periodTo)}</b></span>
        <span className="text-emerald-800">Aceptadas: <b>{fmtNum(s.counts.ACEPTADO)}</b></span>
        <span className="text-red-700">Rechazadas: <b>{fmtNum(s.counts.RECHAZADO)}</b></span>
        <span className="text-amber-700">En revisión: <b>{fmtNum(s.counts.REVISION)}</b></span>
        {sameRows > 0 && <span>Líneas idénticas dentro del archivo: <b>{fmtNum(sameRows)}</b> (se conservan)</span>}
        <span>Encabezado en la fila {s.header.headerRow}</span>
      </div>
      {s.warnings.length > 0 && <ul className="list-disc pl-5 text-[11px] text-amber-900">{s.warnings.slice(0, 6).map(w => <li key={w}>{w}</li>)}{s.warnings.length > 6 && <li>… {s.warnings.length - 6} avisos más</li>}</ul>}
      <div className="overflow-x-auto rounded border border-slate-200"><table className="w-full text-[11px]">
        <thead className="bg-slate-50"><tr>{cols.map(c => <th key={c.index} className="whitespace-nowrap px-2 py-1 text-left">
          {c.header}<span className={`block text-[10px] font-normal ${c.canonical ? 'text-emerald-700' : 'text-amber-700'}`}>{c.canonical ? `→ ${c.canonical}` : 'no reconocida (se conserva)'}</span></th>)}</tr></thead>
        <tbody>{s.rows.slice(0, 8).map(r => <tr key={r.row} className={`border-t border-slate-100 ${r.status === 'RECHAZADO' ? 'bg-red-50' : r.status === 'REVISION' ? 'bg-amber-50' : ''}`}>
          {cols.map(c => <td key={c.index} className="max-w-[10rem] truncate whitespace-nowrap px-2 py-0.5">{String(r.raw[c.header] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>
      {(s.counts.RECHAZADO > 0 || s.counts.REVISION > 0) && <details className="text-xs"><summary className="cursor-pointer font-semibold">Ver filas rechazadas o en revisión</summary>
        <ul className="mt-1 max-h-40 overflow-auto">{s.rows.filter(r => r.status !== 'ACEPTADO').slice(0, 200).map(r => <li key={r.row}>Fila {r.row}: {r.status === 'RECHAZADO' ? 'rechazada' : 'en revisión'} — {r.reasons.join('; ')}</li>)}</ul></details>}
    </div>}
  </div>
}

function ReviewModal({ imp, onClose }: { imp: ImportRow; onClose: () => void }) {
  const { base, reload, setRawRow } = useAnalitica()
  const supabase = useMemo(() => createClient(), [])
  const rows = base.all.filter(m => m.importId === imp.id && m.status === 'REVISION')
  const [sel, setSel] = useState<number[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (decision: 'ACEPTAR' | 'DESCARTAR', ids: number[] | null) => {
    setBusy(true)
    const { data, error } = await supabase.rpc('apa_review_resolve', { p_import: imp.id, p_ids: ids, p_decision: decision, p_note: note })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(`${data.updated} fila(s) ${decision === 'ACEPTAR' ? 'aceptadas' : 'descartadas'}`)
    await reload(); onClose()
  }
  return <Modal isOpen onClose={onClose} title={`Revisión · ${imp.file_name}`} maxWidth="max-w-4xl"
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Motivo de la decisión (obligatorio)" aria-label="Motivo" className="h-10 min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-3 text-sm" />
      <button type="button" disabled={busy || note.trim().length < 5} onClick={() => void act('DESCARTAR', sel.length ? sel : null)} className="min-h-10 rounded-lg border border-red-300 px-3 text-sm font-semibold text-red-700 disabled:opacity-50">
        Descartar {sel.length ? `${sel.length} seleccionadas` : 'todas'}</button>
      <button type="button" disabled={busy || note.trim().length < 5} onClick={() => void act('ACEPTAR', sel.length ? sel : null)} className="min-h-10 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50">
        Aceptar {sel.length ? `${sel.length} seleccionadas` : 'todas'}</button></div>}>
    <p className="mb-2 text-xs text-slate-600">Aceptar: la fila entra a los cálculos. Descartar: queda guardada con su motivo y fuera de los cálculos. Nada se elimina.</p>
    {rows.length === 0 ? <Empty title="No hay filas en revisión cargadas en el análisis" /> : <div className="max-h-[28rem] overflow-auto rounded border border-slate-200"><table className="w-full text-xs">
      <thead className="sticky top-0 bg-slate-50"><tr className="text-left"><th className="px-2 py-1"><input type="checkbox" aria-label="Seleccionar todas" checked={sel.length === rows.length} onChange={e => setSel(e.target.checked ? rows.map(r => r.id) : [])} /></th>
        <th>Fila</th><th>Fecha</th><th>Tipo · número</th><th>Producto</th><th className="text-right">Cantidad</th><th>Motivo</th></tr></thead>
      <tbody>{rows.slice(0, 1000).map(m => <tr key={m.id} className="border-t border-slate-100">
        <td className="px-2"><input type="checkbox" aria-label={`Seleccionar fila ${m.row}`} checked={sel.includes(m.id)} onChange={() => setSel(s => s.includes(m.id) ? s.filter(x => x !== m.id) : [...s, m.id])} /></td>
        <td><button type="button" className="text-[#002855] underline" onClick={() => setRawRow(m.id)}>{m.sheet} · {m.row}</button></td><td>{fmtDate(m.fecha)}</td><td>{m.tipo} {m.numero}</td><td>{m.producto}</td>
        <td className="text-right tabular-nums">{fmtNum(m.cantidad)} {m.unidad}</td><td className="text-amber-800">{m.reasons.join(' · ')}</td></tr>)}</tbody>
    </table></div>}
  </Modal>
}

function RevertModal({ imp, onClose }: { imp: ImportRow; onClose: () => void }) {
  const { reload } = useAnalitica()
  const supabase = useMemo(() => createClient(), [])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    const { data, error } = await supabase.rpc('apa_import_revert', { p_import: imp.id, p_reason: reason })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success('Importación revertida')
    if (data?.pending_elsewhere) toast.warning(`${data.pending_elsewhere} fila(s) de otras cargas quedaron en revisión por ser iguales a esta: revíselas.`)
    await reload(); onClose()
  }
  return <Modal isOpen onClose={onClose} title="Revertir importación" maxWidth="max-w-lg"
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm">Cancelar</button>
      <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => void go()} className="min-h-10 rounded-lg bg-[#cf152d] px-4 text-sm font-semibold text-white disabled:opacity-50">Revertir</button></div>}>
    <div className="space-y-2 text-sm">
      <p><b>{imp.file_name}</b> ({fmtNum(imp.rows_total)} filas, {fmtDate(imp.period_from)}–{fmtDate(imp.period_to)}) dejará de contar en todos los indicadores. Las filas originales se conservan y la acción queda auditada.</p>
      <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Motivo (obligatorio)" aria-label="Motivo de la reversión" className="w-full rounded-lg border border-slate-300 p-2 text-sm" />
    </div>
  </Modal>
}
