'use client'

import Link from 'next/link'
import { FormEvent, use, useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, CheckCircle2, Loader2, Printer, ScanLine, Search, Tag, Undo2 } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { Code128Barcode } from '@/components/warehouse/Code128Barcode'
import { fitScale, useLabelFormat } from '@/lib/warehouse/label-format'
import { CAMPAIGN_STATE, RESULT_STYLE, fmtDate, fmtN, type Campaign, type CountLine, type ExpectedLine, type SummaryRow } from '@/lib/warehouse/inventory'

type Label = { package_code: string; product: string; description: string; lote: string | null; ot: string | null; quantity: number; unit: string | null; weight_kg: number | null; document: string; sequence_no: number; sequence_total: number; bodega: string }
const btn = 'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-50'
const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal'
const lotKey = (r: { cod_producto: string; lote_key: string }) => `${r.cod_producto}|${r.lote_key}`

export default function WarehouseInventoryCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { hasAccess } = usePermissions()
  const isSupervisor = hasAccess('almacen-supervisor')
  const labelFormat = useLabelFormat('PAQUETE')
  const [camp, setCamp] = useState<Campaign | null>(null)
  const [lines, setLines] = useState<CountLine[]>([])
  const [summary, setSummary] = useState<SummaryRow[]>([])
  const [tab, setTab] = useState<'barrido' | 'cuadre'>('barrido')
  const [zone, setZone] = useState('')
  const [code, setCode] = useState('')
  const [search, setSearch] = useState('')
  const [expected, setExpected] = useState<ExpectedLine[]>([])
  const [pick, setPick] = useState<ExpectedLine | null>(null)
  const [rot, setRot] = useState({ qty: '', kg: '', doc: '', seq: '', total: '' })
  const [unknown, setUnknown] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [label, setLabel] = useState<Label | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const db = createClient()
    const [b, l, s] = await Promise.all([db.rpc('wh_count_board', { p_campaign: id }), db.rpc('wh_count_lines_list', { p_campaign: id, p_limit: 100 }), db.rpc('wh_count_summary', { p_campaign: id })])
    const e = b.error || l.error || s.error
    if (e) { setError(e.message); return }
    setCamp(((b.data || []) as Campaign[])[0] || null)
    setLines((l.data || []) as CountLine[])
    setSummary((s.data || []) as SummaryRow[])
  }, [id])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const run = async <T,>(fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, ok: (d: T) => string) => {
    setBusy(true); setError(''); setMessage('')
    const { data, error } = await fn()
    if (error) setError(error.message.replace(/^SUPERA_STOCK: /, ''))
    else { setMessage(ok(data as T)); await load() }
    setBusy(false)
    requestAnimationFrame(() => input.current?.focus())
    return error ? null : data as T
  }
  const event = () => crypto.randomUUID()

  const scan = (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    void run(() => createClient().rpc('wh_count_scan', { p_campaign: id, p_code: code.trim(), p_zone: zone || null, p_client_event_id: event() }),
      (d: { package_code: string; quantity: number; unit: string | null; other_bodega: boolean }) => `${d.package_code} contado · ${fmtN(d.quantity)} ${d.unit || ''}${d.other_bodega ? ' · figura en otra bodega' : ''}`)
      .then(d => { if (d) setCode('') })
  }
  const findExpected = async (e: FormEvent) => {
    e.preventDefault()
    const { data, error } = await createClient().rpc('wh_count_expected_search', { p_campaign: id, p_search: search.trim() || null })
    if (error) setError(error.message); else setExpected((data || []) as ExpectedLine[])
  }
  const labelRotulo = async (e: FormEvent, confirmOver = false) => {
    e.preventDefault()
    if (!pick) return
    const d = await run(() => createClient().rpc('wh_count_label', {
      p_campaign: id, p_linea: pick.linea, p_quantity: Number(rot.qty), p_weight_kg: rot.kg ? Number(rot.kg) : null, p_zone: zone || null,
      p_ipt_doc: rot.doc.trim() || null, p_seq: rot.seq ? Number(rot.seq) : null, p_total: rot.total ? Number(rot.total) : null, p_confirm_over: confirmOver, p_client_event_id: event(),
    }), (x: Label) => `${x.package_code} creado e impreso: pegue la etiqueta en el bulto.`)
    if (d) {
      setLabel(d as Label); setRot({ qty: '', kg: '', doc: rot.doc, seq: '', total: rot.total }); setPick(null)
      window.setTimeout(() => window.print(), 100)
    }
  }
  const supersStock = /supera el stock del ERP/i.test(error)
  const reprint = (l: CountLine) => {
    if (!l.package_code) return
    setLabel({ package_code: l.package_code, product: l.cod_producto || '', description: l.description || '', lote: l.lote_key, ot: l.ot, quantity: Number(l.quantity || 0), unit: l.unit, weight_kg: l.weight_kg, document: camp?.code || '', sequence_no: 0, sequence_total: 0, bodega: camp?.bodega || '' })
    window.setTimeout(() => window.print(), 100)
  }
  const voidLine = (l: CountLine) => {
    const reason = window.prompt('Motivo para anular esta línea (si creó una etiqueta, el paquete también se anula):')
    if (reason?.trim()) void run(() => createClient().rpc('wh_count_void_line', { p_line: l.id, p_reason: reason }), () => 'Línea anulada.')
  }
  const unidentified = (e: FormEvent) => {
    e.preventDefault()
    void run(() => createClient().rpc('wh_count_unidentified', { p_campaign: id, p_note: unknown, p_zone: zone || null, p_client_event_id: event() }), () => 'Bulto no identificado registrado para supervisión.')
      .then(d => { if (d) setUnknown('') })
  }
  const toReview = () => { if (window.confirm('¿Terminar el conteo general? Solo se podrán contar los lotes que se manden a reconteo.')) void run(() => createClient().rpc('wh_count_to_review', { p_campaign: id }), () => 'Campaña en revisión.') }
  const recount = () => {
    const lots = summary.filter(r => selected.has(lotKey(r))).map(r => ({ cod_producto: r.cod_producto, lote_key: r.lote_key }))
    void run(() => createClient().rpc('wh_count_recount', { p_campaign: id, p_lots: lots }), () => `${lots.length} lote(s) en reconteo: deben contarlos operarios distintos.`).then(() => setSelected(new Set()))
  }
  const close = () => {
    if (!window.confirm('¿Cerrar el inventario? Se liberan los paquetes retenidos y la bodega vuelve a operar.')) return
    void run(() => createClient().rpc('wh_count_close', { p_campaign: id, p_reasons: reasons }), (d: { released_packages: number }) => `Inventario cerrado. ${d.released_packages} paquete(s) liberados para picking.`)
  }

  if (!camp) return <div className="p-12 text-center text-slate-500">{error || <><Loader2 className="mx-auto animate-spin"/>Cargando inventario…</>}</div>
  const state = CAMPAIGN_STATE[camp.status] || CAMPAIGN_STATE.ANULADA
  const open = ['EN_CONTEO', 'EN_REVISION'].includes(camp.status)
  const diffs = summary.filter(r => r.result !== 'CUADRA')
  const counts = summary.reduce((a, r) => ({ ...a, [r.result]: (a[r.result] || 0) + 1 }), {} as Record<string, number>)

  return <div className="w-full space-y-4">
    <Link href="/almacen/inventario" className="inline-flex items-center gap-2 text-sm font-semibold text-blue-800 print:hidden"><ArrowLeft size={16}/>Inventario</Link>
    <header className="rounded-xl border border-slate-200 bg-white p-4 print:hidden">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black text-[#002855]">{camp.code}</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${state.style}`}>{state.label}</span>
        <span className="text-sm text-slate-600">{camp.bodega} · corte ERP {fmtDate(camp.erp_cut_at)}</span>
      </div>
      <p className="mt-1 text-sm text-slate-600">{camp.counted_lines} bultos contados · {camp.labeled} etiquetados · {camp.unidentified} no identificados · {camp.expected_lines} lotes en el ERP
        {open && <b className="ml-2 text-amber-800">Bodega congelada: no despacha ni etiqueta por IPT hasta el cierre.</b>}</p>
      <nav className="mt-3 flex gap-2">
        {(['barrido', 'cuadre'] as const).map(t => <button key={t} type="button" onClick={() => setTab(t)} className={`${btn} ${tab === t ? 'bg-[#002855] text-white' : 'border border-slate-300'}`}>{t === 'barrido' ? 'Barrido' : `Cuadre${diffs.length ? ` · ${diffs.length} diferencias` : ''}`}</button>)}
      </nav>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 print:hidden">{error}
      {supersStock && isSupervisor && pick && <button type="button" onClick={e => void labelRotulo(e as unknown as FormEvent, true)} className="ml-3 rounded-md bg-rose-800 px-2 py-1 text-xs font-bold text-white">Confirmar como supervisión</button>}</p>}
    {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 print:hidden">{message}</p>}

    {tab === 'barrido' && open && <div className="space-y-4 print:hidden">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          {camp.zones.length > 0 && <label className="text-sm font-semibold">Zona<select value={zone} onChange={e => setZone(e.target.value)} className={field}><option value="">—</option>{camp.zones.map(z => <option key={z} value={z}>{z}</option>)}</select></label>}
          <form onSubmit={scan} className="flex min-w-64 flex-1 gap-2">
            <input ref={input} value={code} onChange={e => setCode(e.target.value)} autoFocus autoComplete="off" placeholder="Escanee la etiqueta del bulto…" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-3 text-base"/>
            <button disabled={busy || !code.trim()} className={`${btn} bg-[#002855] text-white`}>{busy ? <Loader2 size={17} className="animate-spin"/> : <ScanLine size={17}/>}Contar</button>
          </form>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="flex items-center gap-2 font-bold text-[#002855]"><Tag size={16}/>Bulto con rótulo (sin etiqueta)</h2>
        <form onSubmit={findExpected} className="mt-2 flex gap-2">
          <div className="relative flex-1"><Search size={16} className="absolute left-3 top-3 text-slate-400"/>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="OT, lote o producto del rótulo" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"/></div>
          <button className={`${btn} border border-slate-300`}>Buscar</button>
        </form>
        {expected.length > 0 && !pick && <ul className="mt-2 max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">{expected.map(x =>
          <li key={x.linea}><button type="button" onClick={() => setPick(x)} className="flex w-full flex-wrap gap-x-3 px-3 py-2 text-left hover:bg-blue-50">
            <b>OT {x.ot || '—'}</b><span>lote {x.lote_raw || x.lote || '—'}</span><span className="font-semibold">{x.cod_producto}</span><span className="flex-1 truncate text-slate-600">{x.producto}</span>
            <span className="whitespace-nowrap text-xs text-slate-500">ERP {fmtN(x.stock)} · contado {fmtN(x.counted)} {x.unidad || ''}</span>
          </button></li>)}</ul>}
        {pick && <form onSubmit={e => void labelRotulo(e)} className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3">
          <p className="text-sm"><b>OT {pick.ot || '—'} · lote {pick.lote_raw || pick.lote} · {pick.cod_producto}</b> {pick.producto} <span className="text-slate-500">(ERP {fmtN(pick.stock)}, contado {fmtN(pick.counted)} {pick.unidad || ''})</span>
            <button type="button" onClick={() => setPick(null)} className="ml-2 text-xs font-semibold text-blue-800 underline">Cambiar</button></p>
          <div className="grid gap-3 sm:grid-cols-5">
            <label className="text-sm font-semibold">Cantidad*<input required type="number" min="0.001" step="0.001" value={rot.qty} onChange={e => setRot({ ...rot, qty: e.target.value })} className={field}/></label>
            <label className="text-sm font-semibold">Peso kg<input type="number" min="0" step="0.001" value={rot.kg} onChange={e => setRot({ ...rot, kg: e.target.value })} className={field}/></label>
            <label className="text-sm font-semibold">IPT del rótulo<input value={rot.doc} onChange={e => setRot({ ...rot, doc: e.target.value })} placeholder="Si figura" className={field}/></label>
            <label className="text-sm font-semibold">Bulto n°<input type="number" min="1" required={!!rot.doc.trim()} value={rot.seq} onChange={e => setRot({ ...rot, seq: e.target.value })} className={field}/></label>
            <label className="text-sm font-semibold">de total<input type="number" min="1" required={!!rot.doc.trim()} value={rot.total} onChange={e => setRot({ ...rot, total: e.target.value })} className={field}/></label>
          </div>
          <p className="text-xs text-slate-500">Con IPT y número de bulto, el sistema impide etiquetar dos veces el mismo bulto. Sin IPT, asigna una secuencia por lote.</p>
          <button disabled={busy} className={`${btn} bg-[#002855] text-white`}><Printer size={16}/>Etiquetar e imprimir</button>
        </form>}
      </section>

      {camp.status === 'EN_CONTEO' && <form onSubmit={unidentified} className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-4">
        <input value={unknown} onChange={e => setUnknown(e.target.value)} placeholder="Bulto que no se puede identificar: describa lo que dice el rótulo" className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
        <button disabled={busy || !unknown.trim()} className={`${btn} border border-slate-300`}>Registrar no identificado</button>
      </form>}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <h2 className="border-b p-3 font-bold text-[#002855]">Últimos bultos contados</h2>
        {lines.length === 0 ? <p className="p-4 text-sm text-slate-500">Todavía no hay conteos.</p> : <div className="divide-y text-sm">{lines.map(l =>
          <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${l.origin === 'ROTULO' ? 'bg-blue-100 text-blue-900' : l.origin === 'ETIQUETA' ? 'bg-slate-100 text-slate-700' : 'bg-rose-100 text-rose-900'}`}>{l.origin === 'ROTULO' ? 'Etiquetado' : l.origin === 'ETIQUETA' ? 'Escaneado' : 'No identificado'}</span>
            <b className="font-mono">{l.package_code || '—'}</b>
            <span>{l.cod_producto} · lote {l.lote_key || '—'} · OT {l.ot || '—'}</span>
            <span className="font-semibold">{fmtN(l.quantity)} {l.unit || ''}</span>
            {l.round > 1 && <span className="text-xs text-amber-800">reconteo {l.round}</span>}
            {l.other_bodega && <span className="text-xs text-amber-800">otra bodega</span>}
            {l.note && <span className="text-slate-600">{l.note}</span>}
            <span className="ml-auto text-xs text-slate-500">{l.zone ? `zona ${l.zone} · ` : ''}{l.counted_by_name} · {fmtDate(l.counted_at)}</span>
            {l.origin === 'ROTULO' && <button type="button" onClick={() => reprint(l)} className="text-xs font-semibold text-blue-800 underline">Reimprimir</button>}
            {(l.mine || isSupervisor) && <button type="button" onClick={() => voidLine(l)} className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700"><Undo2 size={12}/>Anular</button>}
          </div>)}</div>}
      </section>
    </div>}

    {tab === 'cuadre' && <section className="space-y-3 print:hidden">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
        {(['CUADRA', 'FALTANTE', 'SOBRANTE', 'NO_EN_ERP'] as const).map(k => <span key={k} className={`rounded-full px-2 py-0.5 text-xs font-bold ${RESULT_STYLE[k]}`}>{k.replace('_', ' ')} {counts[k] || 0}</span>)}
        {isSupervisor && open && <span className="ml-auto flex flex-wrap gap-2">
          {camp.status === 'EN_CONTEO' && <button type="button" disabled={busy} onClick={toReview} className={`${btn} border border-slate-300`}>Terminar conteo</button>}
          <button type="button" disabled={busy || selected.size === 0} onClick={recount} className={`${btn} border border-amber-400 text-amber-900`}>Recontar {selected.size || ''}</button>
          <button type="button" disabled={busy} onClick={close} className={`${btn} bg-emerald-700 text-white`}><CheckCircle2 size={16}/>Cerrar inventario</button>
        </span>}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-600"><tr>
          {isSupervisor && open && <th className="px-3 py-2"/>}<th className="px-3 py-2">OT</th><th className="px-3 py-2">Lote</th><th className="px-3 py-2">Producto</th>
          <th className="px-3 py-2 text-right">ERP</th><th className="px-3 py-2 text-right">Contado</th><th className="px-3 py-2 text-right">Diferencia</th><th className="px-3 py-2">Resultado</th>{open && isSupervisor && <th className="px-3 py-2">Motivo</th>}
        </tr></thead>
        <tbody className="divide-y divide-slate-100">{summary.map(r => <tr key={lotKey(r)}>
          {isSupervisor && open && <td className="px-3 py-1.5">{r.result !== 'CUADRA' && <input type="checkbox" aria-label="Recontar" checked={selected.has(lotKey(r))} onChange={e => setSelected(s => { const n = new Set(s); if (e.target.checked) n.add(lotKey(r)); else n.delete(lotKey(r)); return n })}/>}</td>}
          <td className="px-3 py-1.5 font-semibold">{r.ot || '—'}</td>
          <td className="px-3 py-1.5">{r.lote_key || '—'}{r.round > 1 && <small className="block text-amber-800">reconteo {r.round}</small>}</td>
          <td className="px-3 py-1.5"><b>{r.cod_producto}</b> <span className="text-slate-600">{r.producto}</span></td>
          <td className="px-3 py-1.5 text-right">{fmtN(r.expected)}</td>
          <td className="px-3 py-1.5 text-right">{fmtN(r.counted)} <small className="text-slate-500">({r.bultos})</small></td>
          <td className={`px-3 py-1.5 text-right font-semibold ${r.diff < 0 ? 'text-rose-700' : r.diff > 0 ? 'text-amber-800' : ''}`}>{fmtN(r.diff)}</td>
          <td className="px-3 py-1.5"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${RESULT_STYLE[r.result]}`}>{r.result.replace('_', ' ')}</span></td>
          {open && isSupervisor && <td className="px-3 py-1.5">{r.result !== 'CUADRA' && <input value={reasons[lotKey(r)] || ''} onChange={e => setReasons({ ...reasons, [lotKey(r)]: e.target.value })} placeholder="Motivo" className="w-48 rounded border border-slate-300 px-2 py-1 text-xs"/>}</td>}
        </tr>)}</tbody>
      </table></div>
    </section>}

    {label && <div id="inv-label" className="hidden print:block">
      <b style={{ display: 'block', fontSize: 18 }}>{label.product}</b>
      <span style={{ fontSize: 12 }}>{label.description}</span>
      <Code128Barcode value={label.package_code} height={56} className="my-2 w-full"/>
      <b style={{ display: 'block', textAlign: 'center', fontFamily: 'monospace' }}>{label.package_code}</b>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}><span>OT {label.ot || '—'} · lote {label.lote || '—'} · {label.document}</span><span>{label.sequence_no ? `${label.sequence_no}/${label.sequence_total}` : ''}</span></div>
      <b style={{ display: 'block', textAlign: 'right' }}>{fmtN(label.quantity)} {label.unit || ''}{label.weight_kg != null ? ` · ${fmtN(label.weight_kg)} kg` : ''}</b>
    </div>}
    {/* Diseño de 100 x 50 mm, escalado al formato de etiqueta de paquete configurado */}
    <style jsx global>{`@media print{@page{size:${labelFormat.width_mm}mm ${labelFormat.height_mm}mm;margin:0}body *{visibility:hidden}#inv-label,#inv-label *{visibility:visible}#inv-label{position:absolute;left:0;top:0;width:100mm;height:50mm;box-sizing:border-box;padding:5mm;color:#000;zoom:${fitScale(labelFormat, 100, 50)}}}`}</style>
  </div>
}
