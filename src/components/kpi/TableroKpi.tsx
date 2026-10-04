'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Check, ClipboardList, FileWarning, Gauge, Info, ShieldAlert, Users, X } from 'lucide-react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { createClient } from '@/lib/supabase/client'
import { fmt } from '@/lib/fleet/api'
import { CALIF, CALIF_BAR, Calif, INFORME, MiniBarras, ROLES, ROL_COLOR, ROL_CORTO, Row, mesCorto, mesTxt, valorTxt } from './kpiUi'

// Tablero de KPI (kpi_tablero): Jefe de Distribución y Administrador. Tablero, Equipo e Informes usan la misma respuesta.

const supabase = createClient()
const ORDEN_ROL = ROLES.map(x => x[0])
const ORDEN_CALIF = ['EXCELENTE', 'BUENO', 'REGULAR', 'BAJO', 'SIN_DATOS']

export async function exportarTablero(t: Row) {
  const { exportAptXlsx } = await import('@/lib/apt/export')
  const resumen: Row[] = (t.roles || []).map((r: Row) => ({
    Rol: r.nombre, Personas: r.n, 'Con índice': r.con_indice, 'Índice promedio': r.promedio ?? '', Mínimo: r.minimo ?? '', Máximo: r.maximo ?? '',
    Excelente: r.dist?.EXCELENTE, Bueno: r.dist?.BUENO, Regular: r.dist?.REGULAR, Bajo: r.dist?.BAJO, 'Sin datos': r.dist?.SIN_DATOS,
    'Informes atrasados': r.informes?.atrasados, 'Informes por revisar': r.informes?.por_revisar,
  }))
  const personas: Row[] = []
  const detalle: Row[] = []
  for (const r of t.roles || []) for (const m of r.miembros || []) {
    personas.push({ Rol: r.nombre, Nombre: m.nombre, 'Índice': m.indice ?? '', 'Calificación': (CALIF[m.calificacion] || CALIF.SIN_DATOS)[0], '% medido': m.cobertura ?? '',
      Informe: m.informe ? (INFORME[m.informe.estado] || [m.informe.estado])[0] : 'No aplica', 'Días de atraso': m.informe?.dias_atraso ?? '',
      'Por mejorar': (m.por_mejorar || []).map((x: Row) => `${x.nombre} (${valorTxt(x)})`).join('; ') })
    for (const k of m.kpis || []) detalle.push({ Rol: r.nombre, Nombre: m.nombre, Grupo: k.grupo, Indicador: k.nombre, Resultado: k.valor ?? '', Unidad: k.unidad,
      Meta: k.peso > 0 ? k.meta : 'informativo', Sentido: k.sentido === 'MAYOR' ? 'mayor es mejor' : 'menor es mejor', Peso: k.peso, Puntaje: k.puntaje ?? '' })
  }
  const evolucion: Row[] = []
  const periodos: string[] = (t.roles?.[0]?.tendencia || []).map((p: Row) => p.periodo)
  for (const p of periodos) {
    const fila: Row = { Mes: mesTxt(p) }
    for (const r of t.roles || []) fila[r.nombre] = (r.tendencia || []).find((x: Row) => x.periodo === p)?.indice ?? ''
    evolucion.push(fila)
  }
  exportAptXlsx(`KPI ${mesTxt(t.periodo)}`, { Resumen: resumen, Personas: personas, Indicadores: detalle, 'Evolución': evolucion })
}

