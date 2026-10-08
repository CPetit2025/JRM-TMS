import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export type KpiTone = 'navy' | 'amber' | 'emerald' | 'blue' | 'violet' | 'rose' | 'slate'

const ICON_TONES: Record<KpiTone, string> = {
  navy: 'bg-blue-50 text-jrm-navy', amber: 'bg-amber-50 text-amber-600', emerald: 'bg-emerald-50 text-emerald-600',
  blue: 'bg-sky-50 text-sky-700', violet: 'bg-violet-50 text-violet-600', rose: 'bg-rose-50 text-rose-600', slate: 'bg-slate-100 text-slate-600',
}
const ACTIVE_TONES: Record<KpiTone, string> = {
  navy: 'border-jrm-navy', amber: 'border-amber-500', emerald: 'border-emerald-600', blue: 'border-sky-600',
  violet: 'border-violet-600', rose: 'border-rose-600', slate: 'border-slate-500',
}

/** Compact indicator. With `onClick` it behaves as a filter toggle (aria-pressed); the value must come from real data. */
export function KpiStatCard({ label, value, icon, tone = 'navy', active, onClick, loading }: {
  label: string; value: number | string; icon: ReactNode; tone?: KpiTone; active?: boolean; onClick?: () => void; loading?: boolean
}) {
  const body = <>
    <span aria-hidden className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${ICON_TONES[tone]}`}>{icon}</span>
    <span className="min-w-0 flex-1 text-left">
      <span className="block text-xs font-medium leading-4 text-slate-600">{label}</span>
      <span className="block text-2xl font-bold leading-7 tabular-nums text-slate-900">{loading ? '—' : value}</span>
    </span>
    {onClick && <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-slate-400" />}
  </>
  const base = `flex min-h-[4.25rem] w-full items-center gap-3 rounded-jrm border bg-jrm-surface px-4 py-3 shadow-jrm-card transition-colors ${active ? `${ACTIVE_TONES[tone]} border-b-[3px] bg-blue-50/40` : 'border-jrm-line'}`
  return onClick
    ? <button type="button" aria-pressed={!!active} onClick={onClick} className={`${base} hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-jrm-navy`}>{body}</button>
    : <div className={base}>{body}</div>
}
