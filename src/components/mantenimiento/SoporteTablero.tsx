'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, ClipboardList, Clock, Hand, Info, Loader2, RefreshCw, Timer, Truck, Users, Wrench } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { fmt } from '@/lib/fleet/api'
import { MiAvanceWidget } from '@/components/kpi/MiAvance'

// Soporte Mecánico › tablero del equipo (soporte_tablero, migración 20261006150000): atención de fallas con o sin técnico
// asignado, tiempos contra el SLA por criticidad, backlog, evolución, resultado por técnico y fallas abiertas para tomar.

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic']
const hoyLima = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }))
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const horas = (h: unknown) => (h == null ? '—' : Number(h) < 1 ? `${Math.round(Number(h) * 60)} min` : Number(h) < 48 ? `${fmt(Number(h), 1)} h` : `${fmt(Number(h) / 24, 1)} d`)
const pctTxt = (v: unknown) => (v == null ? '—' : `${fmt(Number(v))} %`)
const SEV: Record<string, string> = { CRITICA: 'bg-red-100 text-red-800', ALTA: 'bg-orange-100 text-orange-800', MEDIA: 'bg-amber-50 text-amber-800', BAJA: 'bg-slate-100 text-slate-600' }
const SEV_TXT: Record<string, string> = { CRITICA: 'Crítica', ALTA: 'Alta', MEDIA: 'Media', BAJA: 'Baja' }

type Periodo = 'mes' | '3m' | '12m' | 'anio'
const rango = (p: Periodo): [string, string] => {
  const h = hoyLima()
  const d = p === 'mes' ? new Date(h.getFullYear(), h.getMonth(), 1)
    : p === '3m' ? new Date(h.getFullYear(), h.getMonth() - 2, 1)
    : p === '12m' ? new Date(h.getFullYear(), h.getMonth() - 11, 1)
    : new Date(h.getFullYear(), 0, 1)
  return [iso(d), iso(h)]
}

