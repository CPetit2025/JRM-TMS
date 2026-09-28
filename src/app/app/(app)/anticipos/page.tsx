'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Banknote, Loader2, Receipt, Truck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'
import { AdvanceRequestCard } from '@/components/driver/AdvanceRequestCard'

// Acceso directo del conductor a sus anticipos (Caja C4). La solicitud requiere una ruta asignada;
// sin ruta se explica por qué no puede pedirse todavía.

const OPEN_STATUSES = ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO']

export default function DriverAdvancesPage() {
  const supabase = useMemo(() => createClient(), [])
  const { trip, loading } = useActiveTrip()
  const [spent, setSpent] = useState(0)

  useEffect(() => {
    if (!trip) return
    void supabase.from('dispatch_expenses').select('amount, status, paid_by').eq('dispatch_id', trip.id)
      .then(({ data }) => setSpent((data || [])
        .filter(e => e.status !== 'RECHAZADO' && e.paid_by !== 'EMPRESA' && e.paid_by !== 'CAJA')
        .reduce((s, e) => s + Number(e.amount), 0)))
  }, [supabase, trip])

  if (loading && !trip) return <div className="flex min-h-[55vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#002855]" /></div>

  if (!trip) return (
    <div className="mx-auto max-w-lg p-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100"><Banknote className="h-8 w-8 text-slate-400" /></div>
        <h1 className="mb-2 text-lg font-black text-slate-800">Sin ruta asignada</h1>
        <p className="mb-6 text-sm text-slate-500">El anticipo se solicita para una ruta. Cuando despacho te asigne un viaje podrás pedirlo aquí.</p>
        <Link href="/app/viajes" className="block w-full rounded-xl bg-[#002855] py-3 font-bold text-white">Ver mis viajes</Link>
      </div>
    </div>
  )

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-black text-[#002855]"><Banknote className="h-6 w-6" />Anticipos</h1>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500"><Truck className="h-3 w-3" />{trip.dispatch_number} · {trip.vehicle_plate || 'Unidad pendiente'}</p>
      </div>
      <AdvanceRequestCard dispatchId={trip.id} spent={spent} canRequest={OPEN_STATUSES.includes(trip.status)} />
      {!OPEN_STATUSES.includes(trip.status) && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">El viaje está en {trip.status}: ya no se pueden pedir anticipos nuevos.</p>}
      <Link href="/app/gastos" className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-3 text-sm font-bold text-[#002855]"><Receipt className="h-4 w-4" />Registrar gastos del viaje</Link>
    </div>
  )
}
