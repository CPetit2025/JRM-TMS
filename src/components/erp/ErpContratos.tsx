'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Database, History, RefreshCw, Undo2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { fmtN, fmtQty } from '@/lib/inventario/format'
import { erpAltaAutomatica, type ErpAltaResultado } from '@/lib/erp/api'
import { fmtDate, fmtDateTime, fmtPct } from '@/lib/apt/format'

// Contratos con el ERP como fuente de verificación (Actualizable + Stock vigentes): por código del TMS, el documento del
// ERP con la misma numeración, cliente por RUC, avance sin conversiones, stock listo, OT activa (último despacho dentro
// del umbral o un evento que la reactiva) y diferencias. Si la base aún no tiene las funciones (vista previa antes de la
// migración) se avisa en vez de ocultar.
const supabase = createClient()

export type ErpDiferencia = 'NO_EN_ERP' | 'CLIENTE_DISTINTO' | 'RUC_INVALIDO' | 'HIJOS_SIN_ALTA' | 'GARANTIA_SIN_ERROR'
export interface ErpContratoInfo {
  aplica: boolean; en_erp: boolean; documento: string | null; tipo_erp: string | null; cliente_erp: string | null; ruc_erp: string | null
  ruc_valido: boolean; cliente_tms: string | null; cliente_coincide: boolean | null; lineas: number | null; incompletas: number | null
  unidades: number | null; unidad: string | null; contratado: number | null; despachado: number | null; pendiente: number | null; avance: number | null
  estado_erp: 'SIN DATOS' | 'COMPLETO' | 'PARCIAL' | 'SIN DESPACHO' | null; stock_listo: number | null
  ultimo_despacho: string | null; ultimo_despacho_erp: string | null; ultimo_despacho_tms: string | null; fecha_contrato: string | null
  activa: boolean | null; motivo: ErpMotivo | null; motivo_fecha: string | null; hijos_sin_alta: string[]
  garantia_error: string | null; error_de_garantia: string | null; diferencias: ErpDiferencia[]
}
export type ErpMotivo = 'DESPACHO' | 'GARANTIA' | 'SUBCONTRATO' | 'ERROR' | 'SOLICITUD_TMS' | 'CONTRATO_NUEVO'
export interface ErpContratosConfig { umbral_dias: number; reactivan: string[]; corte_max_horas: number; updated_at: string | null
  corte_contratos: string | null; desactualizado: boolean; puede_editar: boolean; eventos: Array<{ id: string; label: string }> }
export type ErpContratosEstado = 'cargando' | 'listo' | 'pendiente' | 'sin_acceso' | 'sin_datos'

export const DIFERENCIA_LABEL: Record<ErpDiferencia, string> = {
  NO_EN_ERP: 'No está en el ERP', CLIENTE_DISTINTO: 'Cliente distinto al del ERP', RUC_INVALIDO: 'RUC del ERP no válido',
  HIJOS_SIN_ALTA: 'Documentos del ERP sin alta', GARANTIA_SIN_ERROR: 'Garantía sin Error de contrato',
}
const CHIP_LABEL: Record<ErpDiferencia, string> = {
  NO_EN_ERP: 'No en ERP', CLIENTE_DISTINTO: 'Cliente distinto', RUC_INVALIDO: 'RUC no válido', HIJOS_SIN_ALTA: 'Sin alta', GARANTIA_SIN_ERROR: 'Garantía sin Error',
}
export const MOTIVO_LABEL: Record<ErpMotivo, string> = {
  DESPACHO: 'despacho', GARANTIA: 'garantía', SUBCONTRATO: 'subcontrato nuevo', ERROR: 'error nuevo', SOLICITUD_TMS: 'solicitud en el TMS',
  CONTRATO_NUEVO: 'contrato nuevo',
}

const isMissing = (code?: string) => code === 'PGRST202' || code === '42883'
const LOTE = 400

