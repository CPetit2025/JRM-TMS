'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { FileUp, Lock } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import type { AptSettings } from '@/lib/apt/types'
import { ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { UploadHistory } from '@/components/apt/uploadHistory'
import { CoveragePanel } from '@/components/apt/uploadCoverage'
import { HowItWorks, SettingsPanel } from '@/components/apt/uploadSettings'

// Cargas y parámetros: cobertura, historial y parámetros del modelo FIFO. Los archivos ENTRADA/SALIDA se cargan una sola
// vez en /apt/datos, que alimenta el inventario multi-almacén y este APT clásico (src/lib/inventario/legacy.ts).
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
        <Link href="/apt/datos" className="flex items-center gap-2 rounded-xl border border-[#002855]/20 bg-[#002855]/5 px-4 py-3 text-sm font-semibold text-[#002855] shadow-sm hover:bg-[#002855]/10">
          <FileUp className="h-4 w-4 shrink-0" />
          Cargar el Actualizable Despacho y el Stock Bodega Despacho en «Cargar datos del ERP»: una sola carga alimenta el inventario y este APT clásico.
        </Link>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
          <Lock className="h-4 w-4 shrink-0 text-slate-400" />
          Solo lectura: para cargar archivos o cambiar parámetros se necesita el permiso “APT — Carga diaria ENTRADA/SALIDA y parámetros”.
        </div>
      )}
      <CoveragePanel />
      <UploadHistory />
      <div className="grid gap-4 xl:grid-cols-2">
        {/* La clave fuerza a reiniciar el formulario con los valores guardados tras cada recálculo */}
        <SettingsPanel key={`${data.settings.updated_at}|${data.state.rebuilt_at}`} data={data} canLoad={data.can_load} />
        <HowItWorks />
      </div>
    </div>
  )
}
