'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowDownUp, Boxes, CalendarDays, Download, Factory, FileText, Package, Route, Search, Truck } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { exportAptXlsx } from '@/lib/apt/export'

// Detalle de una o varias guías de remisión con todos sus SKUs, tomado de la hoja SALIDA del ERP que se carga en
// Almacén APT (apt_guia_detalle). Se usa desde cualquier pantalla que muestre números de guía.

type Item = {
  producto: string; glosa: string | null; familia: string | null; cantidad: number | null; unidad: string | null
  peso_unitario: number | null; kg: number; lote: string | null; numrel: string | null; docrel: string | null; fecha_entrega: string | null
}
type Guia = {
  documento: string; fecha: string; cliente: string | null; ruc: string | null; bodega: string | null; lineas: number; tn: number
  lotes: string[] | null; tipos: string[] | null; unidades: Record<string, number> | null; items: Item[]
  origen: { produccion_min: string | null; produccion_max: string | null; dias_pond: number | null; por_origen: Record<string, number> | null } | null
  tms: { numero: string | null; estado: string | null; placa: string | null; conductor: string | null; salida: string | null; llegada: string | null } | null
}
type Resp = { success: boolean; error?: string; guias: Guia[]; no_encontradas: string[]; datos_hasta: string | null }

const nf = (d: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : nf(d).format(Number(v)))
const fmtQ = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 }).format(Number(v)))
const fdate = (v: string | null | undefined) => {
  if (!v) return '—'
  const [y, m, d] = v.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}
const ORIGEN: Record<string, string> = {
  PRODUCCION: 'Producción del periodo', INICIAL_647: 'Stock previo 647', INICIAL_540: 'Stock previo 540', INICIAL_ST: 'Stock previo ST',
  DEVOLUCION: 'Devolución', OTRO_ALMACEN: 'Otros almacenes (pernería/accesorios)',
}

type SortKey = 'producto' | 'glosa' | 'lote' | 'cantidad' | 'kg'

