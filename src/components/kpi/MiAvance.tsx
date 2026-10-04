'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CalendarClock, CheckCircle2, ChevronRight, ClipboardList, Gauge, Target, TrendingUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmt } from '@/lib/fleet/api'
import { Calif, Delta, INFORME, MiniBarras, Medidor, ROL_COLOR, Row, TablaKpis, fecha, mesTxt, metaTxt, valorTxt } from './kpiUi'

// «Mi avance»: el tablero personal de cada usuario medido (kpi_mi_avance). Se usa en /desempeno y, compacto, en Inicio.

const supabase = createClient()

function Pendientes({ k, max = 5 }: { k: Row; max?: number }) {
  const pm: Row[] = (k.por_mejorar || []).slice(0, max)
  if (!pm.length) return <p className="text-sm text-emerald-700">{k.indice == null ? 'Aún no hay datos suficientes para medir su avance.' : 'Todos sus indicadores medidos están en 80 puntos o más.'}</p>
  return (
    <ul className="space-y-2">
      {pm.map(x => (
        <li key={x.codigo} className="text-sm">
          <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-800">{x.nombre}</span><span className="whitespace-nowrap text-xs text-slate-500">{valorTxt(x)} · meta {metaTxt(x)}</span></div>
          <div className="mt-1 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-[#cf152d]" style={{ width: `${Math.max(2, Number(x.puntaje))}%` }} /></div>
        </li>
      ))}
    </ul>
  )
}

// El informe que importa es el del mes anterior mientras el actual está en curso
const informeVigente = (k: Row): [Row | null, string] =>
  k.informe?.estado === 'MES_EN_CURSO' && k.anterior?.informe ? [k.anterior.informe, k.anterior.periodo] : [k.informe || null, k.periodo]

function RolAvance({ k, data, onInforme }: { k: Row; data: Row; onInforme?: () => void }) {
  const [inf, infMes] = informeVigente(k)
  const [est, ecls] = inf ? INFORME[inf.estado] || ['—', ''] : ['', '']
  const avanceMes = data.dias_mes ? Math.round((100 * data.dias_transcurridos) / data.dias_mes) : 0
  const color = ROL_COLOR[k.rol] || '#002855'
  return (
    <section className="space-y-3">
      <h2 className="flex flex-wrap items-center gap-x-2 text-lg font-semibold text-slate-800"><span className="h-3 w-3 rounded-full" style={{ background: color }} />{k.rol_nombre}<span className="text-sm font-normal capitalize text-slate-500">· {mesTxt(k.periodo)}</span></h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex flex-col items-center rounded-xl border bg-white p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mi índice</div>
          <Medidor indice={k.indice} calificacion={k.calificacion} />
          <Calif c={k.calificacion} />
          <div className="mt-1"><Delta actual={k.indice} anterior={k.anterior?.indice} /></div>
        </div>
        <div className="space-y-3 rounded-xl border bg-white p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><Target className="h-4 w-4" />Cumplimiento</div>
          <div><div className="text-3xl font-extrabold text-slate-900">{k.kpis_en_meta ?? 0}<span className="text-base font-semibold text-slate-400"> / {k.kpis_total ?? 0}</span></div>
            <div className="text-xs text-slate-500">indicadores en su meta · {k.kpis_medidos ?? 0} con datos</div></div>
          <div>
            <div className="flex justify-between text-xs text-slate-500"><span className="flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" />Avance del mes</span><span>día {data.dias_transcurridos} de {data.dias_mes}</span></div>
            <div className="mt-1 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-[#002855]" style={{ width: `${avanceMes}%` }} /></div>
          </div>
          {k.cobertura != null && <div className="text-xs text-slate-500">{fmt(k.cobertura)} % del peso del índice ya tiene datos</div>}
        </div>
        <div className="rounded-xl border bg-white p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><TrendingUp className="h-4 w-4" />Evolución (6 meses)</div>
          <MiniBarras serie={k.tendencia || []} color={color} />
        </div>
        <div className="space-y-2 rounded-xl border bg-white p-4 text-sm">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><ClipboardList className="h-4 w-4" />Informe mensual</div>
          {inf && <div className="text-xs capitalize text-slate-500">{mesTxt(infMes)}</div>}
          {inf ? <>
            <div className={`font-semibold ${ecls}`}>{est}</div>
            <div className="text-xs text-slate-500">Vence el {fecha(inf.vence)}{inf.dias_atraso ? ` · ${inf.dias_atraso} día(s) de atraso` : ''}</div>
            {k.rol === 'SOPORTE'
              ? <Link href="/reportes?section=desempeno&tab=soporte&supportTab=informe" className="inline-flex items-center gap-1 text-xs font-semibold text-[#002855]">Ir al informe de Soporte <ChevronRight className="h-3.5 w-3.5" /></Link>
              : onInforme && <button onClick={onInforme} className="inline-flex items-center gap-1 text-xs font-semibold text-[#002855]">Presentar o ver el informe <ChevronRight className="h-3.5 w-3.5" /></button>}
            <p className="text-[11px] text-slate-400">Cada día de atraso descuenta 15 puntos de puntualidad.</p>
          </> : <p className="text-slate-500">Este rol no presenta informe: el índice se calcula solo con lo registrado.</p>}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="rounded-xl border bg-white p-4">
          <div className="mb-2 text-sm font-semibold text-slate-800">Qué mejorar este mes</div>
          <Pendientes k={k} />
        </div>
        <TablaKpis k={k} />
      </div>
    </section>
  )
}

