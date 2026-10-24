'use client'

import { Fragment, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Download, Info, Search } from 'lucide-react'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { fmtN, fmtQty } from '@/lib/inventario/format'
import { fmtDate, fmtDateTime, fmtPct } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { erpApi } from '@/lib/erp/api'
import { ERP_INDICADORES, ERP_META, ERP_RESPONSABLE } from '@/lib/erp/diccionario'
import type { ErpAnalisisDoc, ErpAnalisisFiltros, ErpAnalisisOt, ErpCargaLog, ErpControl, ErpCruce, ErpReglas } from '@/lib/erp/types'

// Pestañas de análisis del ERP con cruce exacto (sin reglas de conversión), calidad de datos, reglas heredadas y su
// comparación, diccionario de indicadores y registro de cargas. Ninguna cambia los indicadores existentes.
const input = 'min-h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm'
const btn = 'inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50'
const ratio = (v: number | null | undefined) => v == null ? '—' : fmtPct(Number(v) * 100)
const chip = (on: boolean) => `rounded-full px-3 py-1 text-xs font-semibold ${on ? 'bg-[#002855] text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'}`

export const CRUCE: Record<ErpCruce, { label: string; hint: string; tone: string }> = {
  COINCIDE: { label: 'Coincide', hint: 'Lote = documento, mismo producto y misma unidad', tone: 'bg-emerald-100 text-emerald-800' },
  UNIDAD_DISTINTA: { label: 'Unidad distinta', hint: 'Mismo lote y producto con otra unidad (p. ej. CIEN vs UND): sin equivalencia aprobada', tone: 'bg-amber-100 text-amber-800' },
  LOTE_CON_CEROS: { label: 'Lote con ceros', hint: 'El lote solo coincide quitando ceros a la izquierda: regla sin aprobar', tone: 'bg-amber-100 text-amber-800' },
  LOTE_CON_SUFIJO_D: { label: 'Lote con sufijo D', hint: 'El lote es el documento con «D» al final: significado sin confirmar', tone: 'bg-amber-100 text-amber-800' },
  SIN_COINCIDENCIA: { label: 'Sin coincidencia de stock', hint: 'No hay lote para este documento y producto (distinto de stock 0)', tone: 'bg-slate-100 text-slate-700' },
}
const TIPO_CONTROL = { ERROR: 'bg-red-100 text-red-800', REVISAR: 'bg-amber-100 text-amber-800', INFORMATIVO: 'bg-slate-100 text-slate-700' } as const

const label = (k: string) => k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
const cell = (v: unknown) => v == null ? '—' : typeof v === 'number' ? fmtQty(v) : typeof v === 'boolean' ? (v ? 'Sí' : 'No')
  : typeof v === 'object' ? JSON.stringify(v) : /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? fmtDateTime(String(v)) : String(v)

// Tabla genérica para ejemplos y listas devueltas por la base
export function RowsTable({ rows, max = 50 }: { rows: Array<Record<string, unknown>> | null | undefined; max?: number }) {
  if (!rows?.length) return <p className="text-xs text-slate-500">Sin casos en los cortes vigentes.</p>
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))]
  return (
    <Table head={<tr>{keys.map(k => <th key={k} className={th}>{label(k)}</th>)}</tr>}>
      {rows.slice(0, max).map((r, i) => <tr key={i}>{keys.map(k => <td key={k} className={typeof r[k] === 'number' ? tdNum : td}>{cell(r[k])}</td>)}</tr>)}
    </Table>
  )
}

// Aviso en las pestañas existentes: siguen con las reglas heredadas (versión 1), sin cambios
export function ReglasV1Aviso({ onVer }: { onVer: () => void }) {
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">Esta vista aplica las <b>reglas heredadas (versión 1, sin aprobación comercial)</b>: stock en CIEN × 100, lote sin ceros a la izquierda,
        peso = stock × factor × Peso_Unitario, total de la OT sumando tipos de documento y unidades, y exclusión por defecto de «ERROR DE CONTRATO» y
        «SERVICIO A TERCEROS» (casillas para incluirlos). Sus resultados no cambian. Para cifras sin estas reglas use «Análisis (cruce exacto)».</p>
      <button type="button" onClick={onVer} className="font-semibold underline">Ver impacto de cada regla</button>
    </div>
  )
}

// Marcas de tiempo: corte del ERP (de cuándo son los datos) y procesado en el TMS (cuándo se aplicaron)
function Marcas() {
  const res = useInvQuery('erp-cargas-log', () => erpApi.cargas(30), { keepPrevious: true })
  const a = res.data?.activas
  if (!a) return null
  return (
    <p className="text-xs text-slate-600">
      {(['CONTRATOS', 'STOCK'] as const).map(k => a[k] && <span key={k} className="mr-3 inline-block">
        <b>{k === 'CONTRATOS' ? 'Actualizable' : 'Stock'}</b>: corte ERP {fmtDateTime(a[k]!.corte_erp)} · procesado TMS {fmtDateTime(a[k]!.procesado_tms)} · reglas v{a[k]!.version_reglas ?? '—'}
      </span>)}
    </p>
  )
}

const TIPOS = ['CONTRATO DE VENTAS', 'SUBCONTRATO DE VENTAS', 'GARANTIA DE VENTAS', 'ERROR DE CONTRATO']
const ESTADOS = ['SIN DESPACHO', 'PARCIAL', 'COMPLETO']
const BODEGAS = ['647-04 ALM PT', '540-04 APT LB', 'ST-VENTAS-IMD']
const PAGE = 200

