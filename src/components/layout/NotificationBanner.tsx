"use client"
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, X } from 'lucide-react'
import { useNotifications } from '@/components/NotificationProvider'

// Franja bajo el encabezado: solo los avisos críticos sin leer de los módulos del usuario (los mismos de la campana,
// ya filtrados por permiso). Antes consultaba fallas, SOAT y licencias para todos los usuarios por igual.
export function NotificationBanner() {
  const { feed, markRead } = useNotifications()
  const router = useRouter()
  const [hidden, setHidden] = useState<number[]>([])

  const alerts = (feed?.items ?? []).filter(n => n.severidad === 'crit' && !n.leida && !hidden.includes(n.id)).slice(0, 3)
  if (alerts.length === 0) return null

  return (
    <div className="z-10 flex w-full shrink-0 items-start justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-2 shadow-sm sm:px-6">
      <ul className="flex min-w-0 flex-1 max-w-5xl flex-col gap-1">
        {alerts.map(a => (
          <li key={a.id} className="flex min-w-0 items-center gap-2 text-sm font-medium text-red-800">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#cf152d]" />
            <span className="min-w-0 truncate">{a.titulo}{a.cuerpo ? ` — ${a.cuerpo}` : ''}</span>
            {a.link && (
              <button type="button" onClick={() => { void markRead([a.id]); router.push(a.link!) }}
                className="flex shrink-0 items-center gap-0.5 text-xs font-bold text-[#002855] hover:text-[#cf152d]">
                Ver <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setHidden(h => [...h, ...alerts.map(a => a.id)])} aria-label="Ocultar"
        className="shrink-0 rounded-full p-1 text-red-700 transition-colors hover:bg-red-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
