'use client'

import { useEffect, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { toast } from 'sonner'
import { nativeBiometric } from '@/lib/native-biometric'

export function BiometricSettings() {
  const [status, setStatus] = useState<{ available: boolean; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!nativeBiometric) return
    let active = true
    nativeBiometric.status().then(value => { if (active) setStatus(value) }).catch(() => {})
    return () => { active = false }
  }, [])
  if (!status) return null

  const toggle = async () => {
    if (!nativeBiometric || busy) return
    setBusy(true)
    try {
      await nativeBiometric.configure({ enabled: !status.enabled })
      setStatus(await nativeBiometric.status())
      toast.success(status.enabled ? 'Protección biométrica desactivada' : 'Biometría activada. Tu sesión seguirá abierta y protegida.')
    } catch {
      toast.error('No se cambió la opción. Verifica tu identidad o configura la biometría en los ajustes del teléfono.')
    } finally { setBusy(false) }
  }

  return <div className="mx-auto flex max-w-lg flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs">
    <span className="inline-flex items-center gap-1.5"><Fingerprint className="h-4 w-4" />
      {status.enabled ? 'Sesión protegida con biometría' : 'Mantener sesión · protección biométrica'}
    </span>
    <button type="button" onClick={() => void toggle()} disabled={busy || (!status.available && !status.enabled)}
      className="min-h-11 rounded-lg bg-white/10 px-3 font-semibold disabled:opacity-60"
      aria-pressed={status.enabled}>
      {busy ? 'Verificando…' : status.enabled ? 'Desactivar' : status.available ? 'Activar' : 'Configura huella/rostro en tu teléfono'}
    </button>
  </div>
}
