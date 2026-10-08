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

const TORRE_TITLE = 'La Torre de Control supervisa la ejecución. Los documentos de salida y la conformidad de entrega se gestionan en momentos distintos.'

/** Access to the control tower, independent from the sequential process. Same permission rule as before. */
export function TorreControlButton({ active = false }: { active?: boolean }) {
  const { canRead, isLoaded } = usePermissions()
  if (!isLoaded || !['torre-control', 'despacho', 'monitoreo'].some(module => canRead(module))) return null
  return <Link href="/torre-control" aria-current={active ? 'page' : undefined} title={TORRE_TITLE}
    className={`inline-flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-semibold ${active ? 'border-jrm-navy bg-blue-50 text-jrm-navy' : 'border-slate-200 bg-white text-jrm-navy hover:bg-slate-50'}`}>
    <Radar aria-hidden className="h-4 w-4" />Torre de Control
  </Link>
}

/** A single compact navigation (40–44 px) for the operational flow; server policies still authorize each action.
 *  `torre={false}` lets a page place the Torre de Control button in its own header row. */
export function TransportWorkflow({ current, torre = true }: { current?: TransportStage; torre?: boolean }) {
  const { canRead, isLoaded } = usePermissions()
  if (!isLoaded) return null
  const visible = stages.filter(stage => stage.modules.some(module => canRead(module)))
  if (!visible.length) return null

  return <nav aria-label="Flujo de transporte" className="rounded-jrm border border-jrm-line bg-jrm-surface px-1.5 py-1 shadow-jrm-card">
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((stage, index) => {
        const Icon = stage.icon
        const active = stage.id === current
        return <div key={stage.id} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <ArrowRight aria-hidden className="hidden h-4 w-4 shrink-0 text-slate-400 sm:block" />}
          <Link href={stage.href} aria-current={active ? 'page' : undefined} title={stage.hint}
            className={`flex h-10 min-w-0 items-center gap-2 rounded-lg px-3.5 text-sm transition-colors ${active ? 'bg-jrm-navy font-semibold text-white shadow-sm' : 'font-medium text-slate-700 hover:bg-slate-100 hover:text-jrm-navy'}`}>
            <Icon aria-hidden className="h-4 w-4 shrink-0" /><span className="truncate">{stage.label}</span>
          </Link>
        </div>
      })}
      {torre && <div className="sm:ml-auto"><TorreControlButton active={!current} /></div>}
    </div>
    <p className="sr-only">{TORRE_TITLE}</p>
  </nav>
}