export function MiAvance({ data, onInforme }: { data: Row; onInforme?: () => void }) {
  const roles: Row[] = data.roles || []
  if (!roles.length) return (
    <div className="rounded-xl border bg-white p-6 text-sm text-slate-600">
      Su usuario no está en ninguno de los roles medidos (Supervisor de Despacho, Transporte / Jefe de Distribución, Asistente Documentario,
      Soporte Mecánico o Conductores).{data.revisor && <> Como revisor, vea los resultados en la pestaña <b>Tablero</b>.</>}
    </div>
  )
  return <div className="space-y-8">{roles.map(k => <RolAvance key={k.rol} k={k} data={data} onInforme={onInforme} />)}</div>
}

// Tarjeta compacta para Inicio: solo aparece si el usuario está medido
export function MiAvanceWidget() {
  const [data, setData] = useState<Row | null>(null)
  useEffect(() => {
    let alive = true
    supabase.rpc('kpi_mi_avance', { p_mes: null }).then(({ data: d }) => { if (alive && d?.success) setData(d) })
    return () => { alive = false }
  }, [])
  const roles: Row[] = data?.roles || []
  if (!roles.length) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-slate-800"><Gauge className="h-5 w-5 text-[#002855]" />Mi avance del mes</h3>
        <Link href="/reportes?section=desempeno&tab=mio" className="flex items-center gap-1 text-sm font-semibold text-[#002855]">Ver detalle <ChevronRight className="h-4 w-4" /></Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {roles.map(k => {
          const top = (k.por_mejorar || [])[0]
          const [inf] = informeVigente(k)
          return (
            <Link key={k.rol} href="/reportes?section=desempeno&tab=mio" className="flex items-center gap-3 rounded-lg border p-3 hover:bg-slate-50">
              <Medidor indice={k.indice} calificacion={k.calificacion} size={96} />
              <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                <div className="truncate font-semibold text-slate-800">{k.rol_nombre}</div>
                <div className="flex flex-wrap items-center gap-1"><Calif c={k.calificacion} /><Delta actual={k.indice} anterior={k.anterior?.indice} /></div>
                <div className="flex items-center gap-1 text-xs text-slate-500"><CheckCircle2 className="h-3.5 w-3.5" />{k.kpis_en_meta ?? 0} de {k.kpis_total ?? 0} indicadores en meta</div>
                {top && <div className="truncate text-xs text-[#cf152d]">Mejorar: {top.nombre} ({valorTxt(top)})</div>}
                {inf && ['ATRASADO', 'PENDIENTE', 'OBSERVADO'].includes(inf.estado) && <div className={`text-xs font-semibold ${(INFORME[inf.estado] || ['', ''])[1]}`}>Informe: {(INFORME[inf.estado] || [''])[0]}</div>}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
