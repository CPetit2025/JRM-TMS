import type { ReactNode } from 'react'

export type StatusBarTone = 'navy' | 'amber' | 'emerald' | 'blue' | 'violet' | 'rose' | 'slate'

const ICON: Record<StatusBarTone, string> = {
  navy: 'text-jrm-navy', amber: 'text-amber-600', emerald: 'text-emerald-600', blue: 'text-sky-600', violet: 'text-violet-600', rose: 'text-rose-600', slate: 'text-slate-500',
}
const COUNT: Record<StatusBarTone, string> = {
  navy: 'bg-blue-50 text-jrm-navy', amber: 'bg-amber-50 text-amber-700', emerald: 'bg-emerald-50 text-emerald-700', blue: 'bg-sky-50 text-sky-700',
  violet: 'bg-violet-50 text-violet-700', rose: 'bg-rose-50 text-rose-700', slate: 'bg-slate-100 text-slate-600',
}

export interface StatusBarItem { key: string; label: string; count: number; icon: ReactNode; tone?: StatusBarTone }

/** One-row status filter (36–40 px): icon, label and count per state. Replaces the tall KPI cards where the states
 *  are also the table's filter. Counts must come from the page's real data. */
export function InlineStatusBar({ label, items, active, onChange, loading }: {
  label: string; items: StatusBarItem[]; active: string; onChange: (key: string) => void; loading?: boolean
}) {
  return <div role="group" aria-label={label} className="flex flex-wrap items-center gap-x-1 rounded-jrm border border-jrm-line bg-jrm-surface px-1.5 py-1 shadow-jrm-card">
    {items.map((item, i) => {
      const tone = item.tone || 'navy'
      const on = active === item.key
      return <div key={item.key} className="flex items-center">
        {i > 0 && <span aria-hidden className="mr-1 h-5 w-px bg-slate-200" />}
        <button type="button" aria-pressed={on} onClick={() => onChange(item.key)}
          className={`flex h-10 items-center gap-2 rounded-md border-b-2 px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-jrm-navy ${on ? 'border-jrm-navy bg-blue-50/60 font-semibold text-jrm-navy' : 'border-transparent text-slate-600 hover:bg-slate-50 hover:text-jrm-navy'}`}>
          <span aria-hidden className={`[&>svg]:h-4 [&>svg]:w-4 ${ICON[tone]}`}>{item.icon}</span>
          {item.label}
          <span className={`min-w-7 rounded-full px-2 py-0.5 text-center text-xs font-semibold tabular-nums ${COUNT[tone]}`}>{loading ? '—' : item.count}</span>
        </button>
      </div>
    })}
  </div>
}
