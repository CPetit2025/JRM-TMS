'use client'

import Image from 'next/image'
import { LogOut } from 'lucide-react'
import { useActiveTrip } from '@/contexts/ActiveTripContext'
import { useOperationalStatus } from '@/contexts/OperationalStatusContext'

const dot = {
  green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', slate: 'bg-slate-400',
}

export function OperativeHeader({ onLogout }: { onLogout: () => void }) {
  const { user, trip } = useActiveTrip()
  const { online, gps, pendingSync } = useOperationalStatus()
  const gpsColor = gps === 'active' ? 'green' : gps === 'checking' ? 'amber' : 'red'

  return <header className="sticky top-0 z-40 border-b border-blue-950/40 bg-[#002855] text-white shadow-md">
    <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Image src="/jrm-logo-v2.png" alt="JRM" width={52} height={18} className="h-auto object-contain" priority />
        <div className="min-w-0 border-l border-white/20 pl-2.5">
          <p className="truncate text-sm font-bold">{user ? `${user.first_name} ${user.last_name}` : 'Portal Operativo'}</p>
          <p className="truncate text-[10px] text-blue-200">{trip ? `${trip.vehicle_plate || 'Sin placa'} · ${trip.status}` : 'Sin viaje activo'}</p>
        </div>
      </div>
      <button type="button" onClick={onLogout} aria-label="Cerrar sesión" className="rounded-full bg-white/10 p-2 active:bg-white/20">
        <LogOut className="h-4 w-4" />
      </button>
    </div>
    <div className="mx-auto flex max-w-lg items-center gap-3 border-t border-white/10 px-4 py-1.5 text-[10px] font-semibold">
      <span className="inline-flex items-center gap-1"><i className={`h-2 w-2 rounded-full ${dot[gpsColor]}`} />GPS</span>
      <span className="inline-flex items-center gap-1"><i className={`h-2 w-2 rounded-full ${online ? dot.green : dot.red}`} />{online ? 'Online' : 'Sin conexión'}</span>
      <span className="inline-flex items-center gap-1"><i className={`h-2 w-2 rounded-full ${pendingSync ? dot.amber : dot.green}`} />{pendingSync ? `${pendingSync} pendientes` : 'Sincronizado'}</span>
    </div>
  </header>
}
