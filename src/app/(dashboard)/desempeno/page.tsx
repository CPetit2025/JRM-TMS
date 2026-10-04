'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Check, ClipboardList, Gauge, Loader2, Send, Settings2, Users, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmt } from '@/lib/fleet/api'

// Desempeño por rol (migración 20261005180000): Supervisor de Despacho, Supervisor de Transporte / Jefe de Distribución,
// Asistente Documentario y Conductores. Índice 0–100 ponderado por KPI, informe mensual (día 3) y metas editables.

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Tab = 'mio' | 'informe' | 'equipo' | 'metas'
const ROLES: Array<[string, string]> = [['DESPACHO', 'Supervisor de Despacho'], ['TRANSPORTE', 'Transporte / Jefe de Distribución'], ['DOCUMENTARIO', 'Asistente Documentario'], ['CONDUCTOR', 'Conductores']]
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']
const mesTxt = (d?: string) => { if (!d) return ''; const [y, m] = d.slice(0, 7).split('-').map(Number); return `${MESES[m - 1]} ${y}` }
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
const fecha = (s?: string | null) => (s ? new Date(s.length <= 10 ? `${s}T12:00:00` : s).toLocaleDateString('es-PE') : '—')
const CALIF: Record<string, [string, string]> = {
  EXCELENTE: ['Excelente', 'bg-emerald-100 text-emerald-800'], BUENO: ['Bueno', 'bg-sky-100 text-sky-800'],
  REGULAR: ['Regular', 'bg-amber-100 text-amber-800'], BAJO: ['Bajo', 'bg-red-100 text-red-800'], SIN_DATOS: ['Sin datos suficientes', 'bg-slate-100 text-slate-600'],
}
const INFORME: Record<string, [string, string]> = {
  REVISADO: ['Revisado', 'text-emerald-700'], ENVIADO: ['Enviado, por revisar', 'text-sky-700'], OBSERVADO: ['Observado: corregir', 'text-amber-700'],
  ATRASADO: ['Atrasado', 'text-[#cf152d]'], PENDIENTE: ['Pendiente', 'text-amber-700'], MES_EN_CURSO: ['Mes en curso', 'text-slate-500'],
}
const valorTxt = (k: Row) => k.valor == null ? '—' : k.unidad === '%' ? `${fmt(k.valor, 1)} %` : k.unidad === 'h' ? `${fmt(k.valor, 1)} h` : fmt(k.valor)
const metaTxt = (k: Row) => `${k.sentido === 'MAYOR' ? '≥' : '≤'} ${k.unidad === '%' ? `${fmt(k.meta)} %` : k.unidad === 'h' ? `${fmt(k.meta, 1)} h` : fmt(k.meta)}`

export default function DesempenoPage() {
  const [tab, setTab] = useState<Tab>('mio')
  const [mes, setMes] = useState(() => ymd(new Date()))
  const [mio, setMio] = useState<Row | null>(null)
  const [nonce, setNonce] = useState(0)
  const [detalle, setDetalle] = useState<Row | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search).get('tab')
      if (q && ['mio', 'informe', 'equipo', 'metas'].includes(q)) setTab(q as Tab)
    }, 0)
    return () => window.clearTimeout(t)
  }, [])
  useEffect(() => {
    let alive = true
    supabase.rpc('desempeno_mio', { p_mes: mes }).then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.success) { toast.error(error?.message || data?.error); return }
      setMio(data)
    })
    return () => { alive = false }
  }, [mes, nonce])
  const revisor = !!mio?.revisor
  const conInforme = (mio?.roles || []).filter((r: Row) => r.informe)
  const go = (k: Tab) => { setTab(k); setDetalle(null); window.history.replaceState(null, '', `?tab=${k}`) }
  const tabs: Array<[Tab, string, typeof Gauge]> = [['mio', 'Mi desempeño', Gauge],
    ...(conInforme.length ? [['informe', 'Informe mensual', ClipboardList]] as Array<[Tab, string, typeof Gauge]> : []),
    ...(revisor ? [['equipo', 'Equipo', Users], ['metas', 'Metas y pesos', Settings2]] as Array<[Tab, string, typeof Gauge]> : [])]

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Gauge className="h-6 w-6 text-[#002855]" />Desempeño por rol</h1>
          <p className="text-sm text-slate-500">Indicadores del mes de Despacho, Transporte, Asistente Documentario y Conductores: índice 0–100 contra metas.</p>
        </div>
        {(tab === 'mio' || tab === 'equipo') && (
          <label className="text-sm text-slate-600">Mes <input type="month" className="ml-1 rounded-lg border px-2 py-1.5" value={mes.slice(0, 7)} onChange={e => e.target.value && setMes(`${e.target.value}-01`)} /></label>
        )}
      </div>
      <div className="flex gap-1 overflow-x-auto border-b">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} onClick={() => go(k)} className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-[#002855] font-semibold text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>
      {!mio ? <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div>
        : detalle ? <Ficha k={detalle} onVolver={() => setDetalle(null)} />
        : tab === 'mio' ? <Mio mio={mio} />
        : tab === 'informe' ? <Informe roles={conInforme} onEnviado={() => setNonce(n => n + 1)} />
        : tab === 'equipo' && revisor ? <Equipo mes={mes} onVer={setDetalle} />
        : tab === 'metas' && revisor ? <Metas />
        : null}
    </div>
  )
}