export function GuiaDetalleModal({ guias, onClose }: { guias: string | null; onClose: () => void }) {
  const [data, setData] = useState<Resp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState(0)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'lote', desc: false })

  useEffect(() => {
    if (!guias) return
    let alive = true
    createClient().rpc('apt_guia_detalle', { p_guias: guias }).then(({ data: d, error: e }) => {
      if (!alive) return
      const r = d as Resp | null
      if (e || !r?.success) { setError(e?.message || r?.error || 'No se pudo obtener la guía'); setData(null) }
      else { setData(r); setError(null) }
    })
    return () => { alive = false }
  }, [guias])

  const g = data?.guias[tab] ?? null
  const items = useMemo(() => {
    if (!g) return []
    const t = q.trim().toLowerCase()
    const rows = t ? g.items.filter(i => `${i.producto} ${i.glosa} ${i.lote} ${i.numrel}`.toLowerCase().includes(t)) : g.items
    const dir = sort.desc ? -1 : 1
    return [...rows].sort((a, b) => {
      const va = a[sort.k] ?? '', vb = b[sort.k] ?? ''
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es', { numeric: true })) * dir
    })
  }, [g, q, sort])
  const totKg = items.reduce((s, i) => s + Number(i.kg || 0), 0)

  const th = (k: SortKey, label: string, right = false) => (
    <th className={`px-3 py-2 ${right ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={() => setSort(s => ({ k, desc: s.k === k ? !s.desc : k === 'kg' || k === 'cantidad' }))}
        className={`inline-flex items-center gap-1 font-bold uppercase tracking-wider ${sort.k === k ? 'text-[#002855]' : 'text-slate-500 hover:text-slate-700'}`}>
        {label} <ArrowDownUp className="h-3 w-3 opacity-50" />
      </button>
    </th>
  )

  const exportar = () => {
    if (!data) return
    exportAptXlsx(`Guias_${(data.guias.map(x => x.documento).join('_') || 'detalle').slice(0, 60)}`, Object.fromEntries(data.guias.map(x => [x.documento,
      x.items.map(i => ({ Guía: x.documento, Fecha: x.fecha, Cliente: x.cliente, Lote: i.lote, NumRel: i.numrel, Tipo: i.docrel, Producto: i.producto,
        Glosa: i.glosa, Cantidad: i.cantidad, Unidad: i.unidad, 'Peso unit. (kg)': i.peso_unitario, 'Peso (kg)': i.kg, 'Fecha entrega': i.fecha_entrega }))])))
  }

  const title = guias ? `Guía de remisión · ${guias}` : 'Guía de remisión'
  return (
    <Modal isOpen={!!guias} onClose={onClose} title={title} maxWidth="max-w-7xl">
      {!data && !error && <div className="flex h-60 items-center justify-center text-sm text-slate-400">Buscando la guía en la SALIDA cargada…</div>}
      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {data && (
        <div className="space-y-4">
          {data.no_encontradas.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>No se encontró en la SALIDA cargada en Almacén APT (datos hasta {fdate(data.datos_hasta)}): <b>{data.no_encontradas.join(', ')}</b>.
                Verifique el número o cargue la SALIDA de esa fecha.</span>
            </p>
          )}
          {data.guias.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {data.guias.map((x, i) => (
                <button key={x.documento} type="button" onClick={() => { setTab(i); setQ('') }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold ${i === tab ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {x.documento} <span className="font-normal opacity-75">· {x.lineas} ítems</span>
                </button>
              ))}
            </div>
          )}
          {g && (
            <>
              <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
                <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-[#002855] to-[#0b3d7a] p-4 text-white">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-white/70"><FileText className="h-3.5 w-3.5" /> Guía de remisión</p>
                  <p className="mt-1 font-mono text-2xl font-black">{g.documento}</p>
                  <p className="mt-1 text-sm font-semibold">{g.cliente || 'Cliente no indicado'}</p>
                  <p className="text-xs text-white/70">RUC {g.ruc || '—'} · Emitida el {fdate(g.fecha)} · {g.bodega || '—'}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(g.tipos || []).map(t => <span key={t} className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-bold">{t}</span>)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Kpi icon={<Package className="h-3.5 w-3.5" />} label="Ítems (SKU)" value={String(g.lineas)} />
                  <Kpi icon={<Boxes className="h-3.5 w-3.5" />} label="Peso total" value={`${fmt(g.tn, 3)} TN`} />
                  <div className="col-span-2 rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Cantidades por unidad</p>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-slate-800">
                      {Object.entries(g.unidades || {}).map(([u, c]) => `${fmtQ(c)} ${u}`).join(' · ') || '—'}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Factory className="h-3.5 w-3.5" /> Origen (producción)</p>
                    {g.origen?.produccion_min ? (
                      <p className="mt-1 text-xs text-slate-700">Producido del <b>{fdate(g.origen.produccion_min)}</b> al <b>{fdate(g.origen.produccion_max)}</b>
                        {g.origen.dias_pond !== null && <> · <b>{fmt(g.origen.dias_pond, 1)} días</b> hasta la guía</>}</p>
                    ) : <p className="mt-1 text-xs text-slate-400">Sin trazabilidad a producción en el periodo cargado</p>}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {Object.entries(g.origen?.por_origen || {}).map(([o, tn]) => (
                        <span key={o} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">{ORIGEN[o] || o}: {fmt(tn, 3)} TN</span>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Truck className="h-3.5 w-3.5" /> Despacho en el TMS</p>
                    {g.tms ? (
                      <p className="mt-1 text-xs text-slate-700"><b>{g.tms.numero || 'Despacho'}</b> · {g.tms.estado || '—'} · {g.tms.placa || '—'} · {g.tms.conductor || '—'}</p>
                    ) : <p className="mt-1 text-xs text-slate-400">No registrada en el Asistente Documentario</p>}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar producto, glosa o lote…"
                    className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-3 text-sm outline-none focus:border-[#002855]" />
                </div>
                <div className="flex flex-wrap gap-1">
                  {(g.lotes || []).map(l => (
                    <Link key={l} href={`/apt/flujo/trazabilidad?q=${encodeURIComponent(l)}`} title="Ver la línea de tiempo del lote"
                      className="rounded-full border border-[#002855]/20 bg-[#002855]/5 px-2 py-1 font-mono text-[11px] font-bold text-[#002855] hover:bg-[#002855]/10">{l}</Link>
                  ))}
                </div>
                <Link href={`/apt/flujo/trazabilidad?q=${encodeURIComponent(g.documento)}`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:bg-slate-50">
                  <Route className="h-3.5 w-3.5" /> Trazabilidad
                </Link>
                <button type="button" onClick={exportar}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700">
                  <Download className="h-3.5 w-3.5" /> Excel
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full min-w-[960px] text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-[10px]">
                    <tr className="border-b border-slate-200">
                      <th className="px-3 py-2 text-left font-bold uppercase tracking-wider text-slate-500">#</th>
                      {th('producto', 'Producto')}
                      {th('glosa', 'Descripción')}
                      {th('lote', 'Lote / NumRel')}
                      {th('cantidad', 'Cantidad', true)}
                      <th className="px-3 py-2 text-left font-bold uppercase tracking-wider text-slate-500">Und.</th>
                      <th className="px-3 py-2 text-right font-bold uppercase tracking-wider text-slate-500">Peso unit. (kg)</th>
                      {th('kg', 'Peso (kg)', true)}
                      <th className="px-3 py-2 text-left font-bold uppercase tracking-wider text-slate-500"><CalendarDays className="inline h-3 w-3" /> F. entrega</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((i, n) => (
                      <tr key={`${i.producto}-${n}`} className="hover:bg-slate-50">
                        <td className="px-3 py-2 tabular-nums text-slate-400">{n + 1}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono font-semibold text-slate-800">{i.producto}</td>
                        <td className="px-3 py-2 text-slate-700">{i.glosa || '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className="font-mono font-semibold text-[#002855]">{i.lote || '—'}</span>
                          {i.numrel && i.numrel !== i.lote && <span className="ml-1 text-[10px] text-slate-400">({i.numrel})</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtQ(i.cantidad)}</td>
                        <td className="px-3 py-2 text-slate-500">{i.unidad || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmt(i.peso_unitario, 3)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmt(i.kg, 2)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{fdate(i.fecha_entrega)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-slate-600">{items.length} ítem(s){q && ` de ${g.items.length}`}</td>
                      <td colSpan={3} />
                      <td className="px-3 py-2 text-right tabular-nums text-slate-900">{fmt(totKg, 2)} kg</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">{icon} {label}</p>
      <p className="mt-1 text-xl font-black tabular-nums text-[#002855]">{value}</p>
    </div>
  )
}
