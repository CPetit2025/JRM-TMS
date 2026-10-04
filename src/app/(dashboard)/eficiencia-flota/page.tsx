'use client'

import { Suspense, useMemo } from 'react'
import Link from 'next/link'
import { CircleDollarSign, Fuel, PiggyBank, Route, Scale, Wrench } from 'lucide-react'
import { fleetApi, fmt, mes, pct, soles } from '@/lib/fleet/api'
import { CLASE_LABEL, GRUPO_LABEL, REC_ORDER, type FeConfianza, type FeEquipo, type FeRec, type FeResumen, type FeTransporte } from '@/lib/fleet/types'
import { KpiCard, LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { ConfianzaPill, Panel, RecPill, useFeFilters, useFeQuery } from '@/components/fleet/ui'

// Resumen: indicadores del periodo, conclusiones y decisión por activo con su impacto económico anual.
// Costos a precio constante del combustible y con el mantenimiento mayor repartido (ver docs/eficiencia-flota.md).

type Fila = {
  code: string; nombre: string; rec: FeRec; score: number; edad: number | null; indicador: string; motivos: string[]; href: string
  impacto: number | null; impactoTxt: string; confianza: FeConfianza | null
}

function filas(d: FeResumen): Fila[] {
  const t: Fila[] = d.transporte.map((u: FeTransporte) => {
    const ah = u.econ?.ahorro ?? null
    return {
      code: u.code, nombre: [GRUPO_LABEL[u.grupo] ?? u.tipo, u.marca].filter(Boolean).join(' · ') || 'Transporte', rec: u.rec, score: u.score, edad: u.edad,
      indicador: u.costo_tkm != null && (u.kg_viaje ?? 0) >= 500 ? `S/ ${fmt(u.costo_tkm, 3)} por t·km` : u.costo_km != null ? `S/ ${fmt(u.costo_km, 2)} por km` : '—',
      motivos: u.motivos, href: `/eficiencia-flota/transporte#u-${encodeURIComponent(u.code)}`, confianza: u.confianza,
      impacto: ah, impactoTxt: ah == null ? '—' : ah > 0 ? `Reemplazar ahorra ${soles(ah)}/año` : `Seguir ahorra ${soles(-ah)}/año`,
    }
  })
  const e: Fila[] = d.equipos.map((x: FeEquipo) => {
    const dif = x.costo_propio_anual != null && x.alquiler_anual != null ? x.costo_propio_anual - x.alquiler_anual : null
    return {
      code: x.code, nombre: CLASE_LABEL[x.clase], rec: x.rec, score: x.score, edad: x.edad,
      indicador: x.costo_propio_hora != null ? `S/ ${fmt(x.costo_propio_hora, 1)} por hora · ${fmt(x.horas_anio)} h/año` : x.costo_anual != null ? `${soles(x.costo_anual)} al año` : '—',
      motivos: x.motivos, href: '/eficiencia-flota/equipos', confianza: null,
      impacto: dif, impactoTxt: dif == null ? '—' : dif > 0 ? `Alquilar ahorra ${soles(dif)}/año` : `Propio ahorra ${soles(-dif)}/año`,
    }
  })
  return [...t, ...e].sort((a, b) => REC_ORDER.indexOf(a.rec) - REC_ORDER.indexOf(b.rec) || b.score - a.score || (b.edad ?? 0) - (a.edad ?? 0))
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function Conclusiones({ d }: { d: FeResumen }) {
  const items: string[] = []
  const [iLow, , iHigh] = d.tasas ?? [0.06, 0.1, 0.15]
  const rep = d.transporte.filter(u => u.rec === 'Reemplazar')
  if (rep.length) items.push(`<b>Reemplazar conviene en ${rep.map(u => `${u.code} (ahorro ${soles(u.econ_alto?.ahorro ?? u.econ?.ahorro)} a ${soles(u.econ_bajo?.ahorro ?? u.econ?.ahorro)} al año)`).join(', ')}</b>: el ahorro se mantiene con un costo de capital entre ${fmt(iLow * 100)} % y ${fmt(iHigh * 100)} %.`)
  const alq = d.equipos.filter(e => e.rec === 'Dar de baja o alquilar')
  if (alq.length) items.push(`<b>Alquilar en vez de mantener:</b> ${alq.map(e => `${e.code} (S/ ${fmt(e.costo_propio_hora, 0)} por hora propio vs S/ ${fmt(d.alquiler_hora)} alquilado)`).join(', ')}.`)
  const viejasBaratas = d.transporte.filter(u => (u.econ_alto?.ahorro ?? 1) < 0 && (u.econ_bajo?.ahorro ?? 1) < 0 && (u.edad ?? 0) >= u.vida_util)
  if (viejasBaratas.length) items.push(`${viejasBaratas.map(u => u.code).join(', ')} ${viejasBaratas.length > 1 ? 'superan' : 'supera'} su vida útil, pero seguir con ${viejasBaratas.length > 1 ? 'ellas' : 'ella'} sale más barato que una nueva: planifique el reemplazo por seguridad o disponibilidad, no por costo.`)
  const reas = d.transporte.filter(u => u.ociosa)
  if (reas.length) items.push(`<b>Capacidad ociosa:</b> ${reas.map(u => u.capacidad_fuente === 'ficha' || u.capacidad_fuente === 'flota' ? `${u.code} lleva ${pct(u.llenado)} de su capacidad` : `${u.code} viaja con ${pct(u.m3)} del volumen`).join(', ')}. Asignar cargas chicas a unidades chicas baja el costo por tonelada sin comprar nada.`)
  const anios = Object.keys(d.precio_anio).map(Number).sort()
  if (anios.length >= 2 && d.precio_ref) {
    const a = anios[anios.length - 1], b = anios[anios.length - 2]
    const pa = d.precio_anio[a], pb = d.precio_anio[b]
    if (pa && pb) items.push(`El galón pasó de S/ ${fmt(pb, 2)} (${b}) a S/ ${fmt(pa, 2)} (${a}). Para comparar unidades y años se usa el precio de referencia actual, <b>S/ ${fmt(d.precio_ref, 2)}</b>: así una unidad no parece peor solo porque subió el combustible.`)
  }
  const corr = d.kpis.mant_correctivo, tot = d.kpis.mant
  if (corr && tot) items.push(`El ${pct(corr / tot)} del mantenimiento es correctivo (incluye los registros "preventivos" cuyo detalle describe una reparación).`)
  const ctot = median(d.transporte.filter(u => u.costo_tkm_total != null && (u.kg_viaje ?? 0) >= 500).map(u => u.costo_tkm_total as number))
  if (ctot) items.push(`Con conductor y ayudantes, el costo mediano es <b>S/ ${fmt(ctot, 3)} por t·km</b> (solo combustible y mantenimiento: S/ ${fmt(median(d.transporte.filter(u => u.costo_tkm != null && (u.kg_viaje ?? 0) >= 500).map(u => u.costo_tkm as number)), 3)}).`)
  const baja = d.transporte.filter(u => u.confianza === 'Baja')
  if (baja.length) items.push(`${baja.map(u => u.code).join(', ')}: menos de 6 meses completos de datos; sus resultados son preliminares.`)
  const sinValor = [...d.transporte, ...d.equipos].filter(x => x.valor_ref).length
  if (sinValor) items.push(`${sinValor} activos usan el valor referencial de una unidad nueva: ingrese la cotización real en <i>Datos y parámetros</i> para afinar la decisión.`)
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
  const ahorro = (k.ahorro_reemplazo ?? 0) + (k.ahorro_alquiler ?? 0)
  const ctot = median(d.transporte.filter(u => u.costo_tkm_total != null && (u.kg_viaje ?? 0) >= 500).map(u => u.costo_tkm_total as number))
  return (
    <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded-lg bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">Periodo {mes(d.desde)} → {mes(d.hasta)} · {d.meses} meses</span>
        <span className="rounded-lg bg-slate-100 px-2.5 py-1">Excel hasta: mantenimiento {mes(addMonth(d.corte.mantenimiento, -1))}, combustible {mes(addMonth(d.corte.combustible, -1))}, rutas {mes(addMonth(d.corte.rutas, -1))} · luego TMS</span>
        {d.precio_ref != null && <span className="rounded-lg bg-slate-100 px-2.5 py-1">Precio constante: S/ {fmt(d.precio_ref, 2)} por galón{d.precio_ref_glp ? ` · GLP S/ ${fmt(d.precio_ref_glp, 2)}` : ''}</span>}
        <span className="rounded-lg bg-slate-100 px-2.5 py-1">{d.cobertura.vinculados ?? 0} activos vinculados a Flota (Mantenimiento)</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Mantenimiento" value={soles(k.mant)} hint={`Correctivo ${k.mant && k.mant_correctivo ? pct(k.mant_correctivo / k.mant) : '—'} · llantas ${soles(k.neumaticos)}`} icon={<Wrench className="h-4 w-4" />} />
        <KpiCard label="Combustible" value={soles(k.comb)} hint={`${fmt(k.gal)} gal · a precio actual ${soles(k.comb_c)}`} icon={<Fuel className="h-4 w-4" />} />
        <KpiCard label="Km recorridos" value={fmt(k.km)} hint="Meses con km registrado" icon={<Route className="h-4 w-4" />} />
        <KpiCard label="Toneladas" value={fmt(k.ton)} hint={`${fmt(k.viajes)} viajes · ${fmt((k.tkm ?? 0) / 1e6, 2)} M t·km`} icon={<Scale className="h-4 w-4" />} />
        <KpiCard label="Costo total por t·km" value={ctot != null ? `S/ ${fmt(ctot, 3)}` : '—'} hint="Mediana · combustible, mantenimiento, conductor y ayudantes" tone="navy" icon={<CircleDollarSign className="h-4 w-4" />} />
        <KpiCard label="Ahorro posible" value={ahorro > 0 ? `${soles(ahorro)}/año` : '—'} hint="Reemplazos y alquileres recomendados" icon={<PiggyBank className="h-4 w-4" />} />
      </div>
      <Conclusiones d={d} />
      <Panel title="Decisión por activo" hint={`Reemplazar: el costo de seguir un año más (mantenimiento, combustible, pérdida de valor y costo de capital) supera al de una unidad nueva con tasas de ${fmt((d.tasas?.[0] ?? 0.06) * 100)} % a ${fmt((d.tasas?.[2] ?? 0.15) * 100)} %. Equipos: costo propio por hora frente al alquiler (S/ ${fmt(d.alquiler_hora)} + IGV).`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr className="border-b border-slate-200"><th className="px-3 py-2">Activo</th><th className="px-3 py-2">Decisión</th><th className="px-3 py-2">Datos</th><th className="px-3 py-2 text-right">Edad</th>
                <th className="px-3 py-2">Indicador clave</th><th className="px-3 py-2">Impacto anual</th><th className="px-3 py-2">Motivos</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => (
                <tr key={r.code} className="align-top hover:bg-slate-50">
                  <td className="px-3 py-2"><Link href={r.href} className="font-bold text-[#002855] hover:underline">{r.code}</Link><span className="block text-xs text-slate-500">{r.nombre}</span></td>
                  <td className="px-3 py-2"><RecPill rec={r.rec} /></td>
                  <td className="px-3 py-2">{r.confianza ? <ConfianzaPill c={r.confianza} /> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.edad ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs tabular-nums text-slate-700">{r.indicador}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-xs font-semibold ${r.impacto != null && r.impacto > 0 && (r.rec === 'Reemplazar' || r.rec === 'Dar de baja o alquilar') ? 'text-red-700' : 'text-slate-600'}`}>{r.impactoTxt}</td>
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
