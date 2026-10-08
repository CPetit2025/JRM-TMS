import type { ReactNode } from 'react'

/** The application bar already shows section and screen name; this keeps the page's own h1 for assistive tech
 *  and adds the short description plus the primary action, without repeating the title visually. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <h1 className="sr-only">{title}</h1>
    {description && <p className="text-sm text-slate-500">{description}</p>}
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
}
