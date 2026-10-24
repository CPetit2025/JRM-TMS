'use client'

import { Fragment, useState } from 'react'
import { AlertTriangle, Download, FileUp, Search } from 'lucide-react'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import Link from 'next/link'
import { ErpVigencia } from '@/components/erp/ErpCarga'
import { AnalisisSection, CalidadSection, CargasLogSection, DiccionarioSection, ReglasSection, ReglasV1Aviso } from '@/components/erp/ErpAnalisis'
import { fmtN, fmtPeso } from '@/lib/inventario/format'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { erpApi } from '@/lib/erp/api'
import type { ErpGuia, ErpSituacion } from '@/lib/erp/types'

// ERP como fuente: Actualizable Despacho (OT, contrato, despachado, pendiente y cada despacho por guía) y Stock Bodega
// Despacho (stock por OT o subcontrato). Las guías se cruzan con las rutas del TMS para tener las dos fechas.
// «OT pendientes» y «Stock por OT» aplican las reglas heredadas (v1); «Análisis» usa el cruce exacto sin reglas.
const SECTIONS = [
  { key: 'analisis', label: 'Análisis (cruce exacto)' },
  { key: 'ots', label: 'OT pendientes (reglas v1)' },
  { key: 'guias', label: 'Guías: fecha ERP y fecha TMS' },
  { key: 'stock', label: 'Stock por OT (reglas v1)' },
  { key: 'calidad', label: 'Calidad de datos' },
  { key: 'reglas', label: 'Reglas y comparación' },
  { key: 'diccionario', label: 'Diccionario de indicadores' },
  { key: 'carga', label: 'Cargas' },
] as const
type Section = typeof SECTIONS[number]['key']

const input = 'min-h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm'
const iso = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const pct = (a: number, b: number) => b > 0 ? `${Math.round(a * 100 / b)} %` : '—'
const tn = (t: number | null | undefined) => t == null ? '—' : fmtPeso(Number(t) * 1000)

