'use client'

import { useEffect, useState } from 'react'
import { Download, Loader2, Lock, LockOpen, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import * as api from '@/lib/indicadores/api'
import type { Frecuencia, KpiResultado, Tablero } from '@/lib/indicadores/api'
import { equipoTxt, estadoInfo, estadoPeriodoTxt, fechaHoraTxt, FRECUENCIAS, metaTxt } from '@/lib/indicadores/format'
import { ResumenEquipos } from './KpiCard'
import { FichaKpi } from './FichaKpi'
import { ConfigPanel, CorreccionesPanel, EnlacesPanel } from './Paneles'

type Tab = 'resumen' | 'correcciones' | 'enlace' | 'config'
const msg = (e: unknown, def: string) => e instanceof Error ? e.message : def

async function exportarTablero(t: Tablero) {
  const { exportAptXlsx } = await import('@/lib/apt/export')
  const resumen = t.kpis.map(k => ({ Equipo: equipoTxt(k.equipo), Código: k.codigo, Indicador: k.nombre, Valor: k.valor ?? '', Unidad: k.unidad, Meta: metaTxt(k), Estado: estadoInfo(k.estado).label,
    'Cobertura %': k.cobertura ?? '', Registros: k.n, 'Con dato': k.n_con_dato, Numerador: k.num ?? '', Denominador: k.den ?? '', 'Correcciones pendientes': k.correcciones_pendientes ?? 0, 'Estado de datos': k.estado_datos, 'Nota de datos': k.nota_datos || '', Responsable: k.responsable || '' }))
  const tendencia = t.kpis.flatMap(k => k.tendencia.map(p => ({ Equipo: equipoTxt(k.equipo), Código: k.codigo, Indicador: k.nombre, Periodo: p.etiqueta, Desde: p.desde, Valor: p.valor ?? '', Unidad: k.unidad, Estado: estadoInfo(p.estado).label })))
  exportAptXlsx(`Indicadores ${t.frecuencia.toLowerCase()} ${t.desde}`, {
    Contexto: [{ Frecuencia: t.frecuencia, Periodo: t.etiqueta, Desde: t.desde, Hasta: t.hasta, Estado: estadoPeriodoTxt(t.estado_periodo, t.version, t.provisional), 'Cerrado el': t.cerrado_at || '', Generado: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }), Fuente: 'kpi_eq_tablero' }],
    Resumen: resumen, Tendencia: tendencia,
  })
}