function Indice({ k, compacto }: { k: Row; compacto?: boolean }) {
  const [label, cls] = CALIF[k.calificacion] || CALIF.SIN_DATOS
  return (
    <div className={`flex flex-col items-center justify-center rounded-lg bg-[#002855] text-white ${compacto ? 'p-3' : 'p-5'}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">Índice del mes</div>
      <div className={`${compacto ? 'text-3xl' : 'text-5xl'} font-extrabold`}>{k.indice ?? '—'}</div>
      <span className={`mt-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>
      {k.cobertura != null && <div className="mt-1 text-[10px] opacity-70">{fmt(k.cobertura)} % del peso medido</div>}
    </div>
  )
}

function TablaKpis({ k }: { k: Row }) {
  const grupos = useMemo(() => {
    const g: Record<string, Row[]> = {}
    for (const x of k.kpis || []) (g[x.grupo || 'General'] ||= []).push(x)
    return Object.entries(g)
  }, [k])
  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
          <th className="p-2 text-left">Indicador</th><th className="p-2 text-right">Resultado</th><th className="p-2 text-right">Meta</th><th className="p-2 text-right">Peso</th><th className="w-40 p-2 text-left">Puntaje</th>
        </tr></thead>
        <tbody>
          {grupos.map(([g, rows]) => (
            <Fragment key={g}>
              <tr className="bg-slate-50/60"><td colSpan={5} className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[#002855]">{g}</td></tr>
              {rows.map(x => {
                const p = x.puntaje
                return (
                  <tr key={x.codigo} className="border-t">
                    <td className="p-2"><div className="font-medium text-slate-800">{x.nombre}</div><div className="text-[11px] text-slate-500">{x.descripcion}</div></td>
                    <td className="whitespace-nowrap p-2 text-right font-semibold">{valorTxt(x)}{x.contexto && <div className="text-[10px] font-normal text-slate-400">{x.contexto}</div>}</td>
                    <td className="whitespace-nowrap p-2 text-right text-slate-500">{x.peso > 0 ? metaTxt(x) : 'informativo'}</td>
                    <td className="p-2 text-right text-slate-500">{x.peso > 0 ? `${fmt(x.peso)}` : '—'}</td>
                    <td className="p-2">{p == null ? <span className="text-xs text-slate-400">{x.peso > 0 ? 'sin datos' : ''}</span> : (
                      <div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded bg-slate-100"><div className={`h-1.5 rounded ${p >= 90 ? 'bg-emerald-500' : p >= 70 ? 'bg-amber-500' : 'bg-[#cf152d]'}`} style={{ width: `${p}%` }} /></div><span className="w-9 text-right text-xs font-semibold">{fmt(p)}</span></div>
                    )}</td>
                  </tr>
                )
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Ficha({ k, onVolver }: { k: Row; onVolver?: () => void }) {
  const inf = k.informe
  const [est, ecls] = inf ? INFORME[inf.estado] || ['—', ''] : ['', '']
  return (
    <div className="space-y-3">
      {onVolver && <button onClick={onVolver} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm"><ArrowLeft className="h-4 w-4" />Volver al equipo</button>}
      <div className="grid gap-3 md:grid-cols-[200px_1fr]">
        <Indice k={k} />
        <div className="space-y-2 rounded-xl border bg-white p-4 text-sm">
          <div className="text-lg font-semibold text-slate-800">{k.nombre || k.rol_nombre || k.rol} <span className="text-sm font-normal text-slate-500">· {mesTxt(k.periodo)}</span></div>
          {k.siniestro_grave && <div className="rounded-lg bg-red-50 p-2 text-red-800">Siniestro grave con responsabilidad del conductor: el índice del mes queda en 0.</div>}
          {inf && <div className={ecls}>Informe mensual: {est}{inf.dias_atraso ? ` · ${inf.dias_atraso} día(s) de atraso` : ''} <span className="text-xs text-slate-500">· vence el {fecha(inf.vence)}</span></div>}
          {inf?.comentario && <div className="text-xs text-slate-600"><b>Comentario del revisor:</b> {inf.comentario}</div>}
          <p className="text-xs text-slate-500">Cada indicador recibe 0–100 puntos según su meta. El índice es el promedio ponderado de los que tienen datos. Con menos del 40 % del peso medido, el índice no se calcula.</p>
          {(k.notas || []).length > 0 && <p className="text-xs text-amber-700">Algunos datos no se pudieron leer: {(k.notas || []).join(' · ')}</p>}
        </div>
      </div>
      <TablaKpis k={k} />
    </div>
  )
}

function Mio({ mio }: { mio: Row }) {
  const roles: Row[] = mio.roles || []
  if (!roles.length) return (
    <div className="rounded-xl border bg-white p-6 text-sm text-slate-600">
      Su usuario no está registrado en ninguno de los roles medidos (Supervisor de Despacho, Transporte / Jefe de Distribución o Asistente Documentario).
      {mio.revisor && <> Como revisor, vea los resultados en la pestaña <b>Equipo</b>.</>}
    </div>
  )
  return <div className="space-y-6">{roles.map(k => <Ficha key={k.rol} k={k} />)}</div>
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

function Equipo({ mes, onVer }: { mes: string; onVer: (k: Row) => void }) {
  const [rol, setRol] = useState('CONDUCTOR')
  const [res, setRes] = useState<{ key: string; data: Row | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const key = `${rol}|${mes}|${nonce}`
  useEffect(() => {
    let alive = true
    supabase.rpc('desempeno_equipo', { p_rol: rol, p_mes: mes }).then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.success) toast.error(error?.message || data?.error)
      setRes({ key, data: data?.success ? data : null })
    })
    return () => { alive = false }
  }, [key, rol, mes])
  const d = res?.data
  const revisar = async (i: Row, estado: 'REVISADO' | 'OBSERVADO') => {
    const comentario = estado === 'OBSERVADO' ? prompt('¿Qué debe corregir?') : prompt('Comentario (opcional):')
    if (estado === 'OBSERVADO' && !comentario?.trim()) return
    const { data, error } = await supabase.rpc('desempeno_revisar_informe', { p_id: i.id, p_estado: estado, p_comentario: comentario || null })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(estado === 'REVISADO' ? 'Informe revisado' : 'Informe observado'); setNonce(n => n + 1)
  }
  const miembros: Row[] = d?.miembros || []
  const prom = miembros.filter(m => m.indice != null)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {ROLES.map(([k, l]) => <button key={k} onClick={() => setRol(k)} className={`rounded-full border px-3 py-1 text-sm ${rol === k ? 'border-[#002855] bg-[#002855] text-white' : 'bg-white text-slate-600'}`}>{l}</button>)}
      </div>
      {res?.key !== key ? <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-[#002855]" /></div> : (
        <>
          <div className="text-sm text-slate-600">{miembros.length} integrante(s){prom.length ? ` · índice promedio ${fmt(prom.reduce((s, m) => s + Number(m.indice), 0) / prom.length)}` : ''}</div>
          <div className="overflow-x-auto rounded-xl border bg-white">
            {miembros.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Nadie registrado en este rol. Se mide a quien tiene el rol o el permiso correspondiente en Usuarios (conductores: maestro de conductores).</p> : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                  <th className="p-2 text-left">Nombre</th><th className="p-2 text-right">Índice</th><th className="p-2 text-left">Por mejorar</th>{rol !== 'CONDUCTOR' && <th className="p-2 text-left">Informe</th>}<th className="p-2"></th>
                </tr></thead>
                <tbody className="divide-y">
                  {[...miembros].sort((a, b) => (b.indice ?? -1) - (a.indice ?? -1)).map(m => {
                    const [cal, cls] = CALIF[m.calificacion] || CALIF.SIN_DATOS
                    const peores = (m.kpis || []).filter((x: Row) => x.puntaje != null && x.puntaje < 80).sort((a: Row, b: Row) => a.puntaje - b.puntaje).slice(0, 2)
                    const [est, ecls] = m.informe ? INFORME[m.informe.estado] || ['—', ''] : ['', '']
                    return (
                      <tr key={m.sujeto}>
                        <td className="p-2 font-semibold">{m.nombre}</td>
                        <td className="whitespace-nowrap p-2 text-right"><b>{m.indice ?? '—'}</b> <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{cal}</span></td>
                        <td className="p-2 text-xs text-slate-600">{peores.length ? peores.map((x: Row) => `${x.nombre} (${valorTxt(x)})`).join(' · ') : '—'}</td>
                        {rol !== 'CONDUCTOR' && <td className={`p-2 text-xs ${ecls}`}>{est}{m.informe?.dias_atraso ? ` · ${m.informe.dias_atraso} d` : ''}</td>}
                        <td className="p-2"><button onClick={() => onVer(m)} className="rounded-lg border px-2 py-1 text-xs font-semibold text-[#002855]">Ver detalle</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          {rol !== 'CONDUCTOR' && (
            <div className="rounded-xl border bg-white">
              <div className="border-b px-3 py-2 text-sm font-semibold text-slate-800">Informes mensuales recientes</div>
              {(d?.informes || []).length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Sin informes recientes.</p> : d!.informes.map((i: Row) => (
                <div key={i.id} className="space-y-1 border-t p-3 text-sm first:border-t-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><b>{i.nombre}</b> · <span className="capitalize">{mesTxt(i.periodo)}</span> · <span className={(INFORME[i.estado] || ['', ''])[1]}>{(INFORME[i.estado] || [i.estado])[0]}</span>
                      <span className="text-xs text-slate-500"> · {i.dias_atraso ? `${i.dias_atraso} d de atraso` : 'a tiempo'} · índice {i.indice ?? '—'}</span></div>
                    {i.estado !== 'REVISADO' && (
                      <div className="flex gap-1">
                        <button onClick={() => revisar(i, 'REVISADO')} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" />Revisado</button>
                        <button onClick={() => revisar(i, 'OBSERVADO')} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs text-amber-700"><X className="h-3.5 w-3.5" />Observar</button>
                      </div>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-slate-700">{i.logros}</p>
                  {i.problemas && <p className="whitespace-pre-wrap text-xs text-slate-600"><b>Problemas:</b> {i.problemas}</p>}
                  {i.acciones && <p className="whitespace-pre-wrap text-xs text-slate-600"><b>Acciones:</b> {i.acciones}</p>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Metas() {
  const [rows, setRows] = useState<Row[]>([])
  const [rol, setRol] = useState('CONDUCTOR')
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
      <div className="flex flex-wrap gap-1">{ROLES.map(([k, l]) => <button key={k} onClick={() => setRol(k)} className={`rounded-full border px-3 py-1 text-sm ${rol === k ? 'border-[#002855] bg-[#002855] text-white' : 'bg-white text-slate-600'}`}>{l}</button>)}</div>
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
    </div>
  )
}