export default function ErpPage() {
  const estado = useInvQuery('erp-estado', () => erpApi.estado(), { keepPrevious: true })
  const [section, setSection] = useState<Section>('ots')
  const verReglas = () => setSection('reglas')
  if (!estado.data && estado.loading) return <LoadingBlock />
  if (!estado.data) return <ErrorBlock message={estado.error || 'Sin datos'} onRetry={estado.reload} />
  const e = estado.data
  const empty = !e.activas.CONTRATOS && !e.activas.STOCK
  return (
    <div className="space-y-4">
      <ErpVigencia estado={e} />
      <nav aria-label="Datos del ERP" className="flex flex-wrap gap-1.5">
        {SECTIONS.map(s => <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
          className={`rounded-full px-3 py-1.5 text-xs font-bold ${section === s.key ? 'bg-[#002855] text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'}`}>{s.label}</button>)}
      </nav>
      {empty && section !== 'carga' && section !== 'diccionario'
        ? <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">Aún no se cargan los Excel del ERP. Súbalos en <Link href="/apt/datos" className="font-semibold text-[#002855] underline">Cargar datos del ERP</Link>.</p>
        : section === 'analisis' ? <AnalisisSection /> : section === 'ots' ? <><ReglasV1Aviso onVer={verReglas} /><OtsSection /></>
        : section === 'guias' ? <GuiasSection /> : section === 'stock' ? <><ReglasV1Aviso onVer={verReglas} /><StockSection /></>
        : section === 'calidad' ? <CalidadSection /> : section === 'reglas' ? <ReglasSection /> : section === 'diccionario' ? <DiccionarioSection /> : <>
          {e.can_load && <Link href="/apt/datos" className="flex items-center gap-3 rounded-xl border border-[#002855]/20 bg-[#002855]/5 px-4 py-3 text-sm font-semibold text-[#002855] shadow-sm hover:bg-[#002855]/10">
            <FileUp className="h-5 w-5 shrink-0" />
            <span>Los dos archivos (Actualizable Despacho y Stock Bodega Despacho) se cargan juntos en «Cargar datos del ERP».</span>
          </Link>}
          <CargasLogSection />
          <ChartCard title="Historial de archivos aplicados">
            <Table empty={!e.historial.length} head={<tr><th className={th}>Fecha</th><th className={th}>Archivo</th><th className={th}>Estado</th><th className={th}>Corte del ERP</th><th className={`${th} text-right`}>Filas</th></tr>}>
              {e.historial.map(h => <tr key={h.id}><td className={td}>{fmtDateTime(h.applied_at ?? h.created_at)}</td><td className={`${td} max-w-80 truncate`} title={h.file_name}>{h.file_name}</td>
                <td className={td}>{h.status === 'ACTIVA' ? 'Vigente' : h.status === 'REEMPLAZADA' ? 'Reemplazada' : 'Incompleta'}</td><td className={td}>{h.cut_at ? fmtDateTime(h.cut_at) : '—'}</td><td className={tdNum}>{fmtN(h.rows)}</td></tr>)}
            </Table>
          </ChartCard>
        </>}
    </div>
  )
}

function OtsSection() {
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const [todas, setTodas] = useState(false)
  const [servicios, setServicios] = useState(false)
  const [errores, setErrores] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const args = { q: applied || undefined, estado: todas ? 'TODAS' as const : 'PENDIENTE' as const, incluir_servicios: servicios, incluir_errores: errores }
  const res = useInvQuery(`erp-ots|${JSON.stringify(args)}`, () => erpApi.ots(args))
  const exportXlsx = () => res.data && exportAptXlsx('OT_pendientes_ERP', {
    OT: res.data.ots.map(o => ({ OT: o.ot, Cliente: o.cliente, RUC: o.ruc, 'Fecha contrato': o.fecha_contrato, 'Fecha vencimiento': o.fecha_vcto, Vigente: o.vigente ? 'Sí' : 'No',
      Líneas: o.lineas, 'Líneas con pendiente': o.lineas_pendientes, Contratado: o.contrato, Despachado: o.despachado, Pendiente: o.pendiente,
      'Listo en stock': o.listo, 'Pendiente (t)': o.t_pendiente, 'Listo en stock (t)': o.t_listo, 'Peso completo': o.peso_completo ? 'Sí' : 'No', 'Último despacho': o.ult_despacho })),
  })
  return (
    <div className="space-y-3">
      <form onSubmit={ev => { ev.preventDefault(); setApplied(q.trim()) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="text-xs font-semibold text-slate-600">OT, cliente o RUC<input value={q} onChange={ev => setQ(ev.target.value)} placeholder="16497 o ALICORP" className={`mt-1 block w-56 ${input}`} /></label>
        <button type="submit" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Search className="h-4 w-4" />Buscar</button>
        {[['Incluir OT completas', todas, setTodas], ['Incluir servicios a terceros', servicios, setServicios], ['Incluir «Error de contrato»', errores, setErrores]].map(([label, v, set]) =>
          <label key={String(label)} className="flex min-h-10 items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" checked={v as boolean} onChange={ev => (set as (b: boolean) => void)(ev.target.checked)} />{label as string}</label>)}
        {res.data && <button type="button" onClick={exportXlsx} className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Excel</button>}
      </form>
      {res.loading ? <LoadingBlock /> : res.error ? <ErrorBlock message={res.error} onRetry={res.reload} /> : res.data && <ChartCard title={`${fmtN(res.data.total)} OT ${todas ? '' : 'con pendiente'}`}
        subtitle="Listo en stock = lo pendiente que ya tiene stock en el ERP con el lote de la OT o subcontrato. Ordenadas por lo listo para despachar.">
        <Table empty={!res.data.ots.length} head={<tr><th className={th}>OT</th><th className={th}>Cliente</th><th className={th}>Contrato</th><th className={`${th} text-right`}>Avance</th>
          <th className={`${th} text-right`}>Pendiente</th><th className={`${th} text-right`}>Listo en stock</th><th className={`${th} text-right`}>Líneas pend.</th><th className={th}>Último despacho</th></tr>}>
          {res.data.ots.map(o => <Fragment key={o.ot}>
            <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === o.ot ? null : o.ot)}>
              <td className={`${td} font-bold text-[#002855]`}>{o.ot}{!o.vigente && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">no vigente</span>}</td>
              <td className={`${td} max-w-64`}>{o.cliente || '—'}</td>
              <td className={td}>{fmtDate(o.fecha_contrato)}<span className="block text-[11px] text-slate-500">vence {fmtDate(o.fecha_vcto)}</span></td>
              <td className={tdNum}>{pct(o.despachado, o.contrato)}</td>
              <td className={tdNum}>{fmtN(o.pendiente)} und<span className="block text-[11px] text-slate-500">{tn(o.t_pendiente)}{!o.peso_completo && ' (parcial)'}</span></td>
              <td className={`${tdNum} font-semibold ${o.listo > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>{o.listo > 0 ? <>{fmtN(o.listo)} und<span className="block text-[11px] font-normal">{tn(o.t_listo)}</span></> : '—'}</td>
              <td className={tdNum}>{fmtN(o.lineas_pendientes)}{o.sobredespacho > 0 && <span className="block text-[11px] text-red-700">{o.sobredespacho} sobredesp.</span>}</td>
              <td className={td}>{fmtDate(o.ult_despacho)}</td>
            </tr>
            {open === o.ot && <tr><td colSpan={8} className="bg-slate-50 p-3"><OtDetalle ot={o.ot} /></td></tr>}
          </Fragment>)}
        </Table>
      </ChartCard>}
    </div>
  )
}

function ErpDate({ fecha, exacta }: { fecha: string | null; exacta?: boolean | null }) {
  if (!fecha) return <>—</>
  return <>{fmtDate(fecha)}{exacta === false && <span title="La línea tiene varias guías y la guía no está en las Salidas cargadas: es la fecha del último despacho de la línea" className="ml-1 text-[10px] font-bold text-amber-700">aprox.</span>}</>
}

function OtDetalle({ ot }: { ot: string }) {
  const res = useInvQuery(`erp-ot|${ot}`, () => erpApi.ot(ot))
  if (res.loading) return <LoadingBlock />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={res.reload} />
  const d = res.data
  const pend = d.lineas.filter(l => l.pendiente !== 0 || (l.listo ?? 0) > 0)
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-xs font-bold text-slate-700">Líneas con pendiente ({pend.length} de {d.lineas.length})</p>
        <Table empty={!pend.length} head={<tr><th className={th}>Documento</th><th className={th}>SKU</th><th className={th}>Producto (glosa)</th><th className={`${th} text-right`}>Contrato</th>
          <th className={`${th} text-right`}>Despachado</th><th className={`${th} text-right`}>Pendiente</th><th className={`${th} text-right`}>Stock ERP</th><th className={`${th} text-right`}>Listo</th></tr>}>
          {pend.map(l => <tr key={`${l.documento}-${l.secuencia}`}>
            <td className={td}>{l.documento}{l.tipo_documento === 'ERROR DE CONTRATO' && <span className="block text-[10px] text-amber-700">error de contrato</span>}</td>
            <td className={td}>{l.cod_producto}</td><td className={`${td} max-w-72`}>{l.producto}{l.color && <span className="block text-[11px] text-slate-500">{l.color}</span>}</td>
            <td className={tdNum}>{fmtN(l.contrato)}</td><td className={tdNum}>{fmtN(l.despachado)}</td>
            <td className={`${tdNum} ${l.pendiente < 0 ? 'text-red-700' : ''}`}>{fmtN(l.pendiente)}</td><td className={tdNum}>{l.stock == null ? '—' : fmtN(l.stock)}</td>
            <td className={`${tdNum} font-semibold text-emerald-700`}>{l.listo ? fmtN(l.listo) : '—'}</td>
          </tr>)}
        </Table>
      </div>
      <div>
        <p className="mb-1 text-xs font-bold text-slate-700">Guías despachadas ({d.guias.length})</p>
        <Table empty={!d.guias.length} head={<tr><th className={th}>Guía</th><th className={th}>Fecha ERP</th><th className={th}>Fecha TMS (programa)</th><th className={`${th} text-right`}>Dif.</th><th className={th}>Ruta · placa</th><th className={`${th} text-right`}>Ítems</th><th className={`${th} text-right`}>Cantidad</th><th className={th}>Documentos</th></tr>}>
          {d.guias.map(g => <tr key={g.guia}><td className={`${td} font-semibold`}>{g.guia}</td><td className={td}><ErpDate fecha={g.fecha_erp} exacta={g.erp_exacta} /></td><td className={td}>{g.fecha_tms ? fmtDate(g.fecha_tms) : <span className="text-slate-400">sin ruta en el TMS</span>}</td>
            <td className={tdNum}>{g.dif_dias ?? '—'}</td><td className={td}>{[g.rutas, g.placas].filter(Boolean).join(' · ') || '—'}</td><td className={tdNum}>{fmtN(g.items)}</td><td className={tdNum}>{fmtN(g.cantidad)}</td><td className={td}>{g.documentos}</td></tr>)}
        </Table>
      </div>
      {d.stock.length > 0 && <div>
        <p className="mb-1 text-xs font-bold text-slate-700">Stock del ERP con lote de esta OT ({d.stock.length})</p>
        <Table head={<tr><th className={th}>Bodega</th><th className={th}>Lote</th><th className={th}>SKU</th><th className={th}>Producto</th><th className={`${th} text-right`}>Stock</th><th className={`${th} text-right`}>Peso</th></tr>}>
          {d.stock.map((s, i) => <tr key={i}><td className={td}>{s.bodega}</td><td className={td}>{s.lote}</td><td className={td}>{s.cod_producto}</td><td className={`${td} max-w-72`}>{s.producto}</td>
            <td className={tdNum}>{fmtN(s.stock)} und</td><td className={tdNum}>{fmtPeso(s.kg)}</td></tr>)}
        </Table>
      </div>}
    </div>
  )
}

const ORIGEN: Record<ErpGuia['origen'], { label: string; tone: string }> = {
  AMBOS: { label: 'ERP y TMS', tone: 'bg-emerald-100 text-emerald-800' },
  SOLO_ERP: { label: 'Solo ERP', tone: 'bg-slate-100 text-slate-700' },
  SOLO_TMS: { label: 'Solo TMS', tone: 'bg-amber-100 text-amber-800' },
}

function GuiasSection() {
  const [desde, setDesde] = useState(() => iso(new Date(Date.now() - 30 * 86400000)))
  const [hasta, setHasta] = useState(() => iso(new Date()))
  const [referencia, setReferencia] = useState<'AUTO' | 'ERP' | 'TMS'>('AUTO')
  const [origen, setOrigen] = useState('TODAS')
  const [tolerancia, setTolerancia] = useState(2)
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const args = { desde, hasta, referencia, origen, tolerancia, q: applied || undefined, limit: 2000 }
  const res = useInvQuery(`erp-guias|${JSON.stringify(args)}`, () => erpApi.guias(args))
  const r = res.data?.resumen
  const exportXlsx = () => res.data && exportAptXlsx(`Guias_ERP_TMS_${desde}_${hasta}`, {
    Guías: res.data.guias.map(g => ({ Guía: g.guia, 'OT (ERP)': g.ots, 'OT (TMS)': g.ot_tms, Cliente: g.cliente, 'Fecha ERP': g.fecha_erp,
      'Fecha ERP exacta': g.erp_exacta == null ? '' : g.erp_exacta ? 'Sí' : 'No (último despacho de la línea)', 'Fecha TMS (programa)': g.fecha_tms,
      'Diferencia (días)': g.dif_dias, Ruta: g.rutas, Placa: g.placas, Ítems: g.items, Cantidad: g.cantidad, 'Peso kg': g.kg, Origen: ORIGEN[g.origen].label,
      'OT distinta': g.ot_distinta ? 'Sí' : '' })),
  })
  return (
    <div className="space-y-3">
      <form onSubmit={ev => { ev.preventDefault(); setApplied(q.trim()) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="text-xs font-semibold text-slate-600">Desde<input type="date" value={desde} max={hasta} onChange={ev => setDesde(ev.target.value)} className={`mt-1 block ${input}`} /></label>
        <label className="text-xs font-semibold text-slate-600">Hasta<input type="date" value={hasta} min={desde} onChange={ev => setHasta(ev.target.value)} className={`mt-1 block ${input}`} /></label>
        <label className="text-xs font-semibold text-slate-600">Fecha de referencia
          <select value={referencia} onChange={ev => setReferencia(ev.target.value as 'AUTO' | 'ERP' | 'TMS')} className={`mt-1 block ${input}`}>
            <option value="AUTO">Automática (TMS; si no hay, ERP)</option><option value="TMS">TMS (programa de entrega)</option><option value="ERP">ERP</option>
          </select></label>
        <label className="text-xs font-semibold text-slate-600">Tolerancia (días)<input type="number" min={0} max={30} value={tolerancia} onChange={ev => setTolerancia(Math.max(0, Number(ev.target.value) || 0))} className={`mt-1 block w-24 ${input}`} /></label>
        <label className="text-xs font-semibold text-slate-600">Guía u OT<input value={q} onChange={ev => setQ(ev.target.value)} placeholder="T001-6579 o 16497" className={`mt-1 block w-44 ${input}`} /></label>
        <button type="submit" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Search className="h-4 w-4" />Buscar</button>
        {res.data && <button type="button" onClick={exportXlsx} className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Excel</button>}
      </form>
      {r && <div className="flex flex-wrap gap-1.5">
        {([['TODAS', `Todas (${fmtN(r.total)})`], ['AMBOS', `ERP y TMS (${fmtN(r.ambos)})`], ['SOLO_ERP', `Solo ERP (${fmtN(r.solo_erp)})`], ['SOLO_TMS', `Solo TMS (${fmtN(r.solo_tms)})`],
          ['DESFASE', `Desfase u OT distinta (${fmtN(r.desfase + r.ot_distinta)})`]] as const).map(([k, label]) =>
          <button key={k} type="button" onClick={() => setOrigen(k)} aria-pressed={origen === k}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${origen === k ? 'bg-[#002855] text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'}`}>{label}</button>)}
        <span className="self-center text-xs text-slate-500">Peso: {fmtPeso(r.kg)} · {fmtN(r.erp_aproximada)} fecha(s) ERP aproximada(s)</span>
      </div>}
      {res.loading ? <LoadingBlock /> : res.error ? <ErrorBlock message={res.error} onRetry={res.reload} /> : res.data && <ChartCard title="Guías"
        subtitle="Fecha ERP: del Actualizable (exacta si la línea tiene una sola guía) o de las Salidas cargadas. Fecha TMS: salida programada de la ruta que llevó la guía. Solo TMS: guías registradas en rutas que el ERP no muestra (¿mal digitadas o aún no emitidas?).">
        <Table empty={!res.data.guias.length} head={<tr><th className={th}>Guía</th><th className={th}>OT</th><th className={th}>Cliente</th><th className={th}>Fecha ERP</th><th className={th}>Fecha TMS</th>
          <th className={`${th} text-right`}>Dif.</th><th className={th}>Ruta · placa</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Peso</th><th className={th}>Origen</th></tr>}>
          {res.data.guias.map(g => {
            const alert = (g.dif_dias != null && Math.abs(g.dif_dias) > tolerancia) || g.ot_distinta
            return <tr key={g.guia} className={alert ? 'bg-amber-50/60' : ''}>
              <td className={`${td} font-semibold`}>{g.guia}</td>
              <td className={td}>{g.ots || g.ot_tms || '—'}{g.ot_distinta && <span className="block text-[11px] font-semibold text-red-700">TMS: {g.ot_tms}</span>}</td>
              <td className={`${td} max-w-56`}>{g.cliente || '—'}</td>
              <td className={td}><ErpDate fecha={g.fecha_erp} exacta={g.erp_exacta} /></td><td className={td}>{g.fecha_tms ? fmtDate(g.fecha_tms) : '—'}</td>
              <td className={`${tdNum} ${alert ? 'font-bold text-amber-800' : ''}`}>{g.dif_dias ?? '—'}</td>
              <td className={td}>{[g.rutas, g.placas].filter(Boolean).join(' · ') || '—'}</td>
              <td className={tdNum}>{g.cantidad == null ? '—' : fmtN(g.cantidad)}{g.items ? <span className="block text-[11px] text-slate-500">{g.items} ítem(s)</span> : null}</td>
              <td className={tdNum}>{fmtPeso(g.kg)}</td>
              <td className={td}><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ORIGEN[g.origen].tone}`}>{ORIGEN[g.origen].label}</span>
                {alert && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-amber-600" aria-label="Revisar" />}</td>
            </tr>
          })}
        </Table>
      </ChartCard>}
    </div>
  )
}

const SITUACION: Record<ErpSituacion, { label: string; hint: string; tone: string }> = {
  LISTO: { label: 'Listo para despachar', hint: 'Tiene pendiente en su OT o subcontrato', tone: 'bg-emerald-100 text-emerald-800' },
  SOBRANTE: { label: 'Sobrante', hint: 'Supera lo pendiente de su documento', tone: 'bg-amber-100 text-amber-800' },
  OT_COMPLETA: { label: 'OT completa', hint: 'El documento ya no tiene pendiente', tone: 'bg-orange-100 text-orange-800' },
  SKU_FUERA_DE_CONTRATO: { label: 'SKU fuera del contrato', hint: 'El documento existe pero no tiene ese producto', tone: 'bg-red-100 text-red-800' },
  SIN_CONTRATO: { label: 'Lote sin OT', hint: 'El lote no es un documento del Actualizable', tone: 'bg-red-100 text-red-800' },
  SIN_LOTE: { label: 'Sin lote', hint: 'No se puede asociar a una OT', tone: 'bg-slate-100 text-slate-700' },
  NEGATIVO: { label: 'Stock negativo', hint: 'Revisar en el ERP', tone: 'bg-red-100 text-red-800' },
  SIN_ACTUALIZABLE: { label: 'Sin Actualizable', hint: 'Cargue el Actualizable para cruzar', tone: 'bg-slate-100 text-slate-700' },
}

function StockSection() {
  const [situacion, setSituacion] = useState('')
  const [bodega, setBodega] = useState('')
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const args = { situacion: situacion || undefined, bodega: bodega || undefined, q: applied || undefined, limit: 2000 }
  const res = useInvQuery(`erp-stock|${JSON.stringify(args)}`, () => erpApi.stock(args))
  const resumen = res.data?.resumen || []
  const bodegas = [...new Set(resumen.map(r => r.bodega))]
  const sits = (Object.keys(SITUACION) as ErpSituacion[]).filter(s => resumen.some(r => r.situacion === s))
  const exportXlsx = () => res.data && exportAptXlsx('Stock_ERP_por_OT', {
    Stock: res.data.lotes.map(l => ({ Bodega: l.bodega, Lote: l.lote, OT: l.ot, SKU: l.cod_producto, Producto: l.producto, Unidad: l.unidad, 'Stock (und)': l.stock,
      'Pendiente del documento': l.pendiente, 'Listo para despachar': l.listo, 'Peso kg': l.kg, Cliente: l.cliente, Situación: SITUACION[l.situacion].label })),
  })
  return (
    <div className="space-y-3">
      <ChartCard title="Stock del ERP según su OT" subtitle="Peso calculado por unidad (el ERP subestima el peso de los productos en cientos)">
        <Table head={<tr><th className={th}>Situación</th>{bodegas.map(b => <th key={b} className={`${th} text-right`}>{b}</th>)}</tr>}>
          {sits.map(s => <tr key={s} className="cursor-pointer hover:bg-slate-50" onClick={() => setSituacion(situacion === s ? '' : s)}>
            <td className={td}><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${SITUACION[s].tone}`}>{SITUACION[s].label}</span><span className="ml-2 text-[11px] text-slate-500">{SITUACION[s].hint}</span></td>
            {bodegas.map(b => { const r = resumen.find(x => x.bodega === b && x.situacion === s)
              return <td key={b} className={tdNum}>{r ? <>{fmtPeso(r.kg)}<span className="block text-[11px] text-slate-500">{fmtN(r.lotes)} lote(s)</span></> : '—'}</td> })}
          </tr>)}
        </Table>
      </ChartCard>
      <form onSubmit={ev => { ev.preventDefault(); setApplied(q.trim()) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="text-xs font-semibold text-slate-600">Situación<select value={situacion} onChange={ev => setSituacion(ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todas</option>{sits.map(s => <option key={s} value={s}>{SITUACION[s].label}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Bodega<select value={bodega} onChange={ev => setBodega(ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todas</option>{bodegas.map(b => <option key={b} value={b}>{b}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Lote, SKU o producto<input value={q} onChange={ev => setQ(ev.target.value)} className={`mt-1 block w-52 ${input}`} /></label>
        <button type="submit" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Search className="h-4 w-4" />Buscar</button>
        {res.data && <button type="button" onClick={exportXlsx} className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Excel</button>}
      </form>
      {res.loading ? <LoadingBlock /> : res.error ? <ErrorBlock message={res.error} onRetry={res.reload} /> : res.data && <ChartCard title={`${fmtN(res.data.lotes.length)} lote(s)`}>
        <Table empty={!res.data.lotes.length} head={<tr><th className={th}>Bodega</th><th className={th}>Lote</th><th className={th}>SKU</th><th className={th}>Producto</th><th className={`${th} text-right`}>Stock</th>
          <th className={`${th} text-right`}>Pendiente doc.</th><th className={`${th} text-right`}>Listo</th><th className={`${th} text-right`}>Peso</th><th className={th}>Situación</th></tr>}>
          {res.data.lotes.map((l, i) => <tr key={i}>
            <td className={td}>{l.bodega}</td><td className={`${td} font-semibold`}>{l.lote || '—'}</td><td className={td}>{l.cod_producto}</td><td className={`${td} max-w-72`}>{l.producto}{l.cliente && <span className="block text-[11px] text-slate-500">{l.cliente}</span>}</td>
            <td className={tdNum}>{fmtN(l.stock)}{l.unidad === 'CIEN' && <span className="block text-[10px] text-slate-500">und (ERP en cientos)</span>}</td>
            <td className={tdNum}>{l.pendiente == null ? '—' : fmtN(l.pendiente)}</td><td className={`${tdNum} text-emerald-700`}>{l.listo ? fmtN(l.listo) : '—'}</td>
            <td className={tdNum}>{fmtPeso(l.kg)}</td>
            <td className={td}><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${SITUACION[l.situacion].tone}`}>{SITUACION[l.situacion].label}</span></td>
          </tr>)}
        </Table>
      </ChartCard>}
    </div>
  )
}
