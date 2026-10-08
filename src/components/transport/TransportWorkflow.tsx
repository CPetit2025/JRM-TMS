'use client'

import Link from 'next/link'
import { ArrowRight, ClipboardList, FileCheck2, Radar, Receipt, Route } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'

export type TransportStage = 'solicitud' | 'programacion' | 'documentos' | 'registro'

const stages = [
  { id: 'solicitud', label: 'Solicitud', hint: 'Registro de solicitud', href: '/solicitudes', modules: ['solicitudes'], icon: ClipboardList },
  { id: 'programacion', label: 'Programación y ruteo', hint: 'Planificación de servicios', href: '/despacho', modules: ['despacho'], icon: Route },
  { id: 'documentos', label: 'Documentos y conformidad', hint: 'Gestión de documentos', href: '/despacho/documentos', modules: ['documentario', 'packing-list', 'planificacion'], icon: FileCheck2 },
  { id: 'registro', label: 'Registro de servicios', hint: 'Ejecución y cierre', href: '/contratos/servicios', modules: ['contratos-servicios', 'clientes'], icon: Receipt },
] as const

/** A single navigation for the operational flow; server policies still authorize each action. */
export function TransportWorkflow({ current }: { current?: TransportStage }) {
  const { canRead, isLoaded } = usePermissions()
  if (!isLoaded) return null
  const visible = stages.filter(stage => stage.modules.some(module => canRead(module)))
  if (!visible.length) return null

  return <nav aria-label="Flujo de transporte" className="rounded-jrm border border-jrm-line bg-jrm-surface p-2 shadow-jrm-card sm:p-3">
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((stage, index) => {
        const Icon = stage.icon
        const active = stage.id === current
        return <div key={stage.id} className="flex min-w-0 items-center gap-2">
          {index > 0 && <ArrowRight aria-hidden className="hidden h-4 w-4 shrink-0 text-slate-400 sm:block" />}
          <Link href={stage.href} aria-current={active ? 'page' : undefined}
            className={`flex min-h-12 min-w-0 items-center gap-3 rounded-lg px-3 py-1.5 transition-colors ${active ? 'bg-jrm-navy text-white shadow-sm' : 'bg-slate-50 text-slate-700 hover:bg-slate-100 hover:text-jrm-navy'}`}>
            <Icon aria-hidden className="h-5 w-5 shrink-0" />
            <span className="min-w-0 leading-tight"><span className="block truncate text-xs font-semibold sm:text-sm">{stage.label}</span>
              <span className={`hidden truncate text-[11px] sm:block ${active ? 'text-blue-100' : 'text-slate-500'}`}>{stage.hint}</span></span>
          </Link>
        </div>
      })}
      {['torre-control', 'despacho', 'monitoreo'].some(module => canRead(module)) && <Link href="/torre-control" aria-current={!current ? 'page' : undefined}
        title="La Torre de Control supervisa la ejecución. Los documentos de salida y la conformidad de entrega se gestionan en momentos distintos."
        className={`inline-flex min-h-12 items-center gap-2 rounded-lg border px-4 text-xs font-semibold sm:ml-auto sm:text-sm ${!current ? 'border-jrm-navy bg-blue-50 text-jrm-navy' : 'border-slate-200 bg-white text-jrm-navy hover:bg-slate-50'}`}>
        <Radar aria-hidden className="h-4 w-4" />Torre de Control
      </Link>}
    </div>
    <p className="sr-only">La Torre de Control supervisa la ejecución. Los documentos de salida y la conformidad de entrega se gestionan en momentos distintos.</p>
  </nav>
}
