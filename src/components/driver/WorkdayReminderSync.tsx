'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'
import { listenWorkdayReminderTap, syncWorkdayReminder } from '@/lib/workday-reminder'

/** En el layout del app: mantiene los recordatorios de cierre al día en cualquier pantalla y abre Jornada al tocarlos. */
export function WorkdayReminderSync() {
  const router = useRouter()
  const { driver, pending } = useActiveTrip()
  const hasDriver = !!driver

  useEffect(() => listenWorkdayReminderTap(url => router.push(url)), [router])
  useEffect(() => {
    if (!hasDriver) return
    const refresh = () => {
      void createClient().rpc('get_driver_workday').then(({ data, error }) => {
        if (!error && data?.success) void syncWorkdayReminder(!!(data.start && !data.close))  // sin señal: se deja como estaba
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('jrm:preuse-queue-changed', refresh)
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('jrm:preuse-queue-changed', refresh) }
  }, [hasDriver, pending.checklist])  // el checklist registrado (o sincronizado) abre la jornada
  return null
}
