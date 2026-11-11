'use client'
import { useState, type ReactNode } from 'react'
import { WmsAdministration } from './WmsAdministration'

export function SystemAdministration({ children, mode }: { children: ReactNode; mode: 'users' | 'roles' }) {
  const [system, setSystem] = useState<'tms' | 'wms'>('tms')
  return <div className="space-y-4">
    <section className="rounded-xl border bg-white p-4 space-y-3" aria-label="Sistema que administra">
      <div className="flex gap-2">{(['tms', 'wms'] as const).map(value => <button key={value} type="button" aria-pressed={system === value} onClick={() => setSystem(value)} className={`rounded-lg px-5 py-2 font-semibold ${system === value ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-700'}`}>{value.toUpperCase()}</button>)}</div>
      <p className="text-sm text-slate-700"><strong>Administrando {system.toUpperCase()}.</strong> Las cuentas, roles y estados de acceso son independientes. Dar acceso al TMS no habilita WMS, ni al revés.</p>
    </section>
    {system === 'tms' ? children : <WmsAdministration mode={mode} />}
  </div>
}
