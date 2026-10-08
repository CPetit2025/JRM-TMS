import type { ReactNode } from 'react'

/** Sección numerada de formularios amplios; el id permite saltar desde la lista de pendientes. */
export function FormSection({ id, step, title, hint, aside, children }: { id: string; step: number; title: string; hint?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return <section id={id} className="scroll-mt-2 rounded-xl border border-slate-200 bg-white p-4">
    <header className="mb-3 flex items-start gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#002855] text-xs font-bold text-white">{step}</span>
      <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-slate-900">{title}</h3>{hint && <p className="text-xs text-slate-500">{hint}</p>}</div>
      {aside}
    </header>
    {children}
  </section>
}

export type PendingItem = { label: string; target: string }

/** Lista de lo que falta para guardar; cada ítem lleva a su sección. */
export function PendingPanel({ items, doneText }: { items: PendingItem[]; doneText: string }) {
  return <div className={`rounded-xl border p-4 text-sm ${items.length ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
    <p className={`mb-2 text-xs font-bold uppercase tracking-wide ${items.length ? 'text-amber-800' : 'text-emerald-800'}`}>{items.length ? 'Pendiente' : 'Todo completo'}</p>
    {items.length ? <ul className="space-y-1">{items.map(item => <li key={item.label}>
      <button type="button" onClick={() => document.getElementById(item.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-amber-900 hover:bg-amber-100">
        <span aria-hidden className="h-3 w-3 shrink-0 rounded-full border-2 border-dashed border-amber-600" />{item.label}</button></li>)}</ul>
      : <p className="text-emerald-800">{doneText}</p>}
  </div>
}

/** Estado en el pie del modal: "Faltan N datos" o el texto de listo. */
export function PendingStatus({ count, readyText }: { count: number; readyText: string }) {
  return <p role="status" className={`flex items-center gap-2 text-sm font-medium ${count ? 'text-amber-700' : 'text-emerald-700'}`}>
    <span aria-hidden className={`h-3.5 w-3.5 rounded-full ${count ? 'border-2 border-dashed border-amber-600' : 'bg-emerald-600'}`} />
    {count ? (count === 1 ? 'Falta 1 dato' : `Faltan ${count} datos`) : readyText}
  </p>
}
