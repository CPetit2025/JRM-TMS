'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Gauge } from 'lucide-react'
import { fleetApi, fmt, mes, soles } from '@/lib/fleet/api'
import type { FeEquipo, FeTransporte } from '@/lib/fleet/types'
import { ConfianzaPill, RecPill } from './ui'

// Tarjeta de Eficiencia de Flota para la ficha Flota 360 de Mantenimiento: decisión, costo y motivos del activo.
// Solo se muestra a quien tiene acceso al módulo y si el activo tiene datos (fe_activo).

export function FeActivoCard({ plate }: { plate: string }) {
  const [res, setRes] = useState<{ desde?: string; hasta?: string; activo: FeTransporte | FeEquipo | null } | null>(null)
  useEffect(() => {
    let alive = true
    fleetApi.activo(plate).then(r => alive && setRes(r)).catch(() => alive && setRes(null))
    return () => { alive = false }
  }, [plate])
  const a = res?.activo
  if (!a) return null
  const t = 'kmgal' in a ? (a as FeTransporte) : null
  const e = t ? null : (a as FeEquipo)
  const items: Array<[string, string]> = t
    ? [['Costo por km', t.costo_km != null ? `S/ ${fmt(t.costo_km, 2)}` : '—'], ['Costo por t·km (total)', t.costo_tkm_total != null ? `S/ ${fmt(t.costo_tkm_total, 3)}` : '—'],
       ['Km por galón', `${fmt(t.kmgal, 1)}${t.kmgal_grupo ? ` (grupo ${fmt(t.kmgal_grupo, 1)})` : ''}`],
       ['Reemplazar hoy', t.econ ? (t.econ.ahorro > 0 ? `ahorra ${soles(t.econ.ahorro)}/año` : `cuesta ${soles(-t.econ.ahorro)}/año más`) : '—']]
    : [['Costo propio por hora', e?.costo_propio_hora != null ? `S/ ${fmt(e.costo_propio_hora, 1)}` : '—'], ['Horas por año', fmt(e?.horas_anio)],
       ['Alquilar esas horas', soles(e?.alquiler_anual)], ['Mantenimiento anual', soles(e?.costo_anual)]]
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Gauge className="h-4 w-4 text-[#002855]" />Eficiencia de flota
          <span className="text-xs font-normal text-slate-500">{mes(res?.desde)} → {mes(res?.hasta)}</span></h3>
        <div className="flex items-center gap-2"><RecPill rec={a.rec} />{t && <ConfianzaPill c={t.confianza} />}
          <Link href={t ? `/eficiencia-flota/transporte#u-${encodeURIComponent(a.code)}` : '/eficiencia-flota/equipos'} className="text-xs font-semibold text-[#002855] hover:underline">Ver análisis</Link></div>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-4">
        {items.map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-semibold text-slate-800">{v}</dd></div>)}
      </dl>
      {a.motivos.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">{a.motivos.map(m => <li key={m}>{m}</li>)}</ul>}
    </div>
  )
}