// Referencia por lotes de 400 códigos (la lista completa puede tener miles)
export function useErpContratos(codes: string[]) {
  const key = [...new Set(codes.filter(Boolean))].sort().join('|')
  const [state, setState] = useState<{ key: string; estado: ErpContratosEstado; filas: Record<string, ErpContratoInfo>; config: ErpContratosConfig | null }>(
    { key: '', estado: 'cargando', filas: {}, config: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!key) return
    let alive = true
    const all = key.split('|')
    const lotes: string[][] = []
    for (let i = 0; i < all.length; i += LOTE) lotes.push(all.slice(i, i + LOTE))
    void Promise.all(lotes.map(l => supabase.rpc('erp_ref_contratos', { p_codes: l }))).then(results => {
      if (!alive) return
      const filas: Record<string, ErpContratoInfo> = {}
      let config: ErpContratosConfig | null = null
      let estado: ErpContratosEstado = 'listo'
      for (const { data, error } of results) {
        if (error) { estado = isMissing(error.code) ? 'pendiente' : 'sin_acceso'; break }
        const out = data as { success?: boolean; sin_datos?: boolean; filas?: Record<string, ErpContratoInfo>; config?: ErpContratosConfig } | null
        if (!out?.success) { estado = 'sin_acceso'; break }
        if (out.sin_datos) estado = 'sin_datos'
        Object.assign(filas, out.filas || {})
        config = out.config || config
      }
      setState({ key, estado, filas, config })
    })
    return () => { alive = false }
  }, [key, tick])
  const reload = useCallback(() => setTick(t => t + 1), [])
  if (!key) return { estado: 'listo' as ErpContratosEstado, filas: {}, config: null, reload }
  return state.key === key ? { ...state, reload } : { estado: 'cargando' as ErpContratosEstado, filas: state.filas, config: state.config, reload }
}

// Celda compacta para la lista de Contratos
export function ErpContratoCelda({ info, estado, umbral }: { info?: ErpContratoInfo; estado: ErpContratosEstado; umbral?: number }) {
  if (estado === 'cargando') return <span className="text-[11px] text-slate-400">Consultando…</span>
  if (estado === 'pendiente') return <span className="text-[11px] font-semibold text-indigo-700" title="La base aún no tiene esta consulta: se activa con la migración del despliegue">Pendiente de activar</span>
  if (estado !== 'listo' || !info) return <span className="text-[11px] text-slate-400">—</span>
  if (!info.aplica) return <span className="text-[11px] text-slate-400" title="La OT independiente no tiene documento en el ERP">No aplica</span>
  // «No está en el ERP» ya se ve en la primera etiqueta
  const difs = (info.diferencias || []).filter(d => d !== 'NO_EN_ERP')
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-1">
        {info.en_erp
          ? <span className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-800 ring-1 ring-emerald-200" title={`${info.tipo_erp || ''} ${info.documento || ''}`}><CheckCircle2 className="h-3 w-3" aria-hidden="true" />ERP</span>
          : <span className="inline-flex items-center gap-0.5 rounded bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-700 ring-1 ring-rose-200"><XCircle className="h-3 w-3" aria-hidden="true" />No en ERP</span>}
        <ActividadBadge info={info} umbral={umbral} />
      </div>
      {info.en_erp && <span className="text-slate-600" title={info.unidades && info.unidades > 1 ? `${info.unidades} unidades distintas: el avance no se suma entre unidades` : undefined}>
        {info.estado_erp === 'SIN DATOS' ? 'Cantidades ausentes' : `${(info.estado_erp || '').toLowerCase()}${info.avance != null ? ` · ${fmtPct(info.avance * 100)}` : info.unidades && info.unidades > 1 ? ` · ${info.unidades} unidades` : ''}`}
        {info.stock_listo ? <span className="ml-1 text-emerald-700" title="Stock en lote de este documento, mismo producto y unidad, con pendiente">· stock {fmtQty(info.stock_listo)}</span> : null}
      </span>}
      {difs.length > 0 && <span className="flex flex-wrap gap-1">
        {difs.map(d => <span key={d} className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1 py-0.5 font-semibold text-amber-800 ring-1 ring-amber-200"
          title={d === 'CLIENTE_DISTINTO' ? `ERP: ${info.cliente_erp || '—'} (RUC ${info.ruc_erp || '—'}) · TMS: ${info.cliente_tms || 'sin cliente'}`
            : d === 'HIJOS_SIN_ALTA' ? info.hijos_sin_alta.join(', ') : d === 'RUC_INVALIDO' ? `RUC en el ERP: ${info.ruc_erp || '—'}` : DIFERENCIA_LABEL[d]}>
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />{d === 'HIJOS_SIN_ALTA' ? `${info.hijos_sin_alta.length} sin alta` : CHIP_LABEL[d]}</span>)}
      </span>}
    </div>
  )
}

