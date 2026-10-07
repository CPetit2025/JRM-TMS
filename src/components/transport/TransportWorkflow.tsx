'use client'

import Link from 'next/link'
import { ArrowRight, ClipboardList, FileCheck2, Radar, Receipt, Route } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'

export type TransportStage = 'solicitud' | 'programacion' | 'documentos' | 'registro'

const stages = [
  { id: 'solicitud', label: 'Solicitud', href: '/solicitudes', modules: ['solicitudes'], icon: ClipboardList },
  { id: 'programacion', label: 'Programación y ruteo', href: '/despacho', modules: ['despacho'], icon: Route },
  { id: 'documentos', label: 'Documentos y conformidad', href: '/despacho/documentos', modules: ['documentario', 'packing-list', 'planificacion'], icon: FileCheck2 },
  { id: 'registro', label: 'Registro de servicios', href: '/contratos/servicios', modules: ['contratos-servicios'], icon: Receipt },
] as const

/** A single navigation for the operational flow; server policies still authorize each action. */
export function TransportWorkflow({ current }: { current?: TransportStage }) {
  const { canRead, isLoaded } = usePermissions()
  if (!isLoaded) return null
  const visible = stages.filter(stage => stage.modules.some(module => canRead(module)))
  if (!visible.length) return null

  return <nav aria-label="Flujo de transporte" className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((stage, index) => {
        const Icon = stage.icon
        const active = stage.id === current
        return <div key={stage.id} className="flex items-center gap-2">
          {index > 0 && <ArrowRight aria-hidden className="hidden h-4 w-4 text-slate-300 sm:block" />}
          <Link href={stage.href} aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-semibold transition-colors sm:text-sm ${active ? 'bg-[#002855] text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-[#002855]'}`}>
            <Icon aria-hidden className="h-4 w-4 shrink-0" />{stage.label}
          </Link>
        </div>
      })}
      {['torre-control', 'despacho', 'monitoreo'].some(module => canRead(module)) && <Link href="/torre-control" aria-current={!current ? 'page' : undefined}
        className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs font-semibold sm:ml-auto sm:text-sm ${!current ? 'border-[#002855] bg-blue-50 text-[#002855]' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
        <Radar aria-hidden className="h-4 w-4" />Torre de Control
      </Link>}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500">La Torre de Control supervisa la ejecución. Los documentos de salida y la conformidad de entrega se gestionan en momentos distintos.</p>
  </nav>
}