function Tile({ icon: Icon, label, value, sub, tono = 'text-slate-900' }: { icon: typeof Timer; label: string; value: React.ReactNode; sub?: React.ReactNode; tono?: string }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Icon className="h-4 w-4" />{label}</div>
      <div className={`mt-1 text-3xl font-extrabold ${tono}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

function Barra({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-xs text-slate-400">—</span>
  const n = Number(v)
  return (
    <div className="flex items-center gap-2"><div className="h-1.5 w-24 rounded bg-slate-100"><div className={`h-1.5 rounded ${n >= 90 ? 'bg-emerald-500' : n >= 70 ? 'bg-amber-500' : 'bg-[#cf152d]'}`} style={{ width: `${Math.min(100, n)}%` }} /></div><span className="whitespace-nowrap text-xs font-semibold">{fmt(n)} %</span></div>
  )
}

export default function SoporteTablero() {
  const { canWrite, isLoaded } = usePermissions()
  const puedeTomar = isLoaded && (canWrite('mantenimiento-soporte') || canWrite('mantenimiento-fallas'))
  const [periodo, setPeriodo] = useState<Periodo>('3m')
  const [desde, hasta] = useMemo(() => rango(periodo), [periodo])
  const [res, setRes] = useState<{ key: string; data: Row | null; error?: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const key = `${desde}|${hasta}|${nonce}`
  useEffect(() => {
    let alive = true
    supabase.rpc('soporte_tablero', { p_desde: desde, p_hasta: hasta }).then(({ data, error }) => {
      if (!alive) return
      setRes({ key, data: data?.success ? data : null, error: error?.message || (data && !data.success ? data.error : undefined) })
    })
    return () => { alive = false }
  }, [key, desde, hasta])
  const tomar = useCallback(async (f: Row) => {
    const nota = prompt(`Tomar la falla de ${f.placa}. Nota (opcional):`)
    if (nota === null) return
    setBusy(f.id)
    const { data, error } = await supabase.rpc('soporte_tomar_falla', { p_request_id: f.id, p_usuario: null, p_nota: nota || null })
    setBusy(null)
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo tomar la falla')
    toast.success(`${f.placa}: la atiende ${data.asignado ?? 'usted'}`)
    setNonce(n => n + 1)
  }, [])

  const d = res?.data
  const k = d?.kpis || {}
  const cargando = res?.key !== key
  const serie = (d?.por_mes || []).map((m: Row) => ({ mes: `${MESES[Number(m.mes.slice(5, 7)) - 1]} ${m.mes.slice(2, 4)}`, Recibidas: m.recibidas, Cerradas: m.cerradas }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-[#002855]"><Timer className="h-6 w-6" />Soporte Mecánico</h1>
          <p className="text-sm text-slate-500">Atención de fallas e incidencias del equipo: capacidad de respuesta frente a los plazos, backlog y fallas por atender.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {([['mes', 'Este mes'], ['3m', 'Últimos 3 meses'], ['12m', 'Últimos 12 meses'], ['anio', 'Este año']] as Array<[Periodo, string]>).map(([p, l]) => (
            <button key={p} onClick={() => setPeriodo(p)} className={`rounded-full border px-3 py-1 ${periodo === p ? 'border-[#002855] bg-[#002855] text-white' : 'bg-white text-slate-600'}`}>{l}</button>
          ))}
          <button onClick={() => setNonce(n => n + 1)} title="Actualizar" className="rounded-lg border bg-white p-1.5 text-slate-600"><RefreshCw className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm font-semibold text-[#002855]">
        <Link href="/mantenimiento/fallas" className="inline-flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5"><Wrench className="h-4 w-4" />Atender fallas</Link>
        <Link href="/reportes?section=desempeno&tab=soporte" className="inline-flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5"><ClipboardList className="h-4 w-4" />Informe mensual, desempeño por técnico y plazos</Link>
      </div>

      <MiAvanceWidget />

      {!res ? <div className="flex justify-center p-16"><Loader2 className="h-7 w-7 animate-spin text-[#002855]" /></div>
        : !d ? <div className="rounded-xl border bg-white p-6 text-sm text-slate-600">{res.error || 'No se pudo cargar el tablero de Soporte Mecánico.'}</div>
        : <>
          {(d.diagnostico || []).length > 0 && (
            <div className="space-y-1.5">
              {d.diagnostico.map((x: Row, i: number) => (
                <div key={i} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${x.nivel === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>
                  {x.nivel === 'warn' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}<span>{x.texto}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Tile icon={Truck} label="Fallas recibidas" value={k.recibidas ?? 0} sub={`${k.criticas ?? 0} críticas · ${k.descartadas ?? 0} descartadas`} />
            <Tile icon={Hand} label="Sin atender" value={k.sin_atender ?? 0} tono={k.sin_atender_fuera_sla ? 'text-[#cf152d]' : 'text-slate-900'} sub={`${k.sin_atender_fuera_sla ?? 0} fuera del plazo de respuesta`} />
            <Tile icon={Clock} label="Respuesta (mediana)" value={horas(k.respuesta_mediana_h)} sub={<>{pctTxt(k.respuesta_en_sla_pct)} dentro del plazo{k.estimadas ? ` · ${k.estimadas} estimada(s)` : ''}</>} />
            <Tile icon={Wrench} label="Solución (mediana)" value={horas(k.solucion_mediana_h)} sub={`${pctTxt(k.solucion_en_sla_pct)} dentro del plazo · ${k.cerradas ?? 0} cerradas`} />
            <Tile icon={ClipboardList} label="Backlog abierto" value={k.abiertas ?? 0} tono={k.envejecidas ? 'text-amber-700' : 'text-slate-900'} sub={`${k.envejecidas ?? 0} con más de ${k.envejecida_dias ?? 7} días`} />
            <Tile icon={Users} label="Técnicos con rol" value={d.tecnicos_con_rol ?? 0} tono={d.tecnicos_con_rol ? 'text-slate-900' : 'text-amber-700'} sub={`${k.sin_tecnico ?? 0} falla(s) abiertas sin técnico`} />
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <section className="rounded-xl border bg-white p-4">
              <h2 className="mb-2 text-sm font-bold text-slate-800">Respuesta por criticidad (plazos SLA)</h2>
              <div className="overflow-x-auto">
                <DataTable className="w-full text-sm">
                  <thead className="text-[11px] uppercase text-slate-500"><tr><th className="p-2 text-left">Criticidad</th><th className="p-2 text-right">Plazo respuesta / solución</th><th className="p-2 text-right">Recibidas</th><th className="p-2 text-right">Respuesta mediana</th><th className="p-2 text-left">Dentro del plazo</th><th className="p-2 text-right">Abiertas</th></tr></thead>
                  <tbody className="divide-y">
                    {(d.por_criticidad || []).map((c: Row) => (
                      <tr key={c.criticidad}>
                        <td className="p-2"><span className={`rounded px-2 py-0.5 text-xs font-bold ${SEV[c.criticidad] || ''}`}>{SEV_TXT[c.criticidad] || c.criticidad}</span></td>
                        <td className="p-2 text-right text-slate-500">{horas(c.sla_respuesta_h)} / {horas(c.sla_solucion_h)}</td>
                        <td className="p-2 text-right font-semibold">{c.recibidas ?? 0}</td>
                        <td className="p-2 text-right">{horas(c.respuesta_mediana_h)}</td>
                        <td className="p-2"><Barra v={c.respuesta_en_sla_pct} /></td>
                        <td className="p-2 text-right">{c.abiertas ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </div>
            </section>
            <section className="rounded-xl border bg-white p-4">
              <h2 className="mb-2 text-sm font-bold text-slate-800">Fallas recibidas y cerradas (6 meses)</h2>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={serie} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} barGap={2}>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="mes" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Legend iconType="circle" iconSize={8} itemSorter={item => (item.dataKey === 'Recibidas' ? 0 : 1)} formatter={v => <span className="text-xs text-slate-600">{v}</span>} />
                    <Bar dataKey="Recibidas" fill="#2a78d6" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    <Bar dataKey="Cerradas" fill="#1baf7a" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          <section className="rounded-xl border bg-white">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-sm font-bold text-slate-800">Fallas abiertas ({(d.abiertas || []).length})</h2>
              <span className="text-xs text-slate-500">Primero las críticas y las más antiguas</span>
            </div>
            {(d.abiertas || []).length === 0 ? <p className="p-6 text-center text-sm text-emerald-700">No hay fallas abiertas.</p> : (
              <div className="overflow-x-auto">
                <DataTable className="w-full min-w-[900px] text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500"><tr>
                    <th className="p-2 text-left">Unidad</th><th className="p-2 text-left">Criticidad</th><th className="p-2 text-left">Falla</th><th className="p-2 text-left">Reportó</th>
                    <th className="p-2 text-right">Abierta hace</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Técnico</th><th className="p-2" />
                  </tr></thead>
                  <tbody className="divide-y">
                    {d.abiertas.map((f: Row) => (
                      <tr key={f.id} className={f.fuera_sla ? 'bg-red-50/50' : ''}>
                        <td className="p-2 font-bold text-[#002855]">{f.placa}</td>
                        <td className="p-2"><span className={`rounded px-2 py-0.5 text-xs font-bold ${SEV[f.criticidad] || ''}`}>{SEV_TXT[f.criticidad] || f.criticidad}</span></td>
                        <td className="max-w-[320px] p-2 text-xs text-slate-700">{f.descripcion}</td>
                        <td className="p-2 text-xs text-slate-500">{f.reporto}</td>
                        <td className="whitespace-nowrap p-2 text-right">{horas(f.horas_abierta)}{f.fuera_sla && <div className="text-[10px] font-bold text-[#cf152d]">fuera de plazo ({horas(f.sla_respuesta_h)})</div>}</td>
                        <td className="p-2 text-xs">{f.estado}</td>
                        <td className="p-2 text-xs">{f.tecnico || <span className="text-amber-700">Sin técnico</span>}</td>
                        <td className="p-2 text-right">
                          {puedeTomar && !f.atendida_at && (
                            <button disabled={busy === f.id} onClick={() => tomar(f)} className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-2.5 py-1 text-xs font-semibold text-white">
                              {busy === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />}Tomar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </div>
            )}
          </section>

          <div className="grid gap-3 xl:grid-cols-2">
            <section className="rounded-xl border bg-white p-4">
              <h2 className="mb-2 text-sm font-bold text-slate-800">Por técnico</h2>
              {(d.por_tecnico || []).length === 0 ? <p className="text-sm text-slate-500">Sin fallas en el periodo.</p> : (
                <DataTable className="w-full text-sm">
                  <thead className="text-[11px] uppercase text-slate-500"><tr><th className="p-2 text-left">Técnico</th><th className="p-2 text-right">Fallas</th><th className="p-2 text-right">Respuesta mediana</th><th className="p-2 text-left">Dentro del plazo</th><th className="p-2 text-right">Cerradas</th><th className="p-2 text-right">Abiertas</th></tr></thead>
                  <tbody className="divide-y">
                    {d.por_tecnico.map((t: Row) => (
                      <tr key={t.user_id || 'sin'}>
                        <td className={`p-2 font-semibold ${t.user_id ? '' : 'text-amber-700'}`}>{t.nombre}</td>
                        <td className="p-2 text-right">{t.fallas}</td><td className="p-2 text-right">{horas(t.respuesta_mediana_h)}</td>
                        <td className="p-2"><Barra v={t.respuesta_en_sla_pct} /></td><td className="p-2 text-right">{t.cerradas}</td><td className="p-2 text-right">{t.abiertas}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              )}
            </section>
            <section className="rounded-xl border bg-white p-4">
              <h2 className="mb-2 text-sm font-bold text-slate-800">Unidades con más fallas</h2>
              {(d.por_unidad || []).length === 0 ? <p className="text-sm text-slate-500">Sin fallas en el periodo.</p> : (
                <ul className="space-y-1.5">
                  {d.por_unidad.map((u: Row) => {
                    const max = Math.max(...d.por_unidad.map((x: Row) => x.fallas), 1)
                    return (
                      <li key={u.placa} className="grid grid-cols-[140px_1fr_auto] items-center gap-2 text-sm">
                        <span className="truncate font-semibold text-slate-800">{u.placa}</span>
                        <div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-[#2a78d6]" style={{ width: `${(u.fallas / max) * 100}%` }} /></div>
                        <span className="text-xs text-slate-600">{u.fallas}{u.criticas ? ` · ${u.criticas} crít.` : ''}{u.abiertas ? ` · ${u.abiertas} abiertas` : ''}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
          <p className="text-xs text-slate-500">
            Respuesta: del reporte a la primera atención («Tomar» en Fallas o el primer cambio de estado). Sin ese registro se estima con la primera orden de trabajo de
            la unidad dentro de 15 días. Periodo: {desde.split('-').reverse().join('/')} al {hasta.split('-').reverse().join('/')}.
          </p>
        </>}
    </div>
  )
}
