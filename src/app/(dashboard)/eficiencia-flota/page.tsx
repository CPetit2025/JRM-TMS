'use client'

import { Suspense, useMemo } from 'react'
import Link from 'next/link'
import { CircleDollarSign, Fuel, Gauge, Route, Scale, Wrench } from 'lucide-react'
import { fleetApi, fmt, mes, soles } from '@/lib/fleet/api'
import { CLASE_LABEL, REC_ORDER, type FeEquipo, type FeRec, type FeResumen, type FeTransporte } from '@/lib/fleet/types'
import { KpiCard, LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { Panel, RecPill, useFeFilters, useFeQuery } from '@/components/fleet/ui'

// Resumen: indicadores del periodo, conclusiones y decisión por activo (reemplazar, dar de baja, vigilar, mantener)

type Fila = { code: string; nombre: string; grupo: string; rec: FeRec; score: number; edad: number | null; indicador: string; motivos: string[]; href: string }

function filas(d: FeResumen): Fila[] {
  const t: Fila[] = d.transporte.map((u: FeTransporte) => ({
    code: u.code, nombre: [u.tipo, u.marca].filter(Boolean).join(' · ') || 'Transporte', grupo: 'Transporte', rec: u.rec, score: u.score, edad: u.edad,
    indicador: u.costo_tkm != null && (u.kg_viaje ?? 0) >= 1000 ? `S/ ${fmt(u.costo_tkm, 3)} por t·km`
      : u.costo_km != null ? `S/ ${fmt(u.costo_km, 2)} por km` : '—',
    motivos: u.motivos, href: `/eficiencia-flota/transporte#u-${encodeURIComponent(u.code)}`,
  }))
  const e: Fila[] = d.equipos.map((x: FeEquipo) => ({
    code: x.code, nombre: CLASE_LABEL[x.clase], grupo: CLASE_LABEL[x.clase], rec: x.rec, score: x.score, edad: x.edad,
    indicador: x.costo_hora != null ? `S/ ${fmt(x.costo_hora, 1)} por hora · ${fmt(x.horas_anio)} h/año` : x.costo_anual != null ? `${soles(x.costo_anual)} al año` : '—',
    motivos: x.motivos, href: '/eficiencia-flota/equipos',
  }))
  return [...t, ...e].sort((a, b) => REC_ORDER.indexOf(a.rec) - REC_ORDER.indexOf(b.rec) || b.score - a.score || (b.edad ?? 0) - (a.edad ?? 0))
}

function Conclusiones({ d }: { d: FeResumen }) {
  const items: string[] = []
  const baja = [...d.transporte, ...d.equipos].filter(x => x.rec === 'Reemplazar' || x.rec === 'Dar de baja o alquilar')
  if (baja.length) items.push(`<b>${baja.length} activo${baja.length > 1 ? 's' : ''} para reemplazar o dar de baja:</b> ${baja.map(x => `${x.code} (${x.rec.toLowerCase()})`).join(', ')}.`)
  const conTon = d.transporte.filter(u => (u.ton ?? 0) > 0 && u.costo_tkm != null)
  const totTon = conTon.reduce((s, u) => s + (u.ton ?? 0), 0)
  const top = conTon.slice().sort((a, b) => (b.ton ?? 0) - (a.ton ?? 0))[0]
  if (top && totTon > 0) items.push(`<b>${top.code}</b> mueve el ${fmt((top.ton ?? 0) / totTon * 100)} % de las toneladas medidas, a S/ ${fmt(top.costo_tkm, 3)} por t·km${d.medianas.costo_tkm ? ` (mediana de la flota: S/ ${fmt(d.medianas.costo_tkm, 3)})` : ''}.`)
  const anios = Object.keys(d.precio_anio).map(Number).sort()
  if (anios.length >= 2) {
    const a = anios[anios.length - 1], b = anios[anios.length - 2]
    const pa = d.precio_anio[a], pb = d.precio_anio[b]
    if (pa && pb) items.push(`El precio promedio del galón pasó de S/ ${fmt(pb, 2)} en ${b} a S/ ${fmt(pa, 2)} en ${a} (${pa >= pb ? '+' : ''}${fmt((pa / pb - 1) * 100)} %).`)
  }
  const cons = d.transporte.filter(u => u.rec === 'Consolidar carga' || u.motivos.some(m => m.startsWith('Viaja con')))
  if (cons.length) items.push(`<b>Capacidad ociosa:</b> ${cons.map(u => `${u.code} (${fmt((u.m3 ?? 0) * 100)} % de volumen)`).join(', ')} viajan con poca carga; consolidar despachos baja el costo por tonelada.`)
  const poco = d.equipos.filter(e => e.horas_anio != null && e.horas_anio < d.params.horas_min_anio)
  if (poco.length) items.push(`<b>Equipos con poco uso</b> (menos de ${fmt(d.params.horas_min_anio)} h al año): ${poco.map(e => `${e.code} (${fmt(e.horas_anio)} h)`).join(', ')}.`)
  const sinHoras = d.equipos.filter(e => (e.lecturas ?? 0) < 3)
  if (sinHoras.length) items.push(`${sinHoras.length} equipo${sinHoras.length > 1 ? 's tienen' : ' tiene'} menos de 3 lecturas de horómetro en el periodo: registre una lectura al mes en <i>Datos y parámetros</i>.`)
  if (!items.length) return null
  return (
    <Panel title="Conclusiones del periodo">
      <ol className="space-y-2 text-sm text-slate-700">
        {items.map((t, i) => (
          <li key={i} className="flex gap-3"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#002855] font-mono text-[10px] font-bold text-white">{i + 1}</span>
            <span dangerouslySetInnerHTML={{ __html: t }} /></li>
        ))}
      </ol>
    </Panel>
  )
}

function Resumen() {
  const f = useFeFilters()
  const { data: d, error, loading, reload } = useFeQuery(fleetApi.resumen, f)
  const rows = useMemo(() => (d ? filas(d) : []), [d])
  if (!d && loading) return <LoadingBlock label="Calculando eficiencia de la flota…" className="h-80" />
  if (error && !d) return <ErrorBlock message={error} onRetry={reload} />
  if (!d) return null
  if (!d.transporte.length && !d.equipos.length) {
    return <EmptyState title="Aún no hay datos para analizar">Cargue el Excel histórico en <Link href="/eficiencia-flota/datos" className="font-bold text-[#002855] underline">Datos y parámetros</Link> o registre combustible, órdenes de trabajo y despachos en el TMS.</EmptyState>
  }
  const k = d.kpis
  const anios = Object.keys(d.precio_anio).map(Number).sort()
  const pUlt = anios.length ? d.precio_anio[anios[anios.length - 1]] : null
  return (
    <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded-lg bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">Periodo {mes(d.desde)} → {mes(d.hasta)} · {d.meses} meses</span>
        <span className="rounded-lg bg-slate-100 px-2.5 py-1">Excel hasta: mantenimiento {mes(addMonth(d.corte.mantenimiento, -1))}, combustible {mes(addMonth(d.corte.combustible, -1))}, rutas {mes(addMonth(d.corte.rutas, -1))} · luego TMS</span>
        {d.cobertura.ultima_carga && <span className="rounded-lg bg-slate-100 px-2.5 py-1">Última carga: {new Date(d.cobertura.ultima_carga.fecha).toLocaleDateString('es-PE')}</span>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Mantenimiento" value={soles(k.mant)} hint={`Transporte ${soles(k.mant_transporte)} · equipos ${soles(k.mant_equipos)}`} icon={<Wrench className="h-4 w-4" />} />
        <KpiCard label="Combustible" value={soles(k.comb)} hint={`${fmt(k.gal)} galones`} icon={<Fuel className="h-4 w-4" />} />
        <KpiCard label="Km recorridos" value={fmt(k.km)} hint="Meses con km registrado" icon={<Route className="h-4 w-4" />} />
        <KpiCard label="Toneladas" value={fmt(k.ton)} hint={`${fmt(k.viajes)} viajes · ${fmt((k.tkm ?? 0) / 1e6, 2)} M t·km`} icon={<Scale className="h-4 w-4" />} />
        <KpiCard label="Costo por t·km" value={d.medianas.costo_tkm != null ? `S/ ${fmt(d.medianas.costo_tkm, 3)}` : '—'} hint="Mediana de los camiones" tone="navy" icon={<CircleDollarSign className="h-4 w-4" />} />
        <KpiCard label="Precio del galón" value={pUlt ? `S/ ${fmt(pUlt, 2)}` : '—'} hint={anios.length ? `Promedio ${anios[anios.length - 1]} (sin GLP)` : ''} icon={<Gauge className="h-4 w-4" />} />
      </div>
      <Conclusiones d={d} />
      <Panel title="Decisión por activo" hint="Reglas: edad frente a vida útil, costo por t·km o por hora frente a la mediana, tendencia del mantenimiento, uso y llenado. Los umbrales se ajustan en Datos y parámetros.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr className="border-b border-slate-200"><th className="px-3 py-2">Activo</th><th className="px-3 py-2">Decisión</th><th className="px-3 py-2 text-right">Edad</th><th className="px-3 py-2">Indicador clave</th><th className="px-3 py-2">Motivos</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.code} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2"><Link href={r.href} className="font-bold text-[#002855] hover:underline">{r.code}</Link><span className="block text-xs text-slate-500">{r.nombre}</span></td>
                  <td className="px-3 py-2"><RecPill rec={r.rec} /></td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.edad ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs tabular-nums text-slate-700">{r.indicador}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.motivos.length ? <ul className="list-disc space-y-0.5 pl-4">{r.motivos.map(m => <li key={m}>{m}</li>)}</ul> : <span className="text-slate-400">Sin alertas</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

function addMonth(iso: string, n: number) {
  const [y, m] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1 + n, 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`
}

export default function EficienciaFlotaPage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Resumen /></Suspense>
}
