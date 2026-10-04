'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ClipboardList, Download, FileText, Gauge, LayoutDashboard, Loader2, Send, Settings2, Users, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmt } from '@/lib/fleet/api'
import { Ficha, INFORME, Indice, ROL_COLOR, Row, fecha, mesTxt, ymd } from '@/components/kpi/kpiUi'
import { MiAvance } from '@/components/kpi/MiAvance'
import { Equipo, Informes, Tablero, exportarTablero } from '@/components/kpi/TableroKpi'

// Indicadores (KPI): un solo módulo.
//  - Jefe de Distribución y Administrador (permiso «desempeno»): Tablero, Equipo, Informes y Metas de los 5 roles medidos
//    (Despacho, Transporte, Documentario, Conductores y Soporte Mecánico) — kpi_tablero.
//  - Cada usuario medido: «Mi avance» (kpi_mi_avance) y su Informe mensual.

const supabase = createClient()
type Tab = 'tablero' | 'equipo' | 'informes' | 'metas' | 'mio' | 'informe'
const TABS: Tab[] = ['tablero', 'equipo', 'informes', 'metas', 'mio', 'informe']
const ROLES_METAS: Array<[string, string]> = [['DESPACHO', 'Supervisor de Despacho'], ['TRANSPORTE', 'Transporte / Jefe de Distribución'], ['DOCUMENTARIO', 'Asistente Documentario'], ['CONDUCTOR', 'Conductores'], ['SOPORTE', 'Soporte Mecánico']]

export default function IndicadoresPage() {
  const [tab, setTab] = useState<Tab | null>(null)
  const [mes, setMes] = useState(() => ymd(new Date()))
  const [mio, setMio] = useState<Row | null>(null)
  const [tab_, setTablero] = useState<{ key: string; data: Row | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [detalle, setDetalle] = useState<Row | null>(null)
  const [rolEquipo, setRolEquipo] = useState('DESPACHO')

  useEffect(() => {
    let alive = true
    supabase.rpc('kpi_mi_avance', { p_mes: mes }).then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.success) { toast.error(error?.message || data?.error); return }
      setMio(data)
    })
    return () => { alive = false }
  }, [mes, nonce])
  const revisor = !!mio?.revisor
  const key = `${mes}|${nonce}`
  useEffect(() => {
    if (!revisor) return
    let alive = true
    supabase.rpc('kpi_tablero', { p_mes: mes }).then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.success) toast.error(error?.message || data?.error)
      setTablero({ key, data: data?.success ? data : null })
    })
    return () => { alive = false }
  }, [key, mes, revisor])

  const conInforme: Row[] = (mio?.roles || []).filter((r: Row) => r.tiene_informe && r.rol !== 'SOPORTE')
  const medido = (mio?.roles || []).length > 0
  const tabs = useMemo(() => {
    const t: Array<[Tab, string, typeof Gauge]> = []
    if (revisor) t.push(['tablero', 'Tablero', LayoutDashboard], ['equipo', 'Equipo', Users], ['informes', 'Informes', FileText])
    if (medido || !revisor) t.push(['mio', 'Mi avance', Gauge])
    if (conInforme.length) t.push(['informe', 'Mi informe mensual', ClipboardList])
    if (revisor) t.push(['metas', 'Metas y pesos', Settings2])
    return t
  }, [revisor, medido, conInforme.length])

  // Pestaña inicial: la de la URL si corresponde; si no, Tablero (revisor) o Mi avance
  useEffect(() => {
    if (!mio || tab) return
    const t = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search).get('tab') as Tab | null
      const ok = tabs.map(x => x[0])
      setTab(q && TABS.includes(q) && ok.includes(q) ? q : ok[0])
    }, 0)
    return () => window.clearTimeout(t)
  }, [mio, tab, tabs])

  const go = (k: Tab) => { setTab(k); setDetalle(null); window.history.replaceState(null, '', `?tab=${k}`) }
  const t = tab_?.key === key ? tab_.data : null
  const cargandoTablero = revisor && tab_?.key !== key
  const conMes = tab === 'tablero' || tab === 'equipo' || tab === 'mio'

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Gauge className="h-6 w-6 text-[#002855]" />Indicadores (KPI)</h1>
          <p className="text-sm text-slate-500">
            {revisor ? 'Despacho, Transporte, Documentario, Conductores y Soporte Mecánico en un solo tablero: índice 0–100 contra metas, evolución e informes.'
              : 'Su avance del mes: índice 0–100, indicadores contra su meta y lo que falta para cumplir.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {conMes && <label className="text-sm text-slate-600">Mes <input type="month" className="ml-1 rounded-lg border px-2 py-1.5" value={mes.slice(0, 7)} onChange={e => e.target.value && setMes(`${e.target.value}-01`)} /></label>}
          {revisor && t && (tab === 'tablero' || tab === 'equipo') && (
            <button onClick={() => exportarTablero(t)} className="flex items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm font-semibold text-[#002855]"><Download className="h-4 w-4" />Exportar Excel</button>
          )}
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} onClick={() => go(k)} className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-[#002855] font-semibold text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            <Icon className="h-4 w-4" />{label}
            {k === 'informes' && (t?.general?.informes_por_revisar ?? 0) > 0 && <span className="rounded-full bg-sky-600 px-1.5 text-[10px] font-bold text-white">{t?.general?.informes_por_revisar}</span>}
          </button>
        ))}
      </div>
      {!mio || !tab ? <Cargando />
        : detalle ? <Ficha k={detalle} onVolver={() => setDetalle(null)} volverTxt="Volver al equipo" />
        : tab === 'mio' ? <MiAvance data={mio} onInforme={conInforme.length ? () => go('informe') : undefined} />
        : tab === 'informe' ? <Informe roles={conInforme} onEnviado={() => setNonce(n => n + 1)} />
        : tab === 'metas' && revisor ? <Metas />
        : cargandoTablero ? <Cargando />
        : !t ? <p className="rounded-xl border bg-white p-6 text-sm text-slate-500">No se pudo cargar el tablero.</p>
        : tab === 'tablero' ? <Tablero t={t} onRol={r => { setRolEquipo(r); go('equipo') }} />
        : tab === 'equipo' ? <Equipo t={t} rol={rolEquipo} setRol={setRolEquipo} onVer={setDetalle} />
        : tab === 'informes' ? <Informes t={t} onCambio={() => setNonce(n => n + 1)} />
        : null}
    </div>
  )
}

