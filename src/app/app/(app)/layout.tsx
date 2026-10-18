'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { nativeBiometric } from '@/lib/native-biometric'
import { toast } from 'sonner'
import { forgetTrackingDevice, nativeRouteTracker } from '@/lib/native-route-tracker'
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
    <div className="min-h-dvh bg-slate-50 pb-[calc(76px+env(safe-area-inset-bottom))] text-slate-900">
      <AppUpdateNotice />
      <OperativeHeader onLogout={onLogout} />
      <main>{children}</main>
      <OperativeBottomNav />
      <JrmAiAssistant />
    </div>
  </NotificationProvider>
}

import { useSync } from '@/lib/offline/useSync'

export default function OperativeLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  useSync()
  const handleLogout = async () => {
    try {
      const supabase = createClient()
      // Cierre de sesión: detiene el seguimiento y borra la credencial del dispositivo (el servidor también la revoca)
      if (nativeRouteTracker) await nativeRouteTracker.forget().catch(() => nativeRouteTracker!.stop())
      const { data: current } = await supabase.auth.getUser()
      forgetTrackingDevice(current.user?.id)
      await supabase.rpc('driver_app_disconnect').then(() => {}, () => {})
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) throw error
      if (nativeBiometric) await nativeBiometric.clear()
    } catch {
      toast.error('No se pudo cerrar la sesión. Inténtalo nuevamente.')
      return
    }
    localStorage.removeItem('jrm_driver')
    localStorage.removeItem('jrm_active_trip_context_v1')
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
