'use client'

import Link from 'next/link'
import { usePermissions } from '@/hooks/usePermissions'
import { canViewStage, DISPATCH_STAGES, type DispatchStage } from '@/lib/warehouse/dispatch'

export function DispatchNav({ stage, taskId }: { stage: DispatchStage; taskId?: string }) {
  const { hasAccess } = usePermissions()
  return <nav aria-label="Etapas de despacho" className="flex flex-wrap gap-2 print:hidden">
    {(Object.keys(DISPATCH_STAGES) as DispatchStage[]).filter(key => canViewStage(key, hasAccess)).map(key => {
      const item = DISPATCH_STAGES[key]
      const href = taskId ? `${item.path}/${taskId}` : item.path
      return <Link key={key} href={href} aria-current={stage === key ? 'page' : undefined} className={`rounded-lg border px-3 py-2 text-sm font-bold ${stage === key ? 'border-[#002855] bg-[#002855] text-white' : 'border-slate-300 bg-white text-[#002855]'}`}>{item.title}{key === 'auditoria' && <span className="ml-1 text-xs font-normal">· en paralelo</span>}</Link>
    })}
  </nav>
}
