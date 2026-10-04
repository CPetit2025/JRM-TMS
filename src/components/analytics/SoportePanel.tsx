'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Check, ClipboardList, Gauge, Loader2, RefreshCw, Send, Settings2, Timer, Users, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { fmt } from '@/lib/fleet/api'

// Soporte Mecánico (migración 20261005150000): capacidad de respuesta frente al SLA, índice de eficiencia,
// informe mensual (vence el día 3; el atraso baja el índice) y vista del equipo para el supervisor.

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Tab = 'desempeno' | 'informe' | 'equipo' | 'plazos'
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']
const mesTxt = (d?: string) => { if (!d) return ''; const [y, m] = d.slice(0, 7).split('-').map(Number); return `${MESES[m - 1]} ${y}` }
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
const fechaHora = (s?: string | null) => (s ? new Date(s).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const horas = (h: unknown) => (h == null ? '—' : Number(h) < 1 ? `${Math.round(Number(h) * 60)} min` : Number(h) < 48 ? `${fmt(Number(h), 1)} h` : `${fmt(Number(h) / 24, 1)} d`)
const CALIF: Record<string, [string, string]> = {
  EXCELENTE: ['Excelente', 'bg-emerald-100 text-emerald-800'], BUENO: ['Bueno', 'bg-sky-100 text-sky-800'],
  REGULAR: ['Regular', 'bg-amber-100 text-amber-800'], BAJO: ['Bajo', 'bg-red-100 text-red-800'], SIN_DATOS: ['Sin datos', 'bg-slate-100 text-slate-600'],
}
const INFORME: Record<string, [string, string]> = {
  REVISADO: ['Revisado', 'text-emerald-700'], ENVIADO: ['Enviado, por revisar', 'text-sky-700'], OBSERVADO: ['Observado: corregir', 'text-amber-700'],
  ATRASADO: ['Atrasado', 'text-[#cf152d]'], PENDIENTE: ['Pendiente', 'text-amber-700'], MES_EN_CURSO: ['Mes en curso', 'text-slate-500'],
}
const COMP: Array<[string, string]> = [['respuesta', 'Respuesta dentro del plazo'], ['solucion', 'Solución dentro del plazo'], ['reincidencia', 'Sin reincidencia'], ['backlog', 'Backlog al día'], ['informe', 'Puntualidad del informe']]

export default function SoportePanel() {
  const { canWrite, isLoaded } = usePermissions()
  const supervisor = isLoaded && canWrite('mantenimiento-dashboard')
  const [tab, setTab] = useState<Tab>('desempeno')
  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search).get('supportTab')
      if (q && ['desempeno', 'informe', 'equipo', 'plazos'].includes(q)) setTab(q as Tab)
    }, 0)
    return () => window.clearTimeout(t)
  }, [])
  const [mes, setMes] = useState(() => ymd(new Date()))
  const [usuario, setUsuario] = useState<{ id: string; nombre: string } | null>(null)

  const go = (k: Tab) => { setTab(k); const q = new URLSearchParams(window.location.search); q.set('section', 'desempeno'); q.set('tab', 'soporte'); q.set('supportTab', k); window.history.replaceState(null, '', `?${q}`) }
  const tabs: Array<[Tab, string, typeof Gauge]> = [['desempeno', usuario ? `Desempeño de ${usuario.nombre}` : 'Mi desempeño', Gauge], ['informe', 'Informe mensual', ClipboardList],
    ...(supervisor ? [['equipo', 'Equipo', Users], ['plazos', 'Plazos (SLA)', Settings2]] as Array<[Tab, string, typeof Gauge]> : [])]

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Timer className="h-6 w-6 text-[#002855]" />Soporte Mecánico</h1>
          <p className="text-sm text-slate-500">Capacidad de respuesta ante fallas e incidencias, índice de eficiencia del mes e informe mensual.</p>
        </div>
        {tab === 'desempeno' && (
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
      {tab === 'desempeno' && <Desempeno mes={mes} usuario={usuario} onVolver={usuario ? () => { setUsuario(null); go('equipo') } : undefined} />}
      {tab === 'informe' && <Informe />}
      {tab === 'equipo' && supervisor && <Equipo mes={mes} setMes={setMes} onVer={u => { setUsuario(u); go('desempeno') }} />}
      {tab === 'plazos' && supervisor && <Plazos />}
    </div>
  )
}

