'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Loader2, Truck } from 'lucide-react'

export default function AccesoEntregas() {
  const router = useRouter()
  const [plate, setPlate] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="min-h-screen bg-slate-50 px-4 py-10">
    <main className="mx-auto max-w-md rounded-2xl border bg-white p-6 shadow-sm">
      <Truck className="mb-4 h-10 w-10 text-[#002855]" />
      <p className="text-xs font-bold uppercase tracking-widest text-slate-500">JRM · Transportistas</p>
      <h1 className="mt-2 text-2xl font-bold text-[#002855]">Guía de entrega</h1>
      <p className="mt-3 text-sm text-slate-600">Ingrese la placa de su unidad y el código entregado por Operaciones para consultar las entregas que requieren sustento.</p>
      <form className="mt-6 space-y-4" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('')
        try {
          const response = await fetch('/api/entregas/acceso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placa: plate, codigo: code }) })
          const result = await response.json()
          if (!result.success || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error(result.error || 'Acceso no válido')
          router.push(`/tracking/entrega/${result.token}`)
        } catch (err) { setError(err instanceof Error ? err.message : 'Sin conexión. Intente de nuevo.'); setBusy(false) }
      }}>
        <label className="block text-sm font-medium">Placa<input required autoComplete="off" maxLength={12} value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} className="mt-1 w-full rounded-lg border px-3 py-3 uppercase" placeholder="ABC-123" /></label>
        <label className="block text-sm font-medium">Código de acceso<input required autoComplete="off" maxLength={18} value={code} onChange={e => setCode(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-3" /></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#002855] font-bold text-white disabled:opacity-60">{busy && <Loader2 className="h-5 w-5 animate-spin" />}Consultar servicio</button>
      </form>
      <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sin la guía firmada y aprobada por el Supervisor de Transporte, el servicio no puede avanzar.</p>
      <p className="mt-3 text-xs text-slate-500">Al enviar el sustento se bloquea el acceso a esa entrega. Solo una observación o rechazo habilita la corrección.</p>
    </main>
  </div>
}