export function ActividadBadge({ info, umbral }: { info: ErpContratoInfo; umbral?: number }) {
  if (info.activa == null) return null
  const ultimo = info.ultimo_despacho ? `Último despacho ${fmtDate(info.ultimo_despacho)} (ERP ${fmtDate(info.ultimo_despacho_erp)} · TMS ${fmtDate(info.ultimo_despacho_tms)})` : 'Sin despachos'
  const title = info.activa
    ? `Activa por ${MOTIVO_LABEL[info.motivo as ErpMotivo] || info.motivo} (${fmtDate(info.motivo_fecha)}). ${ultimo}`
    : `Sin despacho ni eventos en los últimos ${umbral ?? 90} días. ${ultimo}`
  return info.activa
    ? <span className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 font-semibold text-sky-800 ring-1 ring-sky-200" title={title}>
        <Clock className="h-3 w-3" aria-hidden="true" />Activa{info.motivo && info.motivo !== 'DESPACHO' ? ` · ${MOTIVO_LABEL[info.motivo]}` : ''}</span>
    : <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600 ring-1 ring-slate-200" title={title}>
        <Clock className="h-3 w-3" aria-hidden="true" />Inactiva</span>
}

// Aviso del corte del ERP (desactualizado si supera las horas configuradas)
export function ErpCorteAviso({ config, estado }: { config: ErpContratosConfig | null; estado: ErpContratosEstado }) {
  if (estado === 'pendiente') return <p className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-900">
    <Database className="h-3.5 w-3.5" aria-hidden="true" />Verificación con el ERP pendiente de activar: la base aún no tiene estas consultas (se activan con la migración del despliegue).</p>
  if (estado === 'sin_datos') return <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">Aún no hay carga del Actualizable del ERP.</p>
  if (!config) return null
  return (
    <p className={`flex flex-wrap items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs ${config.desactualizado ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
      <Database className="h-3.5 w-3.5" aria-hidden="true" />
      ERP: corte del Actualizable {config.corte_contratos ? fmtDateTime(config.corte_contratos) : '—'}
      {config.desactualizado && <strong>· desactualizado (más de {config.corte_max_horas} h): la actividad y las diferencias pueden no reflejar lo último</strong>}
      <span>· OT activa: despacho en los últimos {config.umbral_dias} días{config.reactivan.length ? ` o ${config.reactivan.map(r => MOTIVO_LABEL[r as ErpMotivo] || r).join(', ')}` : ''}</span>
    </p>
  )
}

// Umbral de OT activa y eventos que la reactivan (solo el Administrador cambia). Se monta al abrir: toma la regla vigente.
export function ErpConfigModal({ open, onClose, config, onSaved }: { open: boolean; onClose: () => void; config: ErpContratosConfig | null; onSaved: () => void }) {
  const [umbral, setUmbral] = useState(String(config?.umbral_dias ?? 90))
  const [horas, setHoras] = useState(String(config?.corte_max_horas ?? 48))
  const [ev, setEv] = useState<string[]>(config?.reactivan ?? ['GARANTIA', 'SUBCONTRATO', 'ERROR', 'SOLICITUD_TMS'])
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    const { data, error } = await supabase.rpc('erp_contratos_config_set', { p: { umbral_dias: Number(umbral), corte_max_horas: Number(horas), reactivan: ev } })
    setSaving(false)
    const out = data as { success?: boolean; error?: string } | null
    if (error || !out?.success) { toast.error(error?.message || out?.error || 'No se pudo guardar'); return }
    toast.success('Regla de OT activa actualizada'); onSaved(); onClose()
  }
  const editable = !!config?.puede_editar
  return (
    <Modal isOpen={open} onClose={onClose} title="OT activa según el ERP" maxWidth="max-w-xl"
      footer={editable ? <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancelar</button>
        <button type="button" disabled={saving} onClick={save} className="min-h-11 rounded-lg bg-[#002855] px-5 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Guardando…' : 'Guardar'}</button></div> : undefined}>
      <div className="space-y-4 text-sm text-slate-700">
        <p>Una OT está <strong>activa</strong> si tuvo un despacho (el más reciente entre el ERP y las rutas del TMS) dentro del umbral. Además, la reactivan los eventos marcados aunque no haya despacho reciente. Un contrato nuevo sin despachos cuenta desde su fecha de contrato.</p>
        <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">Ejemplo: una OT sin despachos hace 200 días está inactiva. Si se registra una <strong>garantía</strong> (en el ERP o en el TMS) y ese evento está marcado, vuelve a figurar activa con el motivo «garantía» hasta que pasen {umbral || 90} días desde la garantía. La marca solo informa y filtra: no bloquea solicitudes ni libera partidas.</p>
        <label className="block"><span className="text-xs font-semibold text-slate-600">Umbral (días desde el último despacho o evento)</span>
          <input type="number" min={7} max={730} value={umbral} disabled={!editable} onChange={e => setUmbral(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2.5" /></label>
        <fieldset><legend className="text-xs font-semibold text-slate-600">Eventos que reactivan la OT</legend>
          <div className="mt-1 space-y-1.5">{(config?.eventos || []).map(e => (
            <label key={e.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3">
              <input type="checkbox" disabled={!editable} checked={ev.includes(e.id)} onChange={x => setEv(v => x.target.checked ? [...v, e.id] : v.filter(i => i !== e.id))} />{e.label}</label>))}</div>
        </fieldset>
        <label className="block"><span className="text-xs font-semibold text-slate-600">Aviso de corte desactualizado (horas)</span>
          <input type="number" min={1} max={720} value={horas} disabled={!editable} onChange={e => setHoras(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-2.5" /></label>
        {!editable && <p className="text-xs text-slate-500">Solo el Administrador puede cambiar esta regla.</p>}
      </div>
    </Modal>
  )
}

// Documentos del ERP sin alta en el TMS; «Dar de alta» abre el alta con los datos del ERP
export interface ErpSinAltaFila { documento: string; ot: string; tipo: 'CONTRATO' | 'SUBCONTRATO' | 'ERROR' | 'GARANTIA' | null; tipo_erp: string | null; cliente: string | null
  ruc: string | null; fecha_contrato: string | null; ult_despacho: string | null; pendiente: boolean | null; activa: boolean | null; motivo: ErpMotivo | null
  ultimo_despacho: string | null; madre_en_tms: boolean }
export function ErpSinAltaModal({ open, onClose, onAlta, onAuto }: {
  open: boolean; onClose: () => void; onAlta: (fila: ErpSinAltaFila) => void; onAuto?: () => void
}) {
  const [tipo, setTipo] = useState('')
  const [activas, setActivas] = useState(true)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [tick, setTick] = useState(0)
  const [res, setRes] = useState<{ total: number; por_tipo: Record<string, number>; filas: ErpSinAltaFila[] } | null>(null)
  const [auto, setAuto] = useState<ErpAltaResultado | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)
  const consulta = JSON.stringify({ tipo: tipo || null, solo_activas: activas, q: q.trim() || null, limit: 50, offset: page * 50 })
  const [hecho, setHecho] = useState<{ consulta: string; estado: 'listo' | 'pendiente' | 'error' } | null>(null)
  const clave = `${consulta}#${tick}`
  const estado = hecho?.consulta === clave ? hecho.estado : 'cargando'
  useEffect(() => {
    if (!open) return
    let alive = true
    const t = setTimeout(() => {
      void supabase.rpc('erp_ref_sin_alta', { p: JSON.parse(consulta) }).then(({ data, error }) => {
        if (!alive) return
        if (error) { setHecho({ consulta: clave, estado: isMissing(error.code) ? 'pendiente' : 'error' }); return }
        const out = data as { success?: boolean; total: number; por_tipo: Record<string, number>; filas: ErpSinAltaFila[] } | null
        if (!out?.success) { setHecho({ consulta: clave, estado: 'error' }); return }
        setRes(out); setHecho({ consulta: clave, estado: 'listo' })
      })
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [open, consulta, clave])
  // Alta automática: primero se simula y se muestra cuántas OT se crearán; luego se confirma
  const runAuto = async (simular: boolean) => {
    setAutoBusy(true)
    const out = await erpAltaAutomatica(simular)
    setAutoBusy(false)
    if (!out?.success) { toast.error(out?.error || 'No se pudo dar de alta desde el ERP'); return }
    if (simular) { setAuto(out); return }
    setAuto(null); setTick(t => t + 1); onAuto?.()
    toast.success(`${fmtN(out.madres + out.hijos)} OT dadas de alta desde el ERP (${fmtN(out.madres)} madre, ${fmtN(out.hijos)} subcontratos/errores)`
      + (out.errores ? ` · ${fmtN(out.errores)} con error` : ''))
  }
  return (
    <Modal isOpen={open} onClose={onClose} title="Documentos del ERP sin alta en el TMS" maxWidth="max-w-5xl">
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1">Al cargar el Actualizable, las OT activas que faltan se dan de alta solas (madre con su cliente por RUC, subcontratos y errores; sin partida).
              Las garantías y las OT sin RUC válido se registran aquí con «Dar de alta».</p>
            {!auto && <button type="button" disabled={autoBusy} onClick={() => void runAuto(true)}
              className="min-h-9 rounded-lg border border-sky-300 bg-white px-3 font-semibold text-sky-900 disabled:opacity-50">{autoBusy ? 'Revisando…' : 'Dar de alta automáticamente ahora'}</button>}
          </div>
          {auto && <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-sky-200 pt-2">
            <p className="flex-1">{auto.madres + auto.hijos
              ? `Se darán de alta ${fmtN(auto.madres)} OT madre y ${fmtN(auto.hijos)} subcontratos/errores.`
              : 'No hay OT activas pendientes de alta automática.'}
              {auto.garantias ? ` ${fmtN(auto.garantias)} garantías quedan para alta manual.` : ''}
              {auto.ruc_invalido ? ` ${fmtN(auto.ruc_invalido)} sin RUC válido.` : ''}
              {auto.sin_madre ? ` ${fmtN(auto.sin_madre)} esperan a su OT madre.` : ''}</p>
            <button type="button" onClick={() => setAuto(null)} className="min-h-9 rounded-lg border border-slate-300 bg-white px-3">Cancelar</button>
            {auto.madres + auto.hijos > 0 && <button type="button" disabled={autoBusy} onClick={() => void runAuto(false)}
              className="min-h-9 rounded-lg bg-[#002855] px-3 font-semibold text-white disabled:opacity-50">{autoBusy ? 'Dando de alta…' : 'Confirmar alta'}</button>}
          </div>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-slate-600">Buscar<input value={q} onChange={e => { setQ(e.target.value); setPage(0) }} placeholder="OT, documento o cliente"
            className="mt-1 block min-h-11 w-56 rounded-lg border border-slate-300 px-3 text-sm font-normal" /></label>
          <label className="text-xs font-semibold text-slate-600">Tipo<select value={tipo} onChange={e => { setTipo(e.target.value); setPage(0) }}
            className="mt-1 block min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-normal">
            <option value="">Todos</option><option value="CONTRATO">Contrato</option><option value="SUBCONTRATO">Subcontrato</option><option value="ERROR">Error</option><option value="GARANTIA">Garantía</option></select></label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={activas} onChange={e => { setActivas(e.target.checked); setPage(0) }} />Solo OT activas</label>
          {res && <span className="ml-auto text-xs text-slate-500">{fmtN(res.total)} documentos · {Object.entries(res.por_tipo).map(([k, v]) => `${k.toLowerCase()} ${fmtN(v)}`).join(' · ')}</span>}
        </div>
        {estado === 'pendiente' && <p className="rounded-lg bg-indigo-50 p-3 text-indigo-900">Pendiente de activar: la base aún no tiene esta consulta.</p>}
        {estado === 'error' && <p className="rounded-lg bg-rose-50 p-3 text-rose-800">No se pudo consultar el ERP.</p>}
        {estado !== 'pendiente' && estado !== 'error' && (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase text-slate-500"><tr>
                <th className="px-3 py-2">Documento</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">Contrato</th>
                <th className="px-3 py-2">Último despacho</th><th className="px-3 py-2">OT</th><th className="px-3 py-2"><span className="sr-only">Acción</span></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {estado === 'cargando' && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Consultando…</td></tr>}
                {estado === 'listo' && !res?.filas.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Sin documentos pendientes de alta con estos filtros.</td></tr>}
                {estado === 'listo' && res?.filas.map(f => (
                  <tr key={f.documento}>
                    <td className="px-3 py-2 font-semibold text-[#002855]">{f.documento}</td>
                    <td className="px-3 py-2">{f.tipo_erp}</td>
                    <td className="max-w-56 truncate px-3 py-2" title={`${f.cliente || ''} · RUC ${f.ruc || '—'}`}>{f.cliente || '—'}</td>
                    <td className="px-3 py-2">{fmtDate(f.fecha_contrato)}</td>
                    <td className="px-3 py-2">{fmtDate(f.ultimo_despacho)}</td>
                    <td className="px-3 py-2">{f.activa ? <span className="font-semibold text-sky-800">Activa{f.motivo && f.motivo !== 'DESPACHO' ? ` · ${MOTIVO_LABEL[f.motivo]}` : ''}</span> : <span className="text-slate-500">Inactiva</span>}</td>
                    <td className="px-3 py-2 text-right">{f.tipo !== 'CONTRATO' && !f.madre_en_tms
                      ? <span className="text-[11px] text-amber-700" title="Primero dé de alta la OT madre">Falta la madre {f.ot}</span>
                      : <button type="button" onClick={() => onAlta(f)} className="min-h-9 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white">Dar de alta</button>}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>)}
        {res && res.total > 50 && <div className="flex items-center justify-end gap-2 text-xs">
          <button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="min-h-9 rounded-lg border border-slate-300 px-3 disabled:opacity-40">Anterior</button>
          <span>{page * 50 + 1}–{Math.min((page + 1) * 50, res.total)} de {fmtN(res.total)}</span>
          <button type="button" disabled={(page + 1) * 50 >= res.total} onClick={() => setPage(p => p + 1)} className="min-h-9 rounded-lg border border-slate-300 px-3 disabled:opacity-40">Siguiente</button></div>}
      </div>
    </Modal>
  )
}

// Correcciones de cliente según el ERP: historial, sincronización y acciones del Administrador
interface Correccion { id: string; ot: string; old_client_name: string | null; new_client_name: string | null; ruc_erp: string; cliente_erp: string | null
  client_created: boolean; corte: string | null; abiertas: number; conservadas: number; created_at: string; closed_applied_at: string | null
  closed_applied: number | null; closed_motivo: string | null; reverted_at: string | null; revert_motivo: string | null; creado_por: string | null }
interface Sincronizacion { simulacion: boolean; revisadas: number; corregidas: number; clientes_creados: number; ruc_invalido: number; omitidas_revertidas: number
  errores: number; detalle: Array<{ ot: string; cliente_tms?: string | null; cliente_erp?: string | null; ruc?: string; error?: string }> }
export function ErpCorreccionesModal({ open, onClose, canSync, onChanged }: { open: boolean; onClose: () => void; canSync: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<Correccion[] | null>(null)
  const [admin, setAdmin] = useState(false)
  const [preview, setPreview] = useState<Sincronizacion | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [hecho, setHecho] = useState<{ tick: number; estado: 'listo' | 'pendiente' | 'error' } | null>(null)
  const estado = hecho?.tick === tick ? hecho.estado : 'cargando'
  useEffect(() => {
    if (!open) return
    let alive = true
    void supabase.rpc('erp_cliente_correcciones', { p: { limit: 200 } }).then(({ data, error }) => {
      if (!alive) return
      if (error) { setHecho({ tick, estado: isMissing(error.code) ? 'pendiente' : 'error' }); return }
      const out = data as { success?: boolean; puede_administrar: boolean; filas: Correccion[] } | null
      if (!out?.success) { setHecho({ tick, estado: 'error' }); return }
      setRows(out.filas); setAdmin(out.puede_administrar); setHecho({ tick, estado: 'listo' })
    })
    return () => { alive = false }
  }, [open, tick])
  const sync = async (simular: boolean) => {
    setBusy(true)
    const { data, error } = await supabase.rpc('erp_contratos_sincronizar_clientes', { p_simular: simular })
    setBusy(false)
    const out = data as ({ success?: boolean; error?: string } & Sincronizacion) | null
    if (error || !out?.success) { toast.error(error?.message || out?.error || 'No se pudo sincronizar'); return }
    if (simular) { setPreview(out); return }
    setPreview(null)
    toast.success(`${out.corregidas} OT corregidas${out.clientes_creados ? ` · ${out.clientes_creados} clientes registrados desde el ERP` : ''}${out.errores ? ` · ${out.errores} con error` : ''}`)
    setTick(t => t + 1); onChanged()
  }
  const accion = async (fn: 'erp_cliente_correccion_aplicar_cerradas' | 'erp_cliente_correccion_revertir', c: Correccion) => {
    const motivo = window.prompt(fn === 'erp_cliente_correccion_revertir'
      ? `Revertir la corrección de la OT ${c.ot}: vuelve a ${c.old_client_name || 'su cliente anterior'}. Motivo:`
      : `Aplicar el cliente ${c.new_client_name || ''} también a ${c.conservadas} solicitud(es) en ruta o cerradas de la OT ${c.ot}. Motivo:`)
    if (!motivo) return
    const { data, error } = await supabase.rpc(fn, { p_id: c.id, p_motivo: motivo })
    const out = data as { success?: boolean; error?: string } | null
    if (error || !out?.success) { toast.error(error?.message || out?.error || 'No se pudo completar'); return }
    toast.success(fn === 'erp_cliente_correccion_revertir' ? 'Corrección revertida' : 'Cliente aplicado a las solicitudes cerradas')
    setTick(t => t + 1); onChanged()
  }
  return (
    <Modal isOpen={open} onClose={onClose} title="Cliente de OT corregido según el ERP" maxWidth="max-w-5xl">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-slate-600">Al cargar el Actualizable, el cliente de cada OT madre se corrige con el RUC del ERP (si el cliente no existe se registra). Se corrigen la OT, sus subcontratos, errores y garantías, y las solicitudes que aún no salen a ruta; las que están en ruta, entregadas o cerradas conservan su cliente. Se avisa al responsable de la OT. Solo el Administrador puede aplicar la corrección a las cerradas o revertirla.</p>
        {canSync && <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => sync(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />{busy ? 'Revisando…' : 'Revisar diferencias con el ERP'}</button>
          {preview && <span className="text-xs text-slate-600">{preview.corregidas} OT por corregir · {preview.ruc_invalido} con RUC no válido (no se tocan) · {preview.omitidas_revertidas} revertidas antes</span>}
          {preview && preview.corregidas > 0 && <button type="button" disabled={busy} onClick={() => sync(false)} className="min-h-11 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Corregir {preview.corregidas} OT</button>}
        </div>}
        {preview && preview.detalle.length > 0 && <ul className="max-h-40 overflow-auto rounded-lg border border-slate-200 p-2 text-xs">{preview.detalle.map(d =>
          <li key={d.ot}><strong>{d.ot}</strong>: {d.cliente_tms || 'sin cliente'} → {d.cliente_erp} (RUC {d.ruc})</li>)}</ul>}
        {estado === 'pendiente' && <p className="rounded-lg bg-indigo-50 p-3 text-indigo-900">Pendiente de activar: la base aún no tiene esta consulta.</p>}
        {estado === 'error' && <p className="rounded-lg bg-rose-50 p-3 text-rose-800">No se pudo consultar el historial.</p>}
        {estado === 'listo' && (
          <div className="max-h-[55vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase text-slate-500"><tr>
                <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">OT</th><th className="px-3 py-2">Antes → Ahora</th><th className="px-3 py-2">Solicitudes</th>
                <th className="px-3 py-2">Estado</th>{admin && <th className="px-3 py-2"><span className="sr-only">Acciones</span></th>}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {!rows?.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin correcciones registradas.</td></tr>}
                {rows?.map(c => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap px-3 py-2">{fmtDateTime(c.created_at)}<span className="block text-[10px] text-slate-400">{c.creado_por || ''}</span></td>
                    <td className="px-3 py-2 font-semibold text-[#002855]">{c.ot}</td>
                    <td className="px-3 py-2">{c.old_client_name || 'Sin cliente'} → <strong>{c.new_client_name || c.cliente_erp}</strong>
                      <span className="block text-[10px] text-slate-500">RUC {c.ruc_erp}{c.client_created ? ' · cliente registrado desde el ERP' : ''}</span></td>
                    <td className="px-3 py-2">{c.abiertas} corregidas · {c.conservadas} conservadas{c.closed_applied_at ? ` · ${c.closed_applied ?? 0} aplicadas después` : ''}</td>
                    <td className="px-3 py-2">{c.reverted_at ? <span className="text-slate-500" title={c.revert_motivo || ''}><History className="mr-0.5 inline h-3 w-3" aria-hidden="true" />Revertida {fmtDate(c.reverted_at)}</span>
                      : c.closed_applied_at ? <span title={c.closed_motivo || ''}>Aplicada a cerradas</span> : 'Vigente'}</td>
                    {admin && <td className="whitespace-nowrap px-3 py-2 text-right">{!c.reverted_at && <>
                      {!c.closed_applied_at && c.conservadas > 0 && <button type="button" onClick={() => accion('erp_cliente_correccion_aplicar_cerradas', c)}
                        className="mr-1 min-h-9 rounded-lg border border-slate-300 px-2 text-[11px] font-semibold">Aplicar a cerradas</button>}
                      <button type="button" onClick={() => accion('erp_cliente_correccion_revertir', c)}
                        className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-rose-200 px-2 text-[11px] font-semibold text-rose-700"><Undo2 className="h-3 w-3" aria-hidden="true" />Revertir</button></>}</td>}
                  </tr>))}
              </tbody>
            </table>
          </div>)}
      </div>
    </Modal>
  )
}


// Guías escritas en el TMS validadas contra el ERP por lote (Registro de Servicios): por id, total, en el ERP, de otra OT
// y no encontradas
export interface ErpGuiasConteo { total: number; en_erp: number; otra_ot: number; no_erp: number }
export const splitGuias = (v: string | null | undefined) => String(v || '').split(/[,;/\s·]+/).map(x => x.trim()).filter(Boolean)
export function useErpGuiasLote(items: Array<{ id: string; ot: string | null | undefined; guias: string | null | undefined }>) {
  const lista = items.filter(i => splitGuias(i.guias).length > 0)
  const key = lista.map(i => `${i.id}:${i.ot || ''}:${i.guias}`).sort().join('|')
  const [state, setState] = useState<{ key: string; estado: ErpContratosEstado; items: Record<string, ErpGuiasConteo> }>({ key: '', estado: 'cargando', items: {} })
  useEffect(() => {
    if (!key) return
    let alive = true
    const payload = key.split('|').map(k => { const [id, ot, ...g] = k.split(':'); return { id, ot: ot || null, guias: splitGuias(g.join(':')) } })
    const lotes: typeof payload[] = []
    for (let i = 0; i < payload.length; i += 500) lotes.push(payload.slice(i, i + 500))
    void Promise.all(lotes.map(l => supabase.rpc('erp_ref_guias_lote', { p_items: l }))).then(results => {
      if (!alive) return
      const out: Record<string, ErpGuiasConteo> = {}
      let estado: ErpContratosEstado = 'listo'
      for (const { data, error } of results) {
        if (error) { estado = isMissing(error.code) ? 'pendiente' : 'sin_acceso'; break }
        const r = data as { success?: boolean; sin_datos?: boolean; items?: Record<string, ErpGuiasConteo> } | null
        if (!r?.success) { estado = 'sin_acceso'; break }
        if (r.sin_datos) estado = 'sin_datos'
        Object.assign(out, r.items || {})
      }
      setState({ key, estado, items: out })
    })
    return () => { alive = false }
  }, [key])
  if (!key) return { estado: 'listo' as ErpContratosEstado, items: {} as Record<string, ErpGuiasConteo> }
  return state.key === key ? state : { estado: 'cargando' as ErpContratosEstado, items: state.items }
}

// Celda de Registro de Servicios: guías contra el ERP y actividad de la OT
export function ErpServicioCelda({ guias, ot, estado, umbral }: { guias?: ErpGuiasConteo; ot?: ErpContratoInfo; estado: ErpContratosEstado; umbral?: number }) {
  if (estado === 'cargando') return <span className="text-[11px] text-slate-400">…</span>
  if (estado === 'pendiente') return <span className="text-[11px] font-semibold text-indigo-700" title="La base aún no tiene esta consulta: se activa con la migración del despliegue">Pendiente</span>
  if (!guias && !ot) return <span className="text-[11px] text-slate-400">—</span>
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      {guias && <span className="flex flex-wrap gap-1" title={`${guias.total} guía(s): ${guias.en_erp} en el ERP, ${guias.otra_ot} de otra OT, ${guias.no_erp} no están en el ERP`}>
        {guias.en_erp - guias.otra_ot > 0 && <span className="inline-flex items-center gap-0.5 font-semibold text-emerald-700"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />{guias.en_erp - guias.otra_ot}</span>}
        {guias.otra_ot > 0 && <span className="inline-flex items-center gap-0.5 font-semibold text-amber-700"><AlertTriangle className="h-3 w-3" aria-hidden="true" />{guias.otra_ot} otra OT</span>}
        {guias.no_erp > 0 && <span className="inline-flex items-center gap-0.5 font-semibold text-rose-700"><XCircle className="h-3 w-3" aria-hidden="true" />{guias.no_erp} no ERP</span>}
      </span>}
      {ot && ot.aplica && <ActividadBadge info={ot} umbral={umbral} />}
    </div>
  )
}