function Indice({ k }: { k: Row }) {
  const [label, cls] = CALIF[k.calificacion] || CALIF.SIN_DATOS
  return (
    <div className="grid gap-4 rounded-xl border bg-white p-4 md:grid-cols-[220px_1fr]">
      <div className="flex flex-col items-center justify-center rounded-lg bg-[#002855] p-4 text-white">
        <div className="text-xs uppercase tracking-wide opacity-80">Índice de eficiencia</div>
        <div className="text-5xl font-extrabold">{k.indice ?? '—'}</div>
        <span className={`mt-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>
      </div>
      <div className="space-y-2 text-sm">
        {COMP.map(([key, txt]) => {
          const v = k.componentes?.[key]
          return (
            <div key={key} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
              <div className="flex justify-between text-slate-600"><span>{txt}</span><span className="text-xs text-slate-400">peso {k.pesos?.[key]} %</span></div>
              <div className="w-14 text-right font-semibold">{v == null ? '—' : `${fmt(v, 0)} %`}</div>
              <div className="col-span-2 h-1.5 rounded bg-slate-100"><div className={`h-1.5 rounded ${v == null ? '' : v >= 90 ? 'bg-emerald-500' : v >= 70 ? 'bg-amber-500' : 'bg-[#cf152d]'}`} style={{ width: `${v ?? 0}%` }} /></div>
            </div>
          )
        })}
        <p className="pt-1 text-xs text-slate-400">Los componentes sin datos en el mes no cuentan. Puntualidad: −{15} puntos por día de atraso del informe (ver Plazos).</p>
      </div>
    </div>
  )
}

function Desempeno({ mes, usuario, onVolver }: { mes: string; usuario: { id: string; nombre: string } | null; onVolver?: () => void }) {
  const [nonce, setNonce] = useState(0)
  const key = `${mes}|${usuario?.id ?? ''}|${nonce}`
  const [res, setRes] = useState<{ key: string; data: Row | null } | null>(null)
  useEffect(() => {
    let alive = true
    supabase.rpc('soporte_kpis', { p_usuario: usuario?.id ?? null, p_mes: mes }).then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.success) toast.error(error?.message || data?.error)
      setRes({ key, data: data?.success ? data : null })
    })
    return () => { alive = false }
  }, [key, mes, usuario])
  const loading = res?.key !== key
  const k = res?.data ?? null
  const load = () => setNonce(n => n + 1)
  if (loading && !k) return <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div>
  if (!k) return <p className="p-8 text-center text-sm text-slate-500">Sin datos.</p>
  const f = k.fallas || {}, inf = k.informe || {}
  const tiles: Array<[string, string, string, boolean?]> = [
    ['Fallas atendidas', fmt(f.atendidas), `${fmt(f.criticas)} críticas · ${fmt(f.cerradas)} cerradas`],
    ['Tiempo de respuesta', horas(f.respuesta_prom_h), f.respuesta_en_sla_pct == null ? 'sin datos' : `${fmt(f.respuesta_en_sla_pct, 0)} % dentro del plazo`, (f.respuesta_en_sla_pct ?? 100) < 80],
    ['Tiempo de solución', horas(f.solucion_prom_h), f.solucion_en_sla_pct == null ? 'sin cierres' : `${fmt(f.solucion_en_sla_pct, 0)} % dentro del plazo`, (f.solucion_en_sla_pct ?? 100) < 80],
    ['Reincidencias', fmt(f.reincidencias), f.reincidencia_pct == null ? '—' : `${fmt(f.reincidencia_pct, 0)} % de lo cerrado`, (f.reincidencias ?? 0) > 0],
    ['Backlog abierto', fmt(k.backlog?.abiertas), `${fmt(k.backlog?.envejecidas)} con más de ${k.backlog?.envejecida_dias} días`, (k.backlog?.envejecidas ?? 0) > 0],
    ['OT cerradas', fmt(k.ot?.cerradas), `${fmt(k.ot?.preventivas)} preventivas · fuera de servicio ${horas(k.ot?.horas_fuera_servicio_prom)}`],
  ]
  const [estTxt, estCls] = INFORME[inf.estado] || ['—', '']
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600">{onVolver && <button onClick={onVolver} className="mr-2 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs"><ArrowLeft className="h-3.5 w-3.5" />Equipo</button>}
          <b>{k.nombre}</b> · {mesTxt(k.periodo)}</div>
        <button onClick={load} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
      </div>
      <Indice k={k} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([t, v, sub, bad]) => (
          <div key={t} className="rounded-xl border bg-white p-3">
            <div className="text-xs text-slate-500">{t}</div>
            <div className={`text-2xl font-bold ${bad ? 'text-[#cf152d]' : 'text-slate-900'}`}>{v}</div>
            <div className="text-[11px] text-slate-500">{sub}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Informe mensual de {mesTxt(k.periodo)}</div>
          <div className={estCls}>{estTxt}{inf.dias_atraso ? ` · ${inf.dias_atraso} día${inf.dias_atraso === 1 ? '' : 's'} de atraso` : ''}</div>
          <div className="text-xs text-slate-500">Vence el {inf.vence ? new Date(`${inf.vence}T12:00:00`).toLocaleDateString('es-PE') : '—'}{inf.enviado_at ? ` · enviado ${fechaHora(inf.enviado_at)}` : ''}</div>
        </div>
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Equipo en el mes</div>
          <div className="text-slate-600">{fmt(k.equipo?.recibidas)} fallas recibidas · <span className={(k.equipo?.sin_atender ?? 0) > 0 ? 'font-semibold text-[#cf152d]' : ''}>{fmt(k.equipo?.sin_atender)} sin atender</span> ({fmt(k.equipo?.sin_atender_fuera_sla)} fuera de plazo)</div>
          <Link href="/mantenimiento/fallas" className="text-xs font-semibold text-[#002855] hover:underline">Ir a Fallas y Backlog →</Link>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-white">
        <div className="border-b px-3 py-2 text-sm font-semibold text-slate-800">Fallas atendidas en el mes</div>
        {(k.detalle || []).length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Sin fallas atendidas en el mes.</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="p-2 text-left">Reportada</th><th className="p-2 text-left">Unidad</th><th className="p-2 text-left">Criticidad</th><th className="p-2 text-left">Reportó</th>
              <th className="p-2 text-right">Respuesta</th><th className="p-2 text-right">Solución</th><th className="p-2 text-left">Estado</th>
            </tr></thead>
            <tbody className="divide-y">
              {k.detalle.map((d: Row) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap p-2">{fechaHora(d.reportada)}</td>
                  <td className="p-2"><b>{d.placa}</b><div className="max-w-[260px] truncate text-xs text-slate-500">{d.descripcion}</div></td>
                  <td className="p-2 text-xs">{d.criticidad}</td>
                  <td className="p-2 text-xs text-slate-600">{d.reporto}</td>
                  <td className={`p-2 text-right ${d.respuesta_ok === false ? 'font-semibold text-[#cf152d]' : ''}`}>{horas(d.respuesta_h)}<div className="text-[10px] text-slate-400">plazo {horas(d.sla_respuesta_h)}</div></td>
                  <td className={`p-2 text-right ${d.solucion_ok === false ? 'font-semibold text-[#cf152d]' : ''}`}>{horas(d.solucion_h)}<div className="text-[10px] text-slate-400">plazo {horas(d.sla_solucion_h)}</div></td>
                  <td className="p-2 text-xs">{String(d.estado || '').replace('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-slate-500">
        <b>Cómo se mide:</b> la respuesta va desde que se reporta la falla (conductor, supervisor o Jefe de Distribución) hasta que el técnico la toma o cambia su estado.
        La solución va hasta el cierre. Ambas se comparan con el plazo de su criticidad. Hay reincidencia si la misma unidad vuelve a fallar dentro de los
        30 días posteriores al cierre. El backlog se considera envejecido cuando las fallas abiertas superan 7 días.
      </p>
    </div>
  )
}

function Informe() {
  const prev = useMemo(() => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)) }, [])
  const [periodo, setPeriodo] = useState(prev)
  const [k, setK] = useState<Row | null>(null)
  const [mios, setMios] = useState<Row[]>([])
  const [form, setForm] = useState({ logros: '', problemas: '', acciones: '' })
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    supabase.rpc('soporte_kpis', { p_usuario: null, p_mes: periodo }).then(({ data }) => setK(data?.success ? data : null))
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return
      supabase.from('soporte_informes').select('*').eq('user_id', data.user.id).order('periodo', { ascending: false }).limit(12).then(({ data: r }) => {
        setMios(r || [])
        const i = (r || []).find(x => x.periodo === periodo)
        setForm({ logros: i?.logros || '', problemas: i?.problemas || '', acciones: i?.acciones || '' })
      })
    })
  }, [periodo])
  useEffect(() => { load() }, [load])
  const actual = mios.find(x => x.periodo === periodo)
  const enviar = async () => {
    setSaving(true)
    const { data, error } = await supabase.rpc('soporte_enviar_informe', { p_periodo: periodo, p_logros: form.logros, p_problemas: form.problemas || null, p_acciones: form.acciones || null })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(data.dias_atraso ? `Informe enviado con ${data.dias_atraso} día(s) de atraso` : 'Informe enviado a tiempo')
    load()
  }
  const inf = k?.informe || {}
  const bloqueado = actual?.estado === 'REVISADO'
  const field = 'w-full rounded-lg border px-3 py-2 text-sm'
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3 rounded-xl border bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-slate-600">Mes del informe <input type="month" max={prev.slice(0, 7)} className="ml-1 rounded-lg border px-2 py-1.5" value={periodo.slice(0, 7)} onChange={e => e.target.value && setPeriodo(`${e.target.value}-01`)} /></label>
          <div className={(INFORME[inf.estado] || ['', ''])[1]}>{(INFORME[inf.estado] || ['—'])[0]} · vence el {inf.vence ? new Date(`${inf.vence}T12:00:00`).toLocaleDateString('es-PE') : '—'}
            {inf.dias_atraso ? <b> · {inf.dias_atraso} día{inf.dias_atraso === 1 ? '' : 's'} de atraso</b> : null}</div>
        </div>
        {actual?.estado === 'OBSERVADO' && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900"><b>Observación del supervisor:</b> {actual.comentario}</div>}
        {actual?.estado === 'REVISADO' && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-emerald-900">Revisado{actual.comentario ? `: ${actual.comentario}` : ''}</div>}
        {k && (
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 md:grid-cols-4">
            {[['Índice', k.indice ?? '—'], ['Fallas atendidas', fmt(k.fallas?.atendidas)], ['Respuesta en plazo', k.fallas?.respuesta_en_sla_pct == null ? '—' : `${fmt(k.fallas.respuesta_en_sla_pct, 0)} %`],
              ['OT cerradas', fmt(k.ot?.cerradas)]].map(([a, b]) => <div key={a as string}><div className="text-xs text-slate-500">{a}</div><div className="text-lg font-bold">{b}</div></div>)}
            <p className="col-span-full text-[11px] text-slate-500">Estos indicadores se adjuntan solos al enviar.</p>
          </div>
        )}
        <label className="block">Trabajos realizados y logros del mes *<textarea disabled={bloqueado} className={field} rows={5} value={form.logros} onChange={e => setForm({ ...form, logros: e.target.value })} placeholder="Fallas atendidas, OT cerradas, apoyo en ruta, preventivos ejecutados…" /></label>
        <label className="block">Problemas o limitaciones<textarea disabled={bloqueado} className={field} rows={3} value={form.problemas} onChange={e => setForm({ ...form, problemas: e.target.value })} placeholder="Repuestos que faltaron, demoras de proveedores, unidades con fallas repetidas…" /></label>
        <label className="block">Acciones y propuestas para el próximo mes<textarea disabled={bloqueado} className={field} rows={3} value={form.acciones} onChange={e => setForm({ ...form, acciones: e.target.value })} /></label>
        {!bloqueado && <button disabled={saving} onClick={enviar} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{actual ? 'Corregir y reenviar' : 'Enviar informe'}</button>}
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Cómo funciona</div>
          <ul className="list-disc space-y-1 pl-4 text-slate-600">
            <li>El día 1 llega un recordatorio a la campana.</li>
            <li>Vence el día 3 del mes siguiente.</li>
            <li>Desde el día 4 se avisa a diario al técnico y al supervisor. Cada día de atraso baja la puntualidad (15 puntos por día).</li>
            <li>El supervisor lo revisa o lo observa. Si lo observa, se corrige y se reenvía sin perder la fecha del primer envío.</li>
          </ul>
        </div>
        <div className="rounded-xl border bg-white p-3 text-sm">
          <div className="mb-1 font-semibold text-slate-800">Mis informes</div>
          {mios.length === 0 ? <p className="text-slate-500">Aún no hay informes.</p> : mios.map(i => (
            <button key={i.id} onClick={() => setPeriodo(i.periodo)} className="flex w-full justify-between border-t py-1.5 text-left first:border-t-0">
              <span className="capitalize">{mesTxt(i.periodo)}</span>
              <span className={`${(INFORME[i.estado] || ['', ''])[1]} text-xs`}>{(INFORME[i.estado] || [i.estado])[0]}{i.dias_atraso ? ` · ${i.dias_atraso} d atraso` : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Equipo({ mes, setMes, onVer }: { mes: string; setMes: (m: string) => void; onVer: (u: { id: string; nombre: string }) => void }) {
  const [d, setD] = useState<Row | null>(null)
  const load = useCallback(() => {
    supabase.rpc('soporte_equipo', { p_mes: mes }).then(({ data, error }) => {
      if (error || !data?.success) { toast.error(error?.message || data?.error); return }
      setD(data)
    })
  }, [mes])
  useEffect(() => { load() }, [load])
  const revisar = async (i: Row, estado: 'REVISADO' | 'OBSERVADO') => {
    const comentario = estado === 'OBSERVADO' ? prompt('¿Qué debe corregir?') : prompt('Comentario (opcional):')
    if (estado === 'OBSERVADO' && !comentario?.trim()) return
    const { data, error } = await supabase.rpc('soporte_revisar_informe', { p_id: i.id, p_estado: estado, p_comentario: comentario || null })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(estado === 'REVISADO' ? 'Informe revisado' : 'Informe observado: se avisó al técnico'); load()
  }
  if (!d) return <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div>
  return (
    <div className="space-y-4">
      <label className="text-sm text-slate-600">Mes <input type="month" className="ml-1 rounded-lg border px-2 py-1.5" value={mes.slice(0, 7)} onChange={e => e.target.value && setMes(`${e.target.value}-01`)} /></label>
      <div className="overflow-x-auto rounded-xl border bg-white">
        {(d.tecnicos || []).length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">No hay usuarios con el rol Soporte Mecánico. Asígnelo en Usuarios (rol «Soporte Mecánico»).</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="p-2 text-left">Técnico</th><th className="p-2 text-right">Índice</th><th className="p-2 text-right">Atendidas</th><th className="p-2 text-right">Respuesta en plazo</th>
              <th className="p-2 text-right">Solución en plazo</th><th className="p-2 text-right">Reincid.</th><th className="p-2 text-right">Backlog</th><th className="p-2 text-left">Informe</th><th className="p-2"></th>
            </tr></thead>
            <tbody className="divide-y">
              {d.tecnicos.map((t: Row) => {
                const [cal, cls] = CALIF[t.calificacion] || CALIF.SIN_DATOS
                const [est, ecls] = INFORME[t.informe?.estado] || ['—', '']
                return (
                  <tr key={t.usuario}>
                    <td className="p-2 font-semibold">{t.nombre}</td>
                    <td className="p-2 text-right"><b>{t.indice ?? '—'}</b> <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{cal}</span></td>
                    <td className="p-2 text-right">{fmt(t.fallas?.atendidas)}</td>
                    <td className="p-2 text-right">{t.fallas?.respuesta_en_sla_pct == null ? '—' : `${fmt(t.fallas.respuesta_en_sla_pct, 0)} %`}</td>
                    <td className="p-2 text-right">{t.fallas?.solucion_en_sla_pct == null ? '—' : `${fmt(t.fallas.solucion_en_sla_pct, 0)} %`}</td>
                    <td className="p-2 text-right">{fmt(t.fallas?.reincidencias)}</td>
                    <td className="p-2 text-right">{fmt(t.backlog?.abiertas)}{t.backlog?.envejecidas ? <span className="text-[#cf152d]"> ({t.backlog.envejecidas})</span> : null}</td>
                    <td className={`p-2 text-xs ${ecls}`}>{est}{t.informe?.dias_atraso ? ` · ${t.informe.dias_atraso} d` : ''}</td>
                    <td className="p-2"><button onClick={() => onVer({ id: t.usuario, nombre: t.nombre })} className="rounded-lg border px-2 py-1 text-xs font-semibold text-[#002855]">Ver detalle</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="rounded-xl border bg-white">
        <div className="border-b px-3 py-2 text-sm font-semibold text-slate-800">Informes mensuales recientes</div>
        {(d.informes || []).length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Sin informes en los últimos meses.</p> : d.informes.map((i: Row) => (
          <div key={i.id} className="space-y-1 border-t p-3 text-sm first:border-t-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><b>{i.nombre}</b> · <span className="capitalize">{mesTxt(i.periodo)}</span> · <span className={(INFORME[i.estado] || ['', ''])[1]}>{(INFORME[i.estado] || [i.estado])[0]}</span>
                <span className="text-xs text-slate-500"> · enviado {fechaHora(i.enviado_at)}{i.dias_atraso ? ` (${i.dias_atraso} d de atraso)` : ' (a tiempo)'} · índice {i.kpis?.indice ?? '—'}</span></div>
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
            {i.comentario && <p className="text-xs text-slate-500"><b>Comentario:</b> {i.comentario}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

function Plazos() {
  const [sla, setSla] = useState<Row[]>([])
  const [par, setPar] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    supabase.from('soporte_sla').select('*').order('respuesta_horas').then(({ data }) => setSla(data || []))
    supabase.from('soporte_parametros').select('*').order('clave').then(({ data }) => setPar(data || []))
  }, [])
  const guardar = async () => {
    setSaving(true)
    const { data, error } = await supabase.rpc('soporte_guardar_sla', { p_sla: sla, p_parametros: Object.fromEntries(par.map(p => [p.clave, Number(p.valor)])) })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Plazos guardados')
  }
  const field = 'w-24 rounded-lg border px-2 py-1 text-right text-sm'
  return (
    <div className="max-w-3xl space-y-4">
      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-2 text-left">Criticidad</th><th className="p-2 text-right">Plazo de respuesta (h)</th><th className="p-2 text-right">Plazo de solución (h)</th></tr></thead>
          <tbody className="divide-y">{sla.map((s, i) => (
            <tr key={s.severidad}>
              <td className="p-2 font-semibold">{s.severidad}</td>
              <td className="p-2 text-right"><input type="number" min={0.25} step="0.25" className={field} value={s.respuesta_horas} onChange={e => setSla(sla.map((x, j) => j === i ? { ...x, respuesta_horas: e.target.value } : x))} /></td>
              <td className="p-2 text-right"><input type="number" min={1} className={field} value={s.solucion_horas} onChange={e => setSla(sla.map((x, j) => j === i ? { ...x, solucion_horas: e.target.value } : x))} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="space-y-2 rounded-xl border bg-white p-3 text-sm">
        {par.map((p, i) => (
          <label key={p.clave} className="flex items-center justify-between gap-3"><span className="text-slate-600">{p.descripcion}</span>
            <input type="number" min={0} className={field} value={p.valor} onChange={e => setPar(par.map((x, j) => j === i ? { ...x, valor: e.target.value } : x))} /></label>
        ))}
      </div>
      <button disabled={saving} onClick={guardar} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Guardar plazos</button>
    </div>
  )
}
