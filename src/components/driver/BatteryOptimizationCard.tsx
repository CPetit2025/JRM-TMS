'use client'

import { useEffect, useState } from 'react'
import { BatteryWarning, Settings } from 'lucide-react'
import { nativeRouteTracker, type NativeBatteryStatus } from '@/lib/native-route-tracker'

// Indicaciones por marca: además de la optimización de Android, estas capas propias detienen apps en segundo plano
const BRAND_TIPS: [RegExp, string][] = [
  [/xiaomi|redmi|poco/i, 'En Xiaomi: Ajustes del app → Ahorro de batería → «Sin restricciones» y activa «Inicio automático».'],
  [/huawei|honor/i, 'En Huawei/Honor: Ajustes → Batería → Inicio de aplicaciones → JRM-TMS → «Gestionar manualmente» y activa todo.'],
  [/samsung/i, 'En Samsung: Ajustes → Batería → Límites de uso en segundo plano → quita JRM-TMS de «Apps en suspensión».'],
  [/oppo|realme|oneplus/i, 'En Oppo/Realme/OnePlus: Ajustes del app → Uso de batería → permite «Actividad en segundo plano» e «Inicio automático».'],
  [/vivo/i, 'En Vivo: Ajustes → Batería → Consumo en segundo plano alto → permite JRM-TMS.'],
  [/motorola|lenovo/i, 'En Motorola: Ajustes del app → Batería → «Sin restricciones».'],
]

// Aparece solo en el APK con seguimiento nativo y mientras el teléfono pueda suspender el envío de la ubicación
export function BatteryOptimizationCard() {
  const [status, setStatus] = useState<NativeBatteryStatus | null>(null)

  useEffect(() => {
    if (!nativeRouteTracker) return
    let cancelled = false
    const check = () => { void nativeRouteTracker!.batteryStatus().then(value => { if (!cancelled) setStatus(value) }).catch(() => {}) }
    check()
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  if (!nativeRouteTracker || !status || (status.exempt && !status.powerSave)) return null
  const tip = BRAND_TIPS.find(([pattern]) => pattern.test(status.manufacturer))?.[1]

  return <section role="status" className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
    <p className="flex items-start gap-2 font-bold"><BatteryWarning className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      {status.exempt ? 'El ahorro de batería está activo' : 'Tu teléfono puede detener el envío de tu ubicación'}</p>
    <p>{status.exempt
      ? 'Con el ahorro de batería activo el teléfono puede retrasar el envío de tu ubicación. Desactívalo durante la ruta.'
      : 'Con la pantalla apagada, la optimización de batería puede pausar el seguimiento de la ruta y el monitor te verá desconectado. Permite que JRM-TMS funcione sin restricción.'}</p>
    {tip && <p className="text-xs text-amber-900">{tip}</p>}
    <div className="flex flex-wrap gap-2">
      {!status.exempt && <button type="button" onClick={() => void nativeRouteTracker!.requestBatteryExemption().catch(() => {})}
        className="min-h-11 rounded-xl bg-[#002855] px-4 font-semibold text-white">Permitir sin restricción</button>}
      <button type="button" onClick={() => void nativeRouteTracker!.openAppSettings().catch(() => {})}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-300 bg-white px-4 font-semibold text-amber-950"><Settings className="h-4 w-4" />Ajustes del app</button>
    </div>
    <p className="text-xs text-amber-800">En Ajustes del app revisa también Ubicación → «Permitir todo el tiempo».</p>
  </section>
}
