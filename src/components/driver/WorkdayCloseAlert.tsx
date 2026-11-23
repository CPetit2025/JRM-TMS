'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Gauge } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { listenWorkdayReminderTap, syncWorkdayReminder } from '@/lib/workday-reminder'

type Pending = { operation_date: string; unit: string } | null
const ddmm = (d: string) => d.split('-').reverse().slice(0, 2).join('/')

/** Aviso en Inicio: jornada anterior sin cerrar (bloquea el checklist) y jornada de hoy abierta; programa el recordatorio. */
export function WorkdayCloseAlert() {
  const router = useRouter()
  const [pending, setPending] = useState<Pending>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => listenWorkdayReminderTap(url => router.push(url)), [router])
  useEffect(() => {
    const supabase = createClient()
    let alive = true
    void Promise.all([supabase.rpc('get_driver_pending_close'), supabase.rpc('get_driver_workday')]).then(([p, w]) => {
      if (!alive) return
      setPending(p.data?.success ? (p.data.pending as Pending) : null)
      if (w.error || !w.data?.success) return  // sin señal: se deja el recordatorio como estaba
      const isOpen = !!(w.data.start && !w.data.close)
      setOpen(isOpen)
      void syncWorkdayReminder(isOpen)
    })
    return () => { alive = false }
  }, [])

  return <>
    {pending && <Link href="/app/jornada" className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><span><b className="block">Jornada del {ddmm(pending.operation_date)} sin cerrar · {pending.unit}</b>Registra el odómetro de cierre para poder hacer el checklist de hoy.</span>
    </Link>}
    {!pending && open && <Link href="/app/jornada" className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <Gauge className="h-5 w-5 shrink-0" />Jornada abierta: al terminar el día registra el odómetro final.
    </Link>}
  </>
}