function Tile({ label, value, sub, icon: Icon, tono = 'text-slate-900' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: typeof Gauge; tono?: string }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Icon className="h-4 w-4" />{label}</div>
      <div className={`mt-1 text-3xl font-extrabold ${tono}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

function Distribucion({ dist, n }: { dist: Row; n: number }) {
  if (!n) return <div className="h-2.5 rounded bg-slate-100" />
  return (
    <div className="flex h-2.5 gap-[2px] overflow-hidden rounded">
      {ORDEN_CALIF.filter(c => dist?.[c] > 0).map(c => <div key={c} title={`${CALIF[c][0]}: ${dist[c]}`} style={{ flex: dist[c], background: CALIF_BAR[c] }} />)}
    </div>
  )
}

export function Tablero({ t, onRol }: { t: Row; onRol: (rol: string) => void }) {
  const g = t.general || {}
  const roles = useMemo<Row[]>(() => t.roles || [], [t])
  const serie = useMemo(() => {
    const periodos: string[] = (roles[0]?.tendencia || []).map((p: Row) => p.periodo)
    return periodos.map(p => {
      const fila: Row = { periodo: p, mes: mesCorto(p) }
      for (const r of roles) fila[r.rol] = (r.tendencia || []).find((x: Row) => x.periodo === p)?.indice ?? null
      return fila
    })
  }, [roles])
  const alertas: Row[] = t.alertas || []
  const ICON: Record<string, typeof Info> = { SINIESTRO: ShieldAlert, BAJO: AlertTriangle, INFORME: FileWarning, ERROR: Info }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Tile icon={Gauge} label="Índice general" value={g.indice ?? '—'} sub={<span className="inline-flex items-center gap-1"><Calif c={g.calificacion} /> promedio de los roles</span>} />
        <Tile icon={Users} label="Personas medidas" value={<>{g.con_indice ?? 0}<span className="text-base font-semibold text-slate-400"> / {g.miembros ?? 0}</span></>} sub="con índice / registradas" />
        <Tile icon={AlertTriangle} label="Índice bajo" value={g.bajos ?? 0} tono={g.bajos ? 'text-[#cf152d]' : 'text-slate-900'} sub="menos de 60 puntos" />
        <Tile icon={ClipboardList} label="Informes por revisar" value={g.informes_por_revisar ?? 0} tono={g.informes_por_revisar ? 'text-sky-700' : 'text-slate-900'} sub="enviados, sin su revisión" />
        <Tile icon={FileWarning} label="Informes atrasados" value={g.informes_atrasados ?? 0} tono={g.informes_atrasados ? 'text-amber-700' : 'text-slate-900'} sub={`de ${mesTxt(t.periodo)}`} />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {roles.map(r => (
          <button key={r.rol} onClick={() => onRol(r.rol)} className="flex flex-col justify-start gap-2 rounded-xl border bg-white p-4 text-left hover:border-[#002855]/40 hover:shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: ROL_COLOR[r.rol] }} />{ROL_CORTO[r.rol] || r.nombre}</div>
            <div className="flex items-end justify-between">
              <div className="text-4xl font-extrabold text-slate-900">{r.promedio ?? '—'}</div>
              <div className="text-right text-xs text-slate-500">{r.con_indice}/{r.n} con índice{r.minimo != null && <div>mín {fmt(r.minimo)} · máx {fmt(r.maximo)}</div>}</div>
            </div>
            <Distribucion dist={r.dist} n={r.n} />
            <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-500">
              {ORDEN_CALIF.filter(c => r.dist?.[c] > 0).map(c => <span key={c} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: CALIF_BAR[c] }} />{CALIF[c][0].split(' ')[0]} {r.dist[c]}</span>)}
            </div>
            <MiniBarras serie={r.tendencia || []} color={ROL_COLOR[r.rol]} alto={36} />
            {r.informe && <div className="text-[11px] text-slate-500">Informes: {r.informes?.revisados ?? 0} revisados · <span className={r.informes?.por_revisar ? 'font-semibold text-sky-700' : ''}>{r.informes?.por_revisar ?? 0} por revisar</span> · <span className={r.informes?.atrasados ? 'font-semibold text-amber-700' : ''}>{r.informes?.atrasados ?? 0} atrasados</span></div>}
          </button>
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="rounded-xl border bg-white p-4">
          <div className="mb-1 text-sm font-semibold text-slate-800">Evolución del índice promedio por rol</div>
          <p className="mb-2 text-xs text-slate-500">Últimos 6 meses. Un punto sin línea es un mes sin datos suficientes.</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={serie} margin={{ top: 8, right: 16, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="mes" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v, name) => [v ?? 'sin datos', ROL_CORTO[String(name)] || String(name)]} labelFormatter={(l, p) => mesTxt(p?.[0]?.payload?.periodo) || String(l)} />
                <Legend formatter={v => <span className="text-xs text-slate-600">{ROL_CORTO[String(v)] || String(v)}</span>} iconType="circle" iconSize={8}
                  itemSorter={item => ORDEN_ROL.indexOf(String(item.dataKey))} />
                {roles.map(r => <Line key={r.rol} type="monotone" dataKey={r.rol} stroke={ROL_COLOR[r.rol]} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: '#fff', fill: ROL_COLOR[r.rol] }} activeDot={{ r: 6, fill: ROL_COLOR[r.rol] }} connectNulls={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-xl border bg-white">
          <div className="border-b px-4 py-2.5 text-sm font-semibold text-slate-800">Requieren atención ({alertas.length})</div>
          {alertas.length === 0 ? <p className="p-6 text-center text-sm text-emerald-700">Sin alertas en {mesTxt(t.periodo)}.</p> : (
            <ul className="max-h-72 divide-y overflow-y-auto">
              {alertas.map((a, i) => {
                const Icon = ICON[a.tipo] || Info
                const tono = a.nivel === 'crit' ? 'text-[#cf152d]' : a.nivel === 'warn' ? 'text-amber-700' : 'text-slate-500'
                return (
                  <li key={i} className="flex gap-2 px-4 py-2 text-sm">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tono}`} />
                    <div className="min-w-0"><div><b>{a.nombre}</b> <span className="text-xs text-slate-500">· {ROL_CORTO[a.rol] || a.rol_nombre}</span></div><div className={`text-xs ${tono}`}>{a.texto}</div></div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Índice 0–100 por persona: cada indicador recibe puntos según su meta y se pondera por su peso (pestaña Metas y pesos). Calificación: Excelente ≥ 90 ·
        Bueno ≥ 75 · Regular ≥ 60 · Bajo &lt; 60. El índice general es el promedio de los roles con datos. La foto de cada mes se guarda el día 1 y se actualiza hasta el día 10.
      </p>
    </div>
  )
}

