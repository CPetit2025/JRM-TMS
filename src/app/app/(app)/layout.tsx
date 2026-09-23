'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { nativeRouteTracker } from '@/lib/native-route-tracker'
import GPSGuard from '@/components/driver/GPSGuard'
import NotificationProvider from '@/components/NotificationProvider'
import { AppUpdateNotice } from '@/components/AppUpdateNotice'
import { JrmAiAssistant } from '@/components/JrmAiAssistant'
import { ActiveTripProvider } from '@/contexts/ActiveTripContext'
import { OperationalStatusProvider } from '@/contexts/OperationalStatusContext'
import { OperativeHeader } from '@/components/driver/OperativeHeader'
import { OperativeBottomNav } from '@/components/driver/OperativeBottomNav'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

function OperativeShell({ children, onLogout }: { children: React.ReactNode; onLogout: () => void }) {
  const { user } = useActiveTrip()
  return <NotificationProvider role={user?.employee_type === 'CONDUCTOR' ? 'driver' : 'operario'}>
    <div className="min-h-dvh bg-slate-50 pb-[76px] text-slate-900">
      <AppUpdateNotice />
      <OperativeHeader onLogout={onLogout} />
      <main>{children}</main>
      <OperativeBottomNav />
      <JrmAiAssistant />
    </div>
  </NotificationProvider>
}

export default function OperativeLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const handleLogout = async () => {
    if (nativeRouteTracker) await nativeRouteTracker.stop()
    localStorage.removeItem('jrm_driver')
    localStorage.removeItem('jrm_active_trip_context_v1')
    await createClient().auth.signOut()
    router.replace('/app/login')
  }

  return <ActiveTripProvider>
    <OperationalStatusProvider>
      <GPSGuard>
        <OperativeShell onLogout={() => void handleLogout()}>{children}</OperativeShell>
      </GPSGuard>
    </OperationalStatusProvider>
  </ActiveTripProvider>
}