function Cargando() {
  return <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div>
}

function Informe({ roles, onEnviado }: { roles: Row[]; onEnviado: () => void }) {
  const prev = useMemo(() => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)) }, [])
  const [rol, setRol] = useState(roles[0]?.rol || '')
  const [periodo, setPeriodo] = useState(prev)
  const [k, setK] = useState<Row | null>(null)
  const [mios, setMios] = useState<Row[]>([])
  const [form, setForm] = useState({ logros: '', problemas: '', acciones: '' })
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    supabase.rpc('desempeno_mio', { p_mes: periodo }).then(({ data }) => setK((data?.roles || []).find((x: Row) => x.rol === rol) || null))
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return
      supabase.from('desempeno_informes').select('*').eq('user_id', data.user.id).order('periodo', { ascending: false }).limit(24).then(({ data: r }) => {
        setMios(r || [])
        const i = (r || []).find(x => x.periodo === periodo && x.rol === rol)
        setForm({ logros: i?.logros || '', problemas: i?.problemas || '', acciones: i?.acciones || '' })
      })
    })
  }, [periodo, rol])
  useEffect(() => { load() }, [load])
  const actual = mios.find(x => x.periodo === periodo && x.rol === rol)
  const bloqueado = actual?.estado === 'REVISADO'
  const enviar = async () => {
    setSaving(true)
    const { data, error } = await supabase.rpc('desempeno_enviar_informe', { p_rol: rol, p_periodo: periodo, p_logros: form.logros, p_problemas: form.problemas || null, p_acciones: form.acciones || null })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(data.dias_atraso ? `Informe enviado con ${data.dias_atraso} día(s) de atraso` : 'Informe enviado a tiempo')
    load(); onEnviado()
  }
  const inf = k?.informe || {}
  const field = 'w-full rounded-lg border px-3 py-2 text-sm'
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3 rounded-xl border bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          {roles.length > 1 && <select className="rounded-lg border px-2 py-1.5" value={rol} onChange={e => setRol(e.target.value)}>{roles.map(r => <option key={r.rol} value={r.rol}>{r.rol_nombre}</option>)}</select>}
          <label className="text-slate-600">Mes <input type="month" max={prev.slice(0, 7)} className="ml-1 rounded-lg border px-2 py-1.5" value={periodo.slice(0, 7)} onChange={e => e.target.value && setPeriodo(`${e.target.value}-01`)} /></label>
          <span className={(INFORME[inf.estado] || ['', ''])[1]}>{(INFORME[inf.estado] || ['—'])[0]} · vence el {fecha(inf.vence)}{inf.dias_atraso ? <b> · {inf.dias_atraso} día(s) de atraso</b> : null}</span>
        </div>
        {actual?.estado === 'OBSERVADO' && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900"><b>Observación:</b> {actual.comentario}</div>}
        {actual?.estado === 'REVISADO' && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">Revisado{actual.comentario ? `: ${actual.comentario}` : ''}</div>}
        {k && <div className="flex items-center gap-3 rounded-lg bg-slate-50 p-3"><Indice k={k} compacto /><p className="text-xs text-slate-600">Sus indicadores de {mesTxt(periodo)} se adjuntan solos al enviar. Explique abajo sus resultados, los problemas y lo que hará el próximo mes.</p></div>}
        <label className="block">Resultados y logros del mes *<textarea disabled={bloqueado} className={field} rows={5} value={form.logros} onChange={e => setForm({ ...form, logros: e.target.value })} /></label>
        <label className="block">Problemas o limitaciones<textarea disabled={bloqueado} className={field} rows={3} value={form.problemas} onChange={e => setForm({ ...form, problemas: e.target.value })} /></label>
        <label className="block">Acciones para el próximo mes<textarea disabled={bloqueado} className={field} rows={3} value={form.acciones} onChange={e => setForm({ ...form, acciones: e.target.value })} /></label>
        {!bloqueado && <button disabled={saving || !rol} onClick={enviar} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{actual ? 'Corregir y reenviar' : 'Enviar informe'}</button>}
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Cómo funciona</div>
          <ul className="list-disc space-y-1 pl-4 text-slate-600">
            <li>El día 1 llega un recordatorio a la campana.</li>
            <li>Vence el día 3 del mes siguiente.</li>
            <li>Desde el día 4 hay un aviso diario a usted y a su revisor.</li>
            <li>Cada día de atraso baja la puntualidad del informe en 15 puntos.</li>
          </ul>
        </div>
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Mis informes</div>
          {mios.length === 0 ? <p className="text-slate-500">Aún no hay informes.</p> : mios.map(i => (
            <button key={i.id} onClick={() => { setRol(i.rol); setPeriodo(i.periodo) }} className="flex w-full justify-between border-t py-1.5 text-left first:border-t-0">
              <span className="capitalize">{mesTxt(i.periodo)} <span className="text-xs text-slate-400">· {i.rol.toLowerCase()}</span></span>
              <span className={`${(INFORME[i.estado] || ['', ''])[1]} text-xs`}>{(INFORME[i.estado] || [i.estado])[0]}{i.dias_atraso ? ` · ${i.dias_atraso} d` : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Metas() {
  const [rows, setRows] = useState<Row[]>([])
  const [rol, setRol] = useState('DESPACHO')
  const [saving, setSaving] = useState(false)
  useEffect(() => { supabase.from('kpi_parametros').select('*').order('orden').then(({ data }) => setRows(data || [])) }, [])
  const vis = rows.filter(r => r.rol === rol)
  const total = vis.reduce((s, r) => s + Number(r.peso || 0), 0)
  const set = (codigo: string, campo: 'meta' | 'peso', v: string) => setRows(rows.map(r => r.rol === rol && r.codigo === codigo ? { ...r, [campo]: v } : r))
  const guardar = async () => {
    setSaving(true)
    const { data, error } = await supabase.rpc('desempeno_guardar_parametros', { p_items: vis.map(r => ({ rol: r.rol, codigo: r.codigo, meta: Number(r.meta), peso: Number(r.peso) })) })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Metas y pesos guardados')
  }
  const field = 'w-20 rounded-lg border px-2 py-1 text-right text-sm'
  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap gap-1">{ROLES_METAS.map(([k, l]) => <button key={k} onClick={() => setRol(k)} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${rol === k ? 'border-[#002855] bg-[#002855] text-white' : 'bg-white text-slate-600'}`}><span className="h-2 w-2 rounded-full" style={{ background: ROL_COLOR[k] }} />{l}</button>)}</div>
      {rol === 'SOPORTE' ? (
        <div className="rounded-xl border bg-white p-4 text-sm text-slate-600">
          El índice de Soporte Mecánico pondera: respuesta dentro del plazo 30 · solución dentro del plazo 30 · reincidencias 15 · fallas abiertas
          envejecidas 10 · puntualidad del informe 15. Los plazos de respuesta y solución por criticidad se ajustan en{' '}
          <a href="/mantenimiento/soporte?tab=plazos" className="font-semibold text-[#002855] underline">Soporte Mecánico › Plazos</a>.
        </div>
      ) : <>
      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-2 text-left">Indicador</th><th className="p-2 text-right">Meta</th><th className="p-2 text-right">Peso</th></tr></thead>
          <tbody className="divide-y">{vis.map(r => (
            <tr key={r.codigo}>
              <td className="p-2"><div className="font-medium">{r.nombre}</div><div className="text-[11px] text-slate-500">{r.grupo} · {r.sentido === 'MAYOR' ? 'mayor es mejor' : 'menor es mejor'} · {r.unidad === '%' ? 'porcentaje' : r.unidad === 'h' ? 'horas' : 'cantidad'}</div></td>
              <td className="p-2 text-right"><input type="number" step="0.1" className={field} value={r.meta} onChange={e => set(r.codigo, 'meta', e.target.value)} /></td>
              <td className="p-2 text-right"><input type="number" min={0} className={field} value={r.peso} onChange={e => set(r.codigo, 'peso', e.target.value)} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>Suma de pesos: <b>{fmt(total)}</b> (el índice se normaliza; con 0 el indicador queda como informativo)</span>
        <button disabled={saving} onClick={guardar} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Guardar</button>
      </div>
      </>}
    </div>
  )
}
