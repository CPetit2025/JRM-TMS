'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bell, BatteryWarning, CheckCircle2, MapPin, Settings, Smartphone } from 'lucide-react'
import { nativeRouteTracker } from '@/lib/native-route-tracker'
import { phoneReadiness, requestLocation, requestNotifications, type PhoneReadiness } from '@/lib/phone-readiness'

// Indicaciones por marca: además de la optimización de Android, estas capas propias detienen apps en segundo plano
const BRAND_TIPS: [RegExp, string][] = [
  [/xiaomi|redmi|poco/i, 'En Xiaomi: Ajustes del app → Ahorro de batería → «Sin restricciones» y activa «Inicio automático».'],
  [/huawei|honor/i, 'En Huawei/Honor: Ajustes → Batería → Inicio de aplicaciones → JRM-TMS → «Gestionar manualmente» y activa todo.'],
  [/samsung/i, 'En Samsung: Ajustes → Batería → Límites de uso en segundo plano → quita JRM-TMS de «Apps en suspensión».'],
  [/oppo|realme|oneplus/i, 'En Oppo/Realme/OnePlus: Ajustes del app → Uso de batería → permite «Actividad en segundo plano» e «Inicio automático».'],
  [/vivo/i, 'En Vivo: Ajustes → Batería → Consumo en segundo plano alto → permite JRM-TMS.'],
  [/motorola|lenovo/i, 'En Motorola: Ajustes del app → Batería → «Sin restricciones».'],
]

const openSettings = () => nativeRouteTracker?.openAppSettings().catch(() => {})

type Step = { key: string; icon: typeof MapPin; title: string; help: string; action: string; run: () => Promise<unknown> | void }

// Lista «Teléfono listo para ruta»: aparece solo en el APK y mientras falte algo para que la ruta no se pierda
export function PhoneReadinessCard() {
  const [ready, setReady] = useState<PhoneReadiness | null>(null)
  const check = useCallback(() => { void phoneReadiness().then(setReady) }, [])

  useEffect(() => {
    check()
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [check])

  if (!ready) return null
  const tip = BRAND_TIPS.find(([pattern]) => pattern.test(ready.manufacturer))?.[1]
  const steps: Step[] = []
  if (ready.location_ok === false) steps.push({ key: 'location', icon: MapPin, title: 'Permite la ubicación',
    help: 'Sin ella no se registra tu recorrido.', action: 'Permitir ubicación',
    run: async () => { if ((await requestLocation())?.location !== 'granted') await openSettings() } })
  if (ready.background_location === false) steps.push({ key: 'background', icon: MapPin, title: 'Ubicación «Permitir todo el tiempo»',
    help: 'Así la ruta sigue con la pantalla apagada y el app se recupera sola. En Ajustes: Permisos → Ubicación → «Permitir todo el tiempo».',
    action: 'Abrir ajustes', run: openSettings })
  if (ready.notifications_ok === false) steps.push({ key: 'notifications', icon: Bell, title: 'Activa las notificaciones',
    help: 'Te avisamos si pierdes señal o si tu ruta deja de enviarse.', action: 'Permitir notificaciones',
    run: async () => { if ((await requestNotifications())?.display !== 'granted') await openSettings() } })
  if (ready.battery_exempt === false) steps.push({ key: 'battery', icon: BatteryWarning, title: 'Batería sin restricción',
    help: `Con la pantalla apagada, el ahorro de batería puede pausar el envío de tu ubicación.${tip ? ` ${tip}` : ''}`,
    action: 'Permitir sin restricción', run: () => nativeRouteTracker?.requestBatteryExemption().catch(() => openSettings()) })
  if (!steps.length && !ready.power_save) return null

  return <section role="status" className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
    <p className="flex items-start gap-2 font-bold"><Smartphone className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      {steps.length ? `Deja tu teléfono listo para la ruta (${steps.length} paso${steps.length > 1 ? 's' : ''})` : 'El ahorro de batería está activo'}</p>
    {steps.length > 0 ? <ol className="space-y-3">{steps.map(({ key, icon: Icon, title, help, action, run }) =>
      <li key={key} className="rounded-xl border border-amber-200 bg-white p-3">
        <p className="flex items-center gap-2 font-semibold"><Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{title}</p>
        <p className="mt-1 text-xs text-amber-900">{help}</p>
        <button type="button" onClick={() => void Promise.resolve(run()).finally(check)}
          className="mt-2 min-h-11 rounded-xl bg-[#002855] px-4 font-semibold text-white">{action}</button>
      </li>)}</ol>
      : <p>Con el ahorro de batería activo el teléfono puede retrasar el envío de tu ubicación. Desactívalo durante la ruta.</p>}
    <p className="flex items-center gap-1 text-xs text-amber-800"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Al terminar, esta tarjeta desaparece sola.
      <button type="button" onClick={() => void openSettings()} className="ml-auto inline-flex items-center gap-1 font-semibold underline"><Settings className="h-3.5 w-3.5" aria-hidden="true" />Ajustes del app</button></p>
  </section>
}
