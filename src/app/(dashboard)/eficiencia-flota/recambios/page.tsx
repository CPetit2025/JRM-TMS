'use client'

import { Suspense, useEffect, useState } from 'react'
import { fleetApi, mes } from '@/lib/fleet/api'
import { CLASE_LABEL, type FeRecambios } from '@/lib/fleet/types'
import { LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { Panel } from '@/components/fleet/ui'

// Recambios: periodo de actividad de cada activo (primer y último mes con km, combustible, viajes o mantenimiento)

function Recambios() {
  const [res, setRes] = useState<{ data?: FeRecambios; error?: string } | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => { let a = true; fleetApi.recambios().then(d => a && setRes({ data: d })).catch(e => a && setRes({ error: e.message })); return () => { a = false } }, [n])
  if (!res) return <LoadingBlock label="Reconstruyendo altas y bajas…" className="h-80" />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={() => setN(x => x + 1)} />
  const A = res.data.activos
  if (!A.length) return <EmptyState title="Sin historia de activos">Cargue la historia en Datos y parámetros.</EmptyState>
  const y0 = Math.min(...A.map(a => Number(a.desde.slice(0, 4))))
  const hoy = res.data.hoy
  const t = (iso: string) => { const [y, m] = iso.split('-').map(Number); return (y - y0) * 12 + (m - 1) }
  const span = t(hoy) + 1
  const years = Array.from({ length: Number(hoy.slice(0, 4)) - y0 + 1 }, (_, i) => y0 + i)
  const ult = (iso: string) => t(hoy) - t(iso) <= 2
  const grupos = ['TRANSPORTE', 'MONTACARGA', 'ELEVACION'] as const
  return (
    <div className="space-y-4">
      {grupos.map(g => {
        const L = A.filter(a => a.clase === g)
        if (!L.length) return null
        const bajas = L.filter(a => !ult(a.hasta))
        return (
          <Panel key={g} title={CLASE_LABEL[g]} hint={bajas.length ? `Sin actividad reciente: ${bajas.map(a => `${a.code} (desde ${mes(a.hasta)})`).join(', ')}` : 'Todos con actividad reciente'}>
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[220px_1fr] text-[10px] font-bold text-slate-400">
                  <span />
                  <div className="relative h-4">{years.map(y => <span key={y} className="absolute" style={{ left: `${t(`${y}-01`) / span * 100}%` }}>{y}</span>)}</div>
                </div>
                {L.map(a => (
                  <div key={a.code} className="grid grid-cols-[220px_1fr] items-center py-1 text-sm">
                    <span className="truncate pr-3"><b className="text-slate-800">{a.code}</b><span className="ml-1 text-xs text-slate-500">{[a.tipo?.toLowerCase(), a.anio_fab].filter(Boolean).join(' · ')}</span></span>
                    <div className="relative h-5 rounded bg-slate-50">
                      {years.map(y => <span key={y} className="absolute top-0 h-full w-px bg-slate-200" style={{ left: `${t(`${y}-01`) / span * 100}%` }} />)}
                      <span title={`${a.code}: ${mes(a.desde)} a ${mes(a.hasta)} · ${a.meses} meses con datos`}
                        className={`absolute top-0.5 h-4 rounded ${ult(a.hasta) ? 'bg-[#2a78d6]' : 'bg-slate-400'}`}
                        style={{ left: `${t(a.desde) / span * 100}%`, width: `${Math.max(0.8, (t(a.hasta) - t(a.desde) + 1) / span * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        )
      })}
      <p className="text-xs text-slate-500">Azul: con actividad en los últimos 3 meses. Gris: sin actividad reciente (posible baja). El periodo sale del primer y el último mes con km, combustible, viajes o mantenimiento.</p>
    </div>
  )
}

export default function RecambiosPage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Recambios /></Suspense>
}
