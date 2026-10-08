'use client'

import type { ReactNode } from 'react'
import { useClaimPageTitle } from '@/lib/nav/pageChromeStore'

/** Page identity row. Default: description + actions (the application bar shows the title).
 *  `showTitle`: compact enterprise row — title and short description on the left, primary actions on the right —
 *  and the application bar drops its own title so it is never shown twice. The h1 always exists for assistive tech. */
export function PageHeader({ title, description, actions, showTitle = false }: { title: string; description?: ReactNode; actions?: ReactNode; showTitle?: boolean }) {
  useClaimPageTitle(showTitle)
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    {showTitle
      ? <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5">
          <h1 className="text-xl font-bold leading-tight text-slate-900 sm:text-2xl">{title}</h1>
          {description && <p className="text-sm text-slate-500">{description}</p>}
        </div>
      : <><h1 className="sr-only">{title}</h1>{description && <p className="text-sm text-slate-500">{description}</p>}</>}
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
}
