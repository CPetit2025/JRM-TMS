import type { ReactNode } from 'react'

/** Semantic status chips shared by every module: the color carries the meaning, the text never depends on it. */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'special' | 'neutral'

const TONES: Record<StatusTone, string> = {
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  danger: 'bg-rose-50 text-rose-800 ring-rose-200',
  info: 'bg-blue-50 text-jrm-navy ring-blue-200',
  special: 'bg-violet-50 text-violet-800 ring-violet-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
}

export function StatusBadge({ tone = 'neutral', title, children }: { tone?: StatusTone; title?: string; children: ReactNode }) {
  return <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${TONES[tone]}`}>{children}</span>
}
