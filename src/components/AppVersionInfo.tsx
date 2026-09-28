'use client'

import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'

// Versión y fecha/hora de la última actualización (web) y, dentro del APK, la versión instalada.
// Las pantallas del app se actualizan con cada despliegue web; el APK solo cambia si cambia la parte nativa.

const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleString('es-PE', {
  timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—'

export function AppVersionInfo({ className = '' }: { className?: string }) {
  const [apk, setApk] = useState<string | null>(null)

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('App')) return
    App.getInfo().then(info => setApk(`${info.version} (build ${info.build})`)).catch(() => {})
  }, [])

  return (
    <div className={`text-[11px] leading-tight text-slate-400 ${className}`}>
      <p className="font-semibold">Versión {process.env.APP_VERSION} · {String(process.env.APP_BUILD_SHA).slice(0, 7)}</p>
      <p>Actualizado: {fmt(process.env.APP_BUILD_TIME)}</p>
      {apk && <p>App Android instalada: {apk}</p>}
    </div>
  )
}
