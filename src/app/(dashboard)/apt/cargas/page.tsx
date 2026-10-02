'use client'

import { useCallback, useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import type { AptSettings } from '@/lib/apt/types'
import { ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { UploadPanel } from '@/components/apt/uploadPanel'
import { UploadHistory } from '@/components/apt/uploadHistory'
import { HowItWorks, SettingsPanel } from '@/components/apt/uploadSettings'

// Cargas y parámetros: carga diaria de ENTRADA/SALIDA, historial y parámetros del modelo FIFO
export default function AptCargasPage() {
  const [data, setData] = useState<AptSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    aptApi.settings().then(d => { setData(d); setError(null) }).catch(e => setError(e instanceof Error ? e.message : 'No se pudieron leer los parámetros'))
  }, [])

  useEffect(() => {
    load()
    window.addEventListener('apt:updated', load)
    return () => window.removeEventListener('apt:updated', load)
  }, [load])

  if (error && !data) return <ErrorBlock message={error} onRetry={() => { setError(null); load() }} />
  if (!data) return <LoadingBlock label="Cargando parámetros…" />

  return (
    <div className="space-y-4">
      {data.can_load ? (
        <UploadPanel state={data.state} />
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
          <Lock className="h-4 w-4 shrink-0 text-slate-400" />
          Solo lectura: para cargar archivos o cambiar parámetros se necesita el permiso “APT — Carga diaria ENTRADA/SALIDA y parámetros”.
        </div>
      )}
      <UploadHistory />
      <div className="grid gap-4 xl:grid-cols-2">
        {/* La clave fuerza a reiniciar el formulario con los valores guardados tras cada recálculo */}
        <SettingsPanel key={`${data.settings.updated_at}|${data.state.rebuilt_at}`} data={data} canLoad={data.can_load} />
        <HowItWorks />
      </div>
    </div>
  )
}