export default function IndicadoresEquipos() {
  const [frecuencia, setFrecuencia] = useState<Frecuencia>('MENSUAL')
  const [desde, setDesde] = useState<string | null>(null)
  const [data, setData] = useState<Tablero | null>(null)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [tab, setTab] = useState<Tab>('resumen')
  const [ficha, setFicha] = useState<KpiResultado | null>(null)
  const [periodoOp, setPeriodoOp] = useState<'cerrar' | 'reabrir' | null>(null)
  const [motivo, setMotivo] = useState('')
  const [busy, setBusy] = useState(false)
  const recargar = () => setNonce(n => n + 1)

  useEffect(() => {
    let vivo = true
    api.tablero(frecuencia, desde).then(t => { if (vivo) { setData(t); setError('') } })
      .catch(e => { if (vivo) { const m = msg(e, 'No se pudo cargar el tablero.'); setError(m); toast.error(m) } })
    return () => { vivo = false }
  }, [frecuencia, desde, nonce])

  const t = data?.frecuencia === frecuencia ? data : null
  const revisor = !!t?.es_revisor
  const cerrado = t?.estado_periodo === 'CERRADO'
  const tabs: Array<[Tab, string]> = [['resumen', 'Resumen'], ['correcciones', 'Correcciones'], ...(revisor ? [['enlace', 'Enlace compartido'], ['config', 'Configuración']] as Array<[Tab, string]> : [])]
  const pendientes = t?.kpis.reduce((s, k) => s + (k.correcciones_pendientes || 0), 0) || 0

  const confirmarPeriodo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!t || !periodoOp) return
    if (periodoOp === 'reabrir' && motivo.trim().length < 5) return toast.error('Indique el motivo de la reapertura (mín. 5 caracteres).')
    setBusy(true)
    try {
      if (periodoOp === 'cerrar') await api.cerrar(frecuencia, t.desde); else await api.reabrir(frecuencia, t.desde, motivo.trim())
      toast.success(periodoOp === 'cerrar' ? 'Periodo cerrado.' : 'Periodo reabierto.')
      setPeriodoOp(null); setMotivo(''); recargar()
    } catch (err) { toast.error(msg(err, 'No se pudo completar la operación.')) }
    finally { setBusy(false) }
  }

  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-3">
      <label className="text-xs font-semibold text-slate-600">Frecuencia
        <select className="mt-1 block rounded-lg border px-3 py-2 text-sm" value={frecuencia} onChange={e => { setFrecuencia(e.target.value as Frecuencia); setDesde(null) }}>
          {FRECUENCIAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="min-w-0 text-xs font-semibold text-slate-600">Periodo
        <select className="mt-1 block max-w-full rounded-lg border px-3 py-2 text-sm" disabled={!t} value={t?.desde || ''} onChange={e => setDesde(e.target.value)}>
          {(t?.periodos || []).map(p => <option key={p.desde} value={p.desde}>{p.etiqueta}{p.estado && p.estado !== 'ABIERTO' ? ` · ${p.estado === 'CERRADO' ? 'cerrado' : 'reabierto'}` : ''}</option>)}</select></label>
      {t && <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${cerrado ? 'bg-[#002855] text-white' : 'bg-amber-100 text-amber-900'}`}>
        {cerrado ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <LockOpen className="h-3.5 w-3.5" aria-hidden />}{estadoPeriodoTxt(t.estado_periodo, t.version, t.provisional)}</span>}
      {t?.cerrado_at && <span className="text-xs text-slate-500">Cerrado el {fechaHoraTxt(t.cerrado_at)}</span>}
      <div className="ml-auto flex flex-wrap gap-2">
        <button onClick={recargar} aria-label="Actualizar" className="rounded-lg border bg-white p-2"><RefreshCw className="h-4 w-4" /></button>
        <button onClick={() => t && exportarTablero(t)} disabled={!t} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm disabled:opacity-50"><Download className="h-4 w-4" aria-hidden />Exportar Excel</button>
        {revisor && t && (cerrado
          ? <button onClick={() => setPeriodoOp('reabrir')} className="flex items-center gap-2 rounded-lg border border-[#cf152d] px-3 py-2 text-sm font-semibold text-[#cf152d]"><LockOpen className="h-4 w-4" aria-hidden />Reabrir</button>
          : <button onClick={() => setPeriodoOp('cerrar')} className="flex items-center gap-2 rounded-lg bg-[#002855] px-3 py-2 text-sm font-semibold text-white"><Lock className="h-4 w-4" aria-hidden />Cerrar periodo</button>)}
      </div>
    </div>
    {t?.provisional && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Resultados provisionales: el periodo sigue abierto y los valores pueden cambiar con nuevos registros o correcciones.</p>}

    <nav aria-label="Secciones de indicadores" className="flex gap-1 overflow-x-auto border-b border-slate-200">{tabs.map(([k, l]) =>
      <button key={k} onClick={() => setTab(k)} aria-current={tab === k ? 'page' : undefined} className={`shrink-0 border-b-2 px-4 py-2.5 text-sm ${tab === k ? 'border-[#cf152d] font-semibold text-[#002855]' : 'border-transparent text-slate-500 hover:text-[#002855]'}`}>
        {l}{k === 'correcciones' && pendientes > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-xs font-bold text-amber-900">{pendientes}</span>}</button>)}</nav>

    {error && !t ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800"><p>{error}</p><button onClick={recargar} className="mt-2 font-semibold">Reintentar</button></div>
      : !t ? <div role="status" className="flex items-center justify-center gap-2 rounded-xl border bg-white p-12 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />Calculando indicadores…</div>
      : tab === 'resumen' ? <ResumenEquipos kpis={t.kpis} onSelect={setFicha} />
      : tab === 'correcciones' ? <CorreccionesPanel onChange={recargar} />
      : tab === 'enlace' && revisor ? <EnlacesPanel equipos={t.equipos} />
      : tab === 'config' && revisor ? <ConfigPanel onSaved={recargar} />
      : <ResumenEquipos kpis={t.kpis} onSelect={setFicha} />}

    {ficha && t && <FichaKpi kpi={t.kpis.find(k => k.codigo === ficha.codigo) || ficha} desde={t.desde} hasta={t.hasta} cerrado={cerrado} onClose={() => setFicha(null)} onChange={recargar} />}
    {periodoOp && t && <Modal isOpen onClose={() => setPeriodoOp(null)} title={periodoOp === 'cerrar' ? 'Cerrar periodo' : 'Reabrir periodo'} maxWidth="max-w-md">
      <form onSubmit={confirmarPeriodo} className="space-y-3 text-sm">
        <p>{periodoOp === 'cerrar'
          ? <>Se congelarán los resultados de <b>{t.etiqueta}</b> ({FRECUENCIAS.find(f => f[0] === frecuencia)?.[1].toLowerCase()}). No se aceptarán nuevas correcciones y el periodo quedará visible en los enlaces compartidos.</>
          : <>Se reabrirá <b>{t.etiqueta}</b>. Los resultados volverán a ser provisionales hasta un nuevo cierre (nueva versión).</>}</p>
        {pendientes > 0 && periodoOp === 'cerrar' && <p className="rounded-lg bg-amber-50 p-2 text-amber-900">Hay {pendientes} corrección(es) pendiente(s) en este periodo.</p>}
        {periodoOp === 'reabrir' && <label className="block font-semibold text-slate-700">Motivo (obligatorio)<textarea className="mt-1 w-full rounded-lg border px-3 py-2" rows={3} maxLength={500} value={motivo} onChange={e => setMotivo(e.target.value)} required /></label>}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setPeriodoOp(null)} className="rounded-lg border px-4 py-2">Cancelar</button>
          <button disabled={busy} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{periodoOp === 'cerrar' ? 'Confirmar cierre' : 'Confirmar reapertura'}</button></div>
      </form>
    </Modal>}
  </div>
}