export function Equipo({ t, rol, setRol, onVer }: { t: Row; rol: string; setRol: (r: string) => void; onVer: (k: Row) => void }) {
  const r: Row | undefined = (t.roles || []).find((x: Row) => x.rol === rol)
  const miembros: Row[] = r?.miembros || []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {ROLES.map(([k, l]) => (
          <button key={k} onClick={() => setRol(k)} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${rol === k ? 'border-[#002855] bg-[#002855] text-white' : 'bg-white text-slate-600'}`}>
            <span className="h-2 w-2 rounded-full" style={{ background: ROL_COLOR[k] }} />{l}
          </button>
        ))}
      </div>
      <div className="text-sm text-slate-600">{miembros.length} integrante(s){r?.promedio != null ? ` · índice promedio ${fmt(r.promedio)}` : ''}</div>
      <div className="overflow-x-auto rounded-xl border bg-white">
        {miembros.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Nadie registrado en este rol. Se mide a quien tiene el rol o el permiso correspondiente en Usuarios (conductores: maestro de conductores; Soporte: permiso «mantenimiento-soporte»).</p> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="p-2 text-left">#</th><th className="p-2 text-left">Nombre</th><th className="p-2 text-right">Índice</th><th className="w-32 p-2"></th><th className="p-2 text-left">Por mejorar</th>{r?.informe && <th className="p-2 text-left">Informe</th>}<th className="p-2"></th>
            </tr></thead>
            <tbody className="divide-y">
              {[...miembros].sort((a, b) => (b.indice ?? -1) - (a.indice ?? -1)).map((m, i) => {
                const [est, ecls] = m.informe ? INFORME[m.informe.estado] || ['—', ''] : ['', '']
                return (
                  <tr key={m.sujeto || m.user_id}>
                    <td className="p-2 text-slate-400">{m.indice != null ? i + 1 : ''}</td>
                    <td className="p-2 font-semibold">{m.nombre}</td>
                    <td className="whitespace-nowrap p-2 text-right"><b>{m.indice ?? '—'}</b> <Calif c={m.calificacion} className="ml-1 text-[10px]" /></td>
                    <td className="p-2">{m.indice != null && <div className="h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded" style={{ width: `${m.indice}%`, background: CALIF_BAR[m.calificacion] || '#94a3b8' }} /></div>}</td>
                    <td className="p-2 text-xs text-slate-600">{(m.por_mejorar || []).length ? m.por_mejorar.map((x: Row) => `${x.nombre} (${valorTxt(x)})`).join(' · ') : '—'}</td>
                    {r?.informe && <td className={`p-2 text-xs ${ecls}`}>{est}{m.informe?.dias_atraso ? ` · ${m.informe.dias_atraso} d` : ''}</td>}
                    <td className="p-2"><button onClick={() => onVer(m)} className="rounded-lg border px-2 py-1 text-xs font-semibold text-[#002855]">Ver detalle</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export function Informes({ t, onCambio }: { t: Row; onCambio: () => void }) {
  const [filtro, setFiltro] = useState<'pendientes' | 'todos'>('pendientes')
  const todos: Row[] = t.informes || []
  const lista = filtro === 'pendientes' ? todos.filter(i => i.estado === 'ENVIADO') : todos
  const revisar = async (i: Row, estado: 'REVISADO' | 'OBSERVADO') => {
    const comentario = estado === 'OBSERVADO' ? prompt('¿Qué debe corregir?') : prompt('Comentario (opcional):')
    if (estado === 'OBSERVADO' && !comentario?.trim()) return
    const fn = i.origen === 'SOPORTE' ? 'soporte_revisar_informe' : 'desempeno_revisar_informe'
    const { data, error } = await supabase.rpc(fn, { p_id: i.id, p_estado: estado, p_comentario: comentario || null })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(estado === 'REVISADO' ? 'Informe revisado' : 'Informe observado'); onCambio()
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        {([['pendientes', `Por revisar (${todos.filter(i => i.estado === 'ENVIADO').length})`], ['todos', 'Últimos 3 meses']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFiltro(k)} className={`rounded-full border px-3 py-1 text-sm ${filtro === k ? 'border-[#002855] bg-[#002855] text-white' : 'bg-white text-slate-600'}`}>{l}</button>
        ))}
      </div>
      <div className="rounded-xl border bg-white">
        {lista.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">{filtro === 'pendientes' ? 'No hay informes por revisar.' : 'Sin informes en los últimos 3 meses.'}</p> : lista.map(i => (
          <div key={`${i.origen}-${i.id}`} className="space-y-1 border-t p-3 text-sm first:border-t-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROL_COLOR[i.rol] }} /><b>{i.nombre}</b>
                <span className="text-xs text-slate-500">{ROL_CORTO[i.rol] || i.rol_nombre} · <span className="capitalize">{mesTxt(i.periodo)}</span></span>
                <span className={`text-xs ${(INFORME[i.estado] || ['', ''])[1]}`}>{(INFORME[i.estado] || [i.estado])[0]}</span>
                <span className="text-xs text-slate-500">· {i.dias_atraso ? `${i.dias_atraso} d de atraso` : 'a tiempo'} · índice {i.indice ?? '—'}</span>
              </div>
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
            {i.comentario && <p className="text-xs text-slate-500"><b>Comentario del revisor:</b> {i.comentario}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