export function AnalisisSection() {
  const [form, setForm] = useState<ErpAnalisisFiltros>({ solo_pendiente: true })
  const [applied, setApplied] = useState<ErpAnalisisFiltros>({ solo_pendiente: true })
  const [vista, setVista] = useState<'DOCUMENTO' | 'OT'>('DOCUMENTO')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const args: ErpAnalisisFiltros = { ...applied, vista, limit: PAGE, offset }
  const res = useInvQuery(`erp-analisis|${JSON.stringify(args)}`, () => erpApi.analisis(args), { keepPrevious: true })
  // Mientras llega la otra vista se muestra la anterior solo si tiene la misma forma
  const d = res.data && (res.data.sin_datos || res.data.vista === vista) ? res.data : null
  const set = (k: keyof ErpAnalisisFiltros, v: string | boolean) => setForm(f => ({ ...f, [k]: v === '' ? undefined : v }))
  const apply = (next: ErpAnalisisFiltros) => { setApplied(next); setOffset(0); setOpen(null) }
  const exportXlsx = async () => {
    setExporting(true)
    try {
      const [docs, ots] = await Promise.all([erpApi.analisis({ ...applied, vista: 'DOCUMENTO', limit: 20000 }), erpApi.analisis({ ...applied, vista: 'OT', limit: 20000 })])
      exportAptXlsx('Analisis_ERP_cruce_exacto', {
        'Resumen unidad y tipo': docs.resumen.map(r => ({ Unidad: r.unidad, 'Tipo de documento': r.tipo_documento, Documentos: r.documentos, Líneas: r.lineas,
          Contratado: r.contratado, Despachado: r.despachado, Reemplazado: r.reemplazado, Pendiente: r.pendiente, Avance: r.avance,
          'Stock coincidente': r.stock_coincidente, Faltante: r.faltante, Cobertura: r.cobertura, 'Con pendiente': r.con_pendiente,
          'Pendiente con stock': r.pendiente_con_stock, Sobredespacho: r.sobredespacho, 'Fecha de vencimiento superada': r.vencidas })),
        'Documento y producto': (docs.filas as ErpAnalisisDoc[]).map(r => ({ OT: r.ot, Documento: r.documento, 'Tipo de documento': r.tipo_documento, Cliente: r.cliente, RUC: r.ruc,
          SKU: r.cod_producto, Producto: r.producto, Familia: r.familia, 'Unidad (ERP)': r.unidad, Líneas: r.lineas, 'Filas del Excel': r.filas_origen.join(', '),
          Contratado: r.contratado, Despachado: r.despachado, Reemplazado: r.reemplazado, Pendiente: r.pendiente, Avance: r.avance,
          'Stock coincidente': r.stock, 'Lotes': r.lotes, Bodegas: r.bodegas, Cruce: CRUCE[r.cruce].label, Faltante: r.faltante, Cobertura: r.cobertura,
          'Fecha contrato': r.fecha_contrato, 'Fecha_Vcto': r.fecha_vcto, 'Fecha de vencimiento superada': r.vencida ? 'Sí' : '', 'Vigencia (ERP)': r.vigencia,
          'Estado (ERP)': r.estados, 'Último despacho': r.ult_despacho, 'Antigüedad (días)': r.antiguedad, 'Cantidades ausentes': r.dato_ausente ? 'Sí' : '' })),
        'OT por tipo y unidad': (ots.filas as ErpAnalisisOt[]).map(r => ({ OT: r.ot, 'Tipo de documento': r.tipo_documento, Unidad: r.unidad, Cliente: r.cliente,
          Documentos: r.documentos, Contratado: r.contratado, Despachado: r.despachado, Pendiente: r.pendiente, 'Stock coincidente': r.stock, Faltante: r.faltante,
          Avance: r.avance, Cobertura: r.cobertura, 'Con stock': r.con_stock, 'Fecha de vencimiento superada': r.vencidas })),
      })
    } finally { setExporting(false) }
  }
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        <p><b>Cruce exacto, sin reglas de conversión.</b> El stock se asigna solo cuando Lote = Nro_Documento, con el mismo Cod_Producto y la misma unidad del ERP
          (se normalizan espacios y mayúsculas; se conservan ceros iniciales y sufijos). Las unidades y los tipos de documento no se suman entre sí: contratos,
          subcontratos, garantías y errores se presentan por separado. «Sin coincidencia de stock» (—) no es lo mismo que stock coincidente igual a 0.</p>
        <Marcas />
      </div>
      <form onSubmit={ev => { ev.preventDefault(); apply(form) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        {([['ot', 'OT', '16497', 'w-28'], ['documento', 'Documento', '16497-2', 'w-28'], ['cliente', 'Cliente o RUC', 'ALICORP', 'w-40'], ['producto', 'SKU o producto', '501.02', 'w-36'],
          ['familia', 'Familia', '', 'w-32']] as const).map(([k, l, ph, w]) =>
          <label key={k} className="text-xs font-semibold text-slate-600">{l}<input value={String(form[k] ?? '')} onChange={ev => set(k, ev.target.value)} placeholder={ph} className={`mt-1 block ${w} ${input}`} /></label>)}
        <label className="text-xs font-semibold text-slate-600">Tipo de documento<select value={form.tipo_documento ?? ''} onChange={ev => set('tipo_documento', ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todos (por separado)</option>{TIPOS.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Estado (ERP)<select value={form.estado ?? ''} onChange={ev => set('estado', ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todos</option>{ESTADOS.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Unidad (ERP)<input value={form.unidad ?? ''} onChange={ev => set('unidad', ev.target.value)} placeholder="UND, CIEN…" className={`mt-1 block w-24 ${input}`} /></label>
        <label className="text-xs font-semibold text-slate-600">Bodega<select value={form.bodega ?? ''} onChange={ev => set('bodega', ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todas</option>{BODEGAS.map(b => <option key={b} value={b}>{b}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">Vigencia_Contrato (ERP)<select value={form.vigencia ?? ''} onChange={ev => set('vigencia', ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todas</option><option value="S">S</option><option value="N">N</option></select></label>
        <label className="text-xs font-semibold text-slate-600">Cruce<select value={form.cruce ?? ''} onChange={ev => set('cruce', ev.target.value)} className={`mt-1 block ${input}`}>
          <option value="">Todos</option>{(Object.keys(CRUCE) as ErpCruce[]).map(c => <option key={c} value={c}>{CRUCE[c].label}</option>)}</select></label>
        <label className="flex min-h-10 items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" checked={!!form.solo_pendiente} onChange={ev => set('solo_pendiente', ev.target.checked)} />Solo con pendiente</label>
        <label className="flex min-h-10 items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" checked={!!form.vencida} onChange={ev => set('vencida', ev.target.checked)} />Fecha de vencimiento superada</label>
        <button type="submit" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Search className="h-4 w-4" />Aplicar</button>
        <button type="button" onClick={() => { setForm({ solo_pendiente: true }); apply({ solo_pendiente: true }) }} className={btn}>Limpiar</button>
        {d && !d.sin_datos && <button type="button" onClick={exportXlsx} disabled={exporting} className={`ml-auto ${btn}`}><Download className="h-4 w-4" />{exporting ? 'Exportando…' : 'Excel'}</button>}
      </form>
      {!d && !res.error ? <LoadingBlock /> : res.error ? <ErrorBlock message={res.error} onRetry={res.reload} /> : d?.sin_datos ? <p className="text-sm text-slate-500">Cargue el Actualizable.</p> : d && <>
        {!d.unidad_original && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">El Actualizable vigente se cargó antes de guardar la unidad original: UNID aparece como UND. Vuelva a cargarlo para ver la unidad del ERP.</p>}
        <ChartCard title="Resumen por unidad y tipo de documento" subtitle="Porcentajes calculados desde las sumas. Las filas no se suman entre sí: cada una tiene su unidad y su tipo de documento.">
          <Table empty={!d.resumen.length} head={<tr><th className={th}>Unidad</th><th className={th}>Tipo de documento</th><th className={`${th} text-right`}>Documentos</th>
            <th className={`${th} text-right`}>Contratado</th><th className={`${th} text-right`}>Despachado</th><th className={`${th} text-right`}>Pendiente</th><th className={`${th} text-right`}>Avance</th>
            <th className={`${th} text-right`}>Stock coincidente</th><th className={`${th} text-right`}>Faltante</th><th className={`${th} text-right`}>Cobertura</th>
            <th className={`${th} text-right`}>Con pend. / con stock</th><th className={`${th} text-right`}>Sobredesp.</th><th className={`${th} text-right`}>Vcto. superado</th></tr>}>
            {d.resumen.map(r => <tr key={`${r.unidad}|${r.tipo_documento}`} className="cursor-pointer hover:bg-slate-50"
              onClick={() => { const n = { ...applied, unidad: r.unidad, tipo_documento: r.tipo_documento ?? undefined }; setForm(n); apply(n) }}>
              <td className={`${td} font-semibold`}>{r.unidad}</td><td className={td}>{r.tipo_documento ?? '—'}</td><td className={tdNum}>{fmtN(r.documentos)}</td>
              <td className={tdNum}>{fmtQty(r.contratado)}</td><td className={tdNum}>{fmtQty(r.despachado)}</td><td className={tdNum}>{fmtQty(r.pendiente)}</td><td className={tdNum}>{ratio(r.avance)}</td>
              <td className={tdNum}>{fmtQty(r.stock_coincidente)}</td><td className={tdNum}>{fmtQty(r.faltante)}</td><td className={tdNum}>{ratio(r.cobertura)}</td>
              <td className={tdNum}>{fmtN(r.con_pendiente)} / {fmtN(r.pendiente_con_stock)}</td><td className={tdNum}>{fmtN(r.sobredespacho)}</td><td className={tdNum}>{fmtN(r.vencidas)}</td>
            </tr>)}
          </Table>
        </ChartCard>
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(CRUCE) as ErpCruce[]).filter(c => d.cruces[c]).map(c => <button key={c} type="button" title={CRUCE[c].hint} aria-pressed={applied.cruce === c}
            onClick={() => { const n = { ...applied, cruce: applied.cruce === c ? undefined : c }; setForm(n); apply(n) }} className={chip(applied.cruce === c)}>{CRUCE[c].label} ({fmtN(d.cruces[c])})</button>)}
          <span className="mx-2 h-5 w-px bg-slate-200" />
          {(['DOCUMENTO', 'OT'] as const).map(v => <button key={v} type="button" aria-pressed={vista === v} onClick={() => { setVista(v); setOffset(0); setOpen(null) }} className={chip(vista === v)}>
            {v === 'DOCUMENTO' ? 'Por documento y producto' : 'Por OT, tipo y unidad'}</button>)}
        </div>
        <ChartCard title={`${fmtN(d.total)} ${vista === 'OT' ? 'renglones de OT' : 'documentos y productos'}`}
          subtitle={vista === 'OT' ? 'Un renglón por OT, tipo de documento y unidad: no se presenta una demanda neta por OT mientras no se defina la relación entre tipos.' : 'Pulse una fila para ver sus líneas del ERP (con su fila de origen), los lotes y las guías.'}
          actions={<Pager total={d.total} offset={offset} onChange={setOffset} />}>
          {vista === 'OT'
            ? <Table empty={!d.filas.length} head={<tr><th className={th}>OT</th><th className={th}>Tipo de documento</th><th className={th}>Unidad</th><th className={th}>Cliente</th>
              <th className={`${th} text-right`}>Contratado</th><th className={`${th} text-right`}>Despachado</th><th className={`${th} text-right`}>Pendiente</th>
              <th className={`${th} text-right`}>Stock coincidente</th><th className={`${th} text-right`}>Faltante</th><th className={`${th} text-right`}>Cobertura</th><th className={`${th} text-right`}>Vcto. superado</th></tr>}>
              {(d.filas as ErpAnalisisOt[]).map(r => <tr key={`${r.ot}|${r.tipo_documento}|${r.unidad}`}>
                <td className={`${td} font-bold text-[#002855]`}>{r.ot}</td><td className={td}>{r.tipo_documento ?? '—'}</td><td className={td}>{r.unidad}</td><td className={`${td} max-w-56`}>{r.cliente ?? '—'}</td>
                <td className={tdNum}>{fmtQty(r.contratado)}</td><td className={tdNum}>{fmtQty(r.despachado)}</td><td className={tdNum}>{fmtQty(r.pendiente)}</td>
                <td className={tdNum}>{fmtQty(r.stock)}</td><td className={tdNum}>{fmtQty(r.faltante)}</td><td className={tdNum}>{ratio(r.cobertura)}</td><td className={tdNum}>{fmtN(r.vencidas)}</td>
              </tr>)}
            </Table>
            : <Table empty={!d.filas.length} head={<tr><th className={th}>Documento</th><th className={th}>SKU · producto</th><th className={th}>Unidad</th>
              <th className={`${th} text-right`}>Contratado</th><th className={`${th} text-right`}>Despachado</th><th className={`${th} text-right`}>Pendiente</th>
              <th className={`${th} text-right`}>Stock coincidente</th><th className={`${th} text-right`}>Faltante</th><th className={`${th} text-right`}>Cobertura</th><th className={th}>Cruce</th><th className={th}>Fecha_Vcto</th></tr>}>
              {(d.filas as ErpAnalisisDoc[]).map(r => { const key = `${r.documento}|${r.cod_producto}|${r.unidad}`
                return <Fragment key={key}>
                  <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === key ? null : key)}>
                    <td className={td}><span className="inline-flex items-center gap-1 font-semibold text-[#002855]">{open === key ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{r.documento}</span>
                      <span className="block text-[11px] text-slate-500">{r.tipo_documento}{r.lineas > 1 ? ` · ${r.lineas} líneas` : ''}</span></td>
                    <td className={`${td} max-w-72`}>{r.cod_producto}<span className="block text-[11px] text-slate-500">{r.producto}</span>{r.cliente && <span className="block text-[11px] text-slate-400">{r.cliente}</span>}</td>
                    <td className={td}>{r.unidad}</td>
                    <td className={tdNum}>{fmtQty(r.contratado)}</td><td className={tdNum}>{fmtQty(r.despachado)}</td>
                    <td className={`${tdNum} ${r.pendiente < 0 ? 'text-red-700' : ''}`}>{fmtQty(r.pendiente)}{r.dato_ausente && <span className="block text-[10px] text-amber-700">cantidades ausentes</span>}</td>
                    <td className={tdNum}>{r.stock == null ? <span className="text-slate-400" title="Sin coincidencia de stock">—</span> : fmtQty(r.stock)}{r.bodegas && <span className="block text-[10px] text-slate-500">{r.bodegas}</span>}</td>
                    <td className={tdNum}>{fmtQty(r.faltante)}</td><td className={tdNum}>{ratio(r.cobertura)}</td>
                    <td className={td}><span title={CRUCE[r.cruce].hint} className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${CRUCE[r.cruce].tone}`}>{CRUCE[r.cruce].label}</span></td>
                    <td className={td}>{fmtDate(r.fecha_vcto)}{r.vencida && <span className="block text-[10px] font-semibold text-amber-800">vencimiento superado</span>}
                      {r.vigencia && <span className="block text-[10px] text-slate-500">Vigencia ERP: {r.vigencia}</span>}</td>
                  </tr>
                  {open === key && <tr><td colSpan={11} className="bg-slate-50 p-3"><DocDetalle doc={r} /></td></tr>}
                </Fragment> })}
            </Table>}
        </ChartCard>
      </>}
    </div>
  )
}

function Pager({ total, offset, onChange }: { total: number; offset: number; onChange: (o: number) => void }) {
  if (total <= PAGE) return null
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <button type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE))} className={`${btn} min-h-8 disabled:opacity-40`}>Anterior</button>
      <span>{fmtN(offset + 1)}–{fmtN(Math.min(offset + PAGE, total))} de {fmtN(total)}</span>
      <button type="button" disabled={offset + PAGE >= total} onClick={() => onChange(offset + PAGE)} className={`${btn} min-h-8 disabled:opacity-40`}>Siguiente</button>
    </div>
  )
}

function DocDetalle({ doc }: { doc: ErpAnalisisDoc }) {
  const res = useInvQuery(`erp-analisis-det|${doc.documento}|${doc.cod_producto}|${doc.unidad}`, () => erpApi.analisisDetalle(doc.documento, doc.cod_producto, doc.unidad))
  if (res.loading) return <LoadingBlock className="h-24" />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={res.reload} />
  const d = res.data
  return (
    <div className="space-y-3">
      <div><p className="mb-1 text-xs font-bold text-slate-700">Líneas del Actualizable ({d.lineas.length})</p>
        <RowsTable rows={d.lineas.map(l => ({ 'Fila del Excel': l.fila_origen, Tipo: l.tipo_documento, Correlativo: l.correlativo, Secuencia: l.secuencia, 'Unidad ERP': l.unidad_erp,
          Contratado: l.contratado, Despachado: l.despachado, Reemplazado: l.reemplazado, Pendiente: l.pendiente, 'Estado ERP': l.estado, 'Vigencia ERP': l.vigencia,
          'Fecha contrato': l.fecha_contrato, Fecha_Vcto: l.fecha_vcto, 'Último despacho': l.ult_despacho, Guías: l.guias, 'Cantidades ausentes': l.dato_ausente }))} /></div>
      <div><p className="mb-1 text-xs font-bold text-slate-700">Lotes del Stock con este documento y producto ({d.lotes.length})</p>
        <p className="mb-1 text-[11px] text-slate-500">Incluye lotes con ceros a la izquierda o sufijo D y otras unidades; solo los marcados «coincide» suman al stock coincidente.</p>
        <RowsTable rows={d.lotes.map(l => ({ 'Fila del Excel': l.fila_origen, Bodega: l.bodega, Lote: l.lote, Unidad: l.unidad, Stock: l.stock, 'Stock en falla': l.stock_falla,
          'Peso unitario': l.peso_unitario, 'Peso total (ERP)': l.peso_total_erp, Coincide: l.coincide }))} /></div>
      <div><p className="mb-1 text-xs font-bold text-slate-700">Guías ({d.guias.length})</p>
        <RowsTable rows={d.guias.map(g => ({ Guía: g.guia, Secuencia: g.secuencia, Cantidad: g.cantidad, 'Fecha ERP': g.fecha_erp, 'Fecha exacta': g.fecha_erp_exacta }))} /></div>
    </div>
  )
}

export function CalidadSection() {
  const res = useInvQuery('erp-calidad', () => erpApi.calidad())
  const [open, setOpen] = useState<string | null>(null)
  if (res.loading) return <LoadingBlock />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={res.reload} />
  const { controles, cortes } = res.data
  const exportXlsx = () => exportAptXlsx('Calidad_datos_ERP', {
    Controles: controles.map(c => ({ Código: c.codigo, Archivo: c.origen, Control: c.titulo, Tipo: c.tipo, Cantidad: c.cantidad })),
    ...Object.fromEntries(controles.filter(c => c.ejemplos?.length).map(c => [c.codigo, c.ejemplos!])),
  })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm">
        <span>Cortes analizados: <b>Actualizable</b> {fmtDateTime(cortes.contratos)} (procesado {fmtDateTime(cortes.contratos_procesado)}) · <b>Stock</b> {fmtDateTime(cortes.stock)} (procesado {fmtDateTime(cortes.stock_procesado)})</span>
        <button type="button" onClick={exportXlsx} className={`ml-auto ${btn}`}><Download className="h-4 w-4" />Excel</button>
      </div>
      <ChartCard title="Controles de calidad de datos" subtitle="ERROR: el dato no se puede usar como está. REVISAR: requiere validación con el área dueña. INFORMATIVO: característica del archivo que limita la interpretación. Pulse un control para ver ejemplos.">
        <Table head={<tr><th className={th}>Código</th><th className={th}>Archivo</th><th className={th}>Control</th><th className={th}>Tipo</th><th className={`${th} text-right`}>Casos</th></tr>}>
          {controles.map((c: ErpControl) => <Fragment key={c.codigo}>
            <tr className={`hover:bg-slate-50 ${c.ejemplos?.length ? 'cursor-pointer' : ''}`} onClick={() => c.ejemplos?.length && setOpen(open === c.codigo ? null : c.codigo)}>
              <td className={`${td} font-semibold`}>{c.codigo}</td><td className={td}>{c.origen}</td><td className={`${td} max-w-xl`}>{c.titulo}</td>
              <td className={td}><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${c.cantidad > 0 ? TIPO_CONTROL[c.tipo] : 'bg-emerald-50 text-emerald-700'}`}>{c.cantidad > 0 ? c.tipo : 'OK'}</span></td>
              <td className={tdNum}>{fmtN(c.cantidad)}{c.codigo === 'X02' ? ' h' : ''}</td>
            </tr>
            {open === c.codigo && <tr><td colSpan={5} className="bg-slate-50 p-3"><RowsTable rows={c.ejemplos} /></td></tr>}
          </Fragment>)}
        </Table>
      </ChartCard>
    </div>
  )
}

// Decisiones que no se toman en el sistema: quedan visibles hasta que el área comercial las defina
export const DECISIONES_PENDIENTES = [
  'CIEN → UND: confirmar la equivalencia por producto (el archivo no trae factor; hoy se supone 1 CIEN = 100 UND).',
  'Peso: confirmar si Peso_Unitario es por unidad o por la unidad del stock (CIEN). Hoy el ERP calcula Peso_Total = stock × Peso_Unitario.',
  'Lotes con ceros a la izquierda: aprobar o no la clave auxiliar sin ceros para cruzar con el documento.',
  'Lotes con sufijo D: confirmar su significado.',
  'Relación entre contrato, subcontratos, garantías y errores para una demanda neta por OT.',
  'Tratamiento de «ERROR DE CONTRATO» y «SERVICIO A TERCEROS» en los indicadores.',
  'Significado de Fecha_Vcto y de Vigencia_Contrato.',
  'Equivalencias entre las escrituras de unidad (und, UNID, UNUD…).',
  'Uso de Stock_Falla y Stock_Comprometido (hoy no se descuentan).',
  'Metas y responsables de cada indicador.',
]

export function ReglasSection() {
  const res = useInvQuery('erp-reglas', () => erpApi.reglas())
  if (res.loading) return <LoadingBlock />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={res.reload} />
  const d: ErpReglas = res.data
  if (d.sin_datos) return <p className="text-sm text-slate-500">Cargue los dos archivos del ERP para comparar.</p>
  const v = d.regla_vigente
  const exportXlsx = () => exportAptXlsx('Comparacion_reglas_ERP', {
    Reglas: (v?.reglas ?? []).map(r => ({ Código: r.codigo, Regla: r.titulo, Detalle: r.detalle, 'Se aplica en': r.aplica_en.join(' · '), Versión: v?.version, Origen: v?.origen })),
    'CIEN catálogo': d.CIEN_A_UND.catalogo ?? [], 'CIEN ejemplos': d.CIEN_A_UND.ejemplos ?? [], 'Lote ceros': d.LOTE_SIN_CEROS.ejemplos ?? [],
    Peso: d.PESO_POR_UNIDAD.ejemplos ?? [], 'OT tipos': d.OT_SUMA_TIPOS.pendiente_por_tipo_y_unidad ?? [], Exclusiones: d.EXCLUSION_POR_DEFECTO.detalle ?? [],
    Pendientes: DECISIONES_PENDIENTES.map(p => ({ Decisión: p })),
  })
  const Metric = ({ k, val }: { k: string; val: string }) => <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[11px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{val}</p></div>
  const c = d.CIEN_A_UND, z = d.LOTE_SIN_CEROS, p = d.PESO_POR_UNIDAD, o = d.OT_SUMA_TIPOS
  return (
    <div className="space-y-3">
      <ChartCard title={v ? `Reglas vigentes: versión ${v.version} (${v.origen === 'HEREDADA' ? 'heredada, sin aprobación comercial' : 'aprobada'})` : 'Reglas vigentes'}
        subtitle={<>{v?.nota} Cada carga y cada día derivado registran la versión aplicada. Cortes comparados: Actualizable {fmtDateTime(d.cortes.CONTRATOS?.corte)} · Stock {fmtDateTime(d.cortes.STOCK?.corte)}.</>}
        actions={<button type="button" onClick={exportXlsx} className={btn}><Download className="h-4 w-4" />Excel</button>}>
        <Table head={<tr><th className={th}>Regla</th><th className={th}>Comportamiento actual</th><th className={th}>Se aplica en</th></tr>}>
          {(v?.reglas ?? []).map(r => <tr key={r.codigo}><td className={`${td} font-semibold`}>{r.titulo}<span className="block text-[10px] text-slate-400">{r.codigo}</span></td>
            <td className={`${td} max-w-xl`}>{r.detalle}</td><td className={td}>{r.aplica_en.join(' · ')}</td></tr>)}
        </Table>
      </ChartCard>

      <ChartCard title="CIEN → UND: con y sin la regla" subtitle="Valores originales del ERP y convertidos. Sin la regla, estos documentos quedan «unidad distinta» y sin stock coincidente.">
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Metric k="Lotes afectados" val={fmtN(c.lotes_afectados)} /><Metric k="Productos" val={fmtN(c.productos)} />
          <Metric k="Stock original" val={Object.entries(c.stock_original_por_unidad ?? {}).map(([u, q]) => `${fmtQty(q)} ${u}`).join(' · ') || '—'} />
          <Metric k="Stock convertido (UND)" val={fmtQty(c.stock_convertido_und)} />
          <Metric k="Pendiente que solo cruza con la regla" val={`${fmtQty(c.pendiente_que_cruza_solo_con_regla)} UND · ${fmtN(c.documentos_producto_que_cruzan_solo_con_regla)} doc.`} />
        </div>
        <p className="mb-1 text-xs font-bold text-slate-700">Equivalencia por producto (catálogo)</p><RowsTable rows={c.catalogo} />
        <p className="mb-1 mt-3 text-xs font-bold text-slate-700">Ejemplos</p><RowsTable rows={c.ejemplos} />
      </ChartCard>

      <ChartCard title="Peso: interpretación para validar" subtitle="No se corrige el peso automáticamente en el análisis exacto. Compare el Peso_Total del ERP con las dos interpretaciones.">
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric k="Lotes con unidad distinta de UND y peso" val={fmtN(p.filas)} />
          <Metric k="Peso_Total ERP = stock × Peso_Unitario" val={`${fmtN(p.peso_total_erp_coincide_con_stock_x_peso_unitario)} de ${fmtN(p.filas)}`} />
          <Metric k="kg según el ERP" val={fmtQty(p.kg_erp)} /><Metric k="kg con la regla v1 (× factor)" val={fmtQty(p.kg_con_regla)} />
        </div>
        <RowsTable rows={p.ejemplos} />
      </ChartCard>

      <ChartCard title="Lotes con ceros a la izquierda" subtitle="El lote original se conserva. La clave auxiliar (sin ceros) se evalúa aquí, sin aplicarla en el análisis exacto.">
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Metric k="Lotes con ceros" val={fmtN(z.lotes_con_ceros)} /><Metric k="Coinciden con la clave auxiliar" val={fmtN(z.coinciden_con_clave_auxiliar)} />
          <Metric k="Stock que solo cruza con la clave" val={fmtQty(z.stock_que_cruza_solo_con_regla)} />
          <Metric k="Colisiones en la misma bodega" val={fmtN(z.colisiones_misma_bodega)} /><Metric k="Claves ambiguas (otro lote con la misma clave)" val={fmtN(z.claves_ambiguas)} />
        </div>
        <RowsTable rows={z.ejemplos} />
      </ChartCard>

      <ChartCard title="Total por OT: contratos, subcontratos, garantías y errores" subtitle="La vista «OT pendientes» (v1) suma todos los tipos y unidades. El análisis exacto los presenta por separado.">
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric k="OT con pendiente" val={fmtN(o.ot_con_pendiente)} /><Metric k="OT con varios tipos de documento" val={fmtN(o.ot_con_varios_tipos)} />
          <Metric k="OT con varias unidades" val={fmtN(o.ot_con_varias_unidades)} />
          <Metric k="Sobredespacho contado como 0" val={`${fmtN(o.sobredespacho_que_la_regla_cuenta_como_cero?.lineas)} líneas · ${fmtQty(o.sobredespacho_que_la_regla_cuenta_como_cero?.cantidad)}`} />
        </div>
        <RowsTable rows={o.pendiente_por_tipo_y_unidad} max={100} />
      </ChartCard>

      <ChartCard title="Exclusiones de «OT pendientes» (v1)" subtitle="Por defecto no cuenta ERROR DE CONTRATO (tipo de documento) ni SERVICIO A TERCEROS (tipo de producto). En el análisis exacto siguen visibles.">
        <RowsTable rows={d.EXCLUSION_POR_DEFECTO.detalle} max={100} />
        <p className="mt-2 text-xs text-slate-500">UNID → UND: {fmtN(d.UNID_A_UND.lineas)} líneas del Actualizable vienen en UNID; la vista v1 las trata como UND, el análisis exacto las deja aparte.</p>
      </ChartCard>

      <ChartCard title="Decisiones comerciales pendientes" subtitle="Hasta definirlas, no se aprueba una nueva versión de reglas.">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{DECISIONES_PENDIENTES.map(x => <li key={x}>{x}</li>)}</ul>
      </ChartCard>
    </div>
  )
}

export function DiccionarioSection() {
  const [open, setOpen] = useState<string | null>(null)
  const exportXlsx = () => exportAptXlsx('Diccionario_indicadores_ERP', {
    Indicadores: ERP_INDICADORES.map(i => ({ Indicador: i.nombre, Base: i.base, Dónde: i.donde, Propósito: i.proposito, Fórmula: i.formula, Granularidad: i.granularidad,
      Origen: i.origen, Filtros: i.filtros, Nulos: i.nulos, Exclusiones: i.exclusiones, Limitaciones: i.limitaciones, Meta: ERP_META, Responsable: ERP_RESPONSABLE })),
  })
  return (
    <ChartCard title="Diccionario de indicadores" subtitle={`Meta y responsable: ${ERP_META.toLowerCase()}. «Reglas v1 heredadas» indica que el indicador depende de reglas aún sin aprobación comercial.`}
      actions={<button type="button" onClick={exportXlsx} className={btn}><Download className="h-4 w-4" />Excel</button>}>
      <Table head={<tr><th className={th}>Indicador</th><th className={th}>Base</th><th className={th}>Fórmula</th><th className={th}>Granularidad</th><th className={th}>Dónde</th></tr>}>
        {ERP_INDICADORES.map(i => <Fragment key={i.nombre}>
          <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === i.nombre ? null : i.nombre)}>
            <td className={`${td} font-semibold text-[#002855]`}>{i.nombre}<span className="block text-[11px] font-normal text-slate-500">{i.proposito}</span></td>
            <td className={td}><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${i.base === 'Reglas v1 heredadas' ? 'bg-amber-100 text-amber-800' : i.base === 'Cruce exacto' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{i.base}</span></td>
            <td className={`${td} max-w-md`}>{i.formula}</td><td className={`${td} max-w-xs`}>{i.granularidad}</td><td className={td}>{i.donde}</td>
          </tr>
          {open === i.nombre && <tr><td colSpan={5} className="bg-slate-50 p-3">
            <dl className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
              {([['Origen', i.origen], ['Filtros', i.filtros], ['Nulos y ceros', i.nulos], ['Exclusiones', i.exclusiones], ['Limitaciones', i.limitaciones], ['Meta', ERP_META], ['Responsable', ERP_RESPONSABLE]] as const)
                .map(([k, val]) => <div key={k}><dt className="font-bold text-slate-600">{k}</dt><dd className="text-slate-800">{val}</dd></div>)}
            </dl>
          </td></tr>}
        </Fragment>)}
      </Table>
    </ChartCard>
  )
}

const ESTADO_CARGA: Record<ErpCargaLog['estado'], string> = { OK: 'bg-emerald-100 text-emerald-800', ERROR: 'bg-red-100 text-red-800', EN_CURSO: 'bg-sky-100 text-sky-800', INTERRUMPIDA: 'bg-amber-100 text-amber-800' }
const TIPO_CARGA: Record<ErpCargaLog['tipo'], string> = { CONTRATOS: 'Actualizable', STOCK: 'Stock', MOVIMIENTOS: 'Movimientos del día', LECTURA: 'Lectura del archivo' }

export function CargasLogSection() {
  const res = useInvQuery('erp-cargas-log-full', () => erpApi.cargas(200))
  const [soloErrores, setSoloErrores] = useState(false)
  if (res.loading) return <LoadingBlock />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={res.reload} />
  const d = res.data
  const rows = d.registro.filter(r => !soloErrores || r.estado !== 'OK')
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p>La actualización es <b>manual</b>: los datos son del corte de cada archivo. La actualización automática cada 20 minutos <b>no está operativa</b>; requiere
          un proceso de extracción y envío desde la red del ERP, que aún no existe ni se ha probado.</p>
      </div>
      <ChartCard title="Vigencia de los datos" subtitle={`Versión de reglas vigente: ${d.regla_vigente ?? '—'}`}>
        <Table head={<tr><th className={th}>Archivo</th><th className={th}>Corte del ERP</th><th className={th}>Procesado en el TMS</th><th className={`${th} text-right`}>Filas</th><th className={th}>Reglas</th></tr>}>
          {(['CONTRATOS', 'STOCK'] as const).map(k => { const a = d.activas[k]
            return <tr key={k}><td className={td}><b>{k === 'CONTRATOS' ? 'Actualizable' : 'Stock'}</b>{a && <span className="block max-w-80 truncate text-[11px] text-slate-500" title={a.archivo}>{a.archivo}</span>}</td>
              <td className={td}>{a ? fmtDateTime(a.corte_erp) : 'Sin cargar'}</td><td className={td}>{a ? fmtDateTime(a.procesado_tms) : '—'}</td>
              <td className={tdNum}>{a ? fmtN(a.filas) : '—'}</td><td className={td}>{a?.version_reglas ? `v${a.version_reglas}` : '—'}</td></tr> })}
          <tr><td className={td}><b>Movimientos del día</b></td><td className={td}>{d.ultimo_dia_derivado ? `Día ${fmtDate(d.ultimo_dia_derivado.fecha)}` : '—'}</td>
            <td className={td}>{d.ultimo_dia_derivado ? fmtDateTime(d.ultimo_dia_derivado.generado) : '—'}</td><td className={tdNum}>—</td>
            <td className={td}>{d.ultimo_dia_derivado?.version_reglas ? `v${d.ultimo_dia_derivado.version_reglas}` : '—'}</td></tr>
        </Table>
      </ChartCard>
      <ChartCard title="Registro de cargas (también las fallidas)" actions={<label className="flex items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" checked={soloErrores} onChange={ev => setSoloErrores(ev.target.checked)} />Solo con problemas</label>}>
        <Table empty={!rows.length} head={<tr><th className={th}>Inicio</th><th className={th}>Tipo</th><th className={th}>Archivo</th><th className={th}>Corte ERP</th><th className={th}>Estado</th>
          <th className={`${th} text-right`}>Filas</th><th className={th}>Duración</th><th className={th}>Usuario</th><th className={th}>Reglas</th><th className={th}>Error</th></tr>}>
          {rows.map(r => <tr key={r.id}>
            <td className={td}>{fmtDateTime(r.inicio)}</td><td className={td}>{TIPO_CARGA[r.tipo]}</td><td className={`${td} max-w-64 truncate`} title={r.archivo ?? ''}>{r.archivo ?? '—'}</td>
            <td className={td}>{r.corte_erp ? fmtDateTime(r.corte_erp) : '—'}</td>
            <td className={td}><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ESTADO_CARGA[r.estado]}`}>{r.estado === 'EN_CURSO' ? 'En curso' : r.estado === 'INTERRUMPIDA' ? 'Interrumpida' : r.estado}</span></td>
            <td className={tdNum}>{r.filas_cargadas == null ? '—' : fmtN(r.filas_cargadas)}{r.filas_esperadas != null && <span className="text-slate-400"> / {fmtN(r.filas_esperadas)}</span>}</td>
            <td className={td}>{r.fin ? `${Math.max(1, Math.round((new Date(r.fin).getTime() - new Date(r.inicio).getTime()) / 1000))} s` : '—'}</td>
            <td className={td}>{r.usuario ?? '—'}</td><td className={td}>{r.version_reglas ? `v${r.version_reglas}` : '—'}</td>
            <td className={`${td} max-w-sm text-red-700`}>{r.error ?? (typeof r.detalle?.omitida === 'string' ? <span className="text-slate-500">{r.detalle.omitida}</span> : '')}</td>
          </tr>)}
        </Table>
      </ChartCard>
    </div>
  )
}
