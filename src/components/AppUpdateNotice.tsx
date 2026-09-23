'use client'

import { useCallback, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Download, RefreshCw, X } from 'lucide-react'
import { nativeAppUpdater } from '@/lib/native-app-updater'
import { createClient } from '@/lib/supabase/client'

type Release = {
  id: string
  version: string
  build_number: number | null
  release_notes: string
  mandatory: boolean
  mandatory_after: string | null
  minimum_supported_version: string | null
  minimum_supported_build: number | null
  installer_url: string | null
  artifact_sha256: string | null
}

function validInstallerUrl(value: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch { return null }
}

function belowMinimumVersion(installed: string, minimum: string | null) {
  if (!minimum) return false
  const left = installed.split('.').map(Number)
  const right = minimum.split('.').map(Number)
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] || 0) < (right[index] || 0)) return true
    if ((left[index] || 0) > (right[index] || 0)) return false
  }
  return false
}

export function AppUpdateNotice() {
  const [release, setRelease] = useState<Release | null>(null)
  const [platform, setPlatform] = useState<'web' | 'android'>('web')
  const [current, setCurrent] = useState('')
  const [forced, setForced] = useState(false)
  const [open, setOpen] = useState(false)
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'ready'>('idle')
  const [legacyInstall, setLegacyInstall] = useState(false)
  const [updateError, setUpdateError] = useState('')

  const record = useCallback(async (event: 'offered' | 'downloaded' | 'deferred' | 'install_started' | 'installed' | 'failed',
    item: Release | null, installedVersion: string, buildNumber?: number | null) => {
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      let deviceId = localStorage.getItem('jrm_device_id')
      if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem('jrm_device_id', deviceId) }
      const native = Capacitor.isNativePlatform()
      const device = { userAgent: navigator.userAgent.slice(0, 300), language: navigator.language }
      await Promise.all([
        supabase.from('app_update_events').insert({ user_id: user.id, release_id: item?.id || null,
          installed_version: installedVersion || 'unknown', event, device_id: deviceId,
          platform: native ? 'android' : 'web', build_number: buildNumber ?? null, device }),
        supabase.from('app_installations').upsert({ user_id: user.id, device_id: deviceId,
          platform: native ? 'android' : 'web', installed_version: installedVersion || 'unknown',
          build_number: buildNumber ?? null, device, last_seen_at: new Date().toISOString() },
          { onConflict: 'user_id,device_id' }),
      ])
    } catch { /* La telemetría no debe bloquear una actualización. */ }
  }, [])

  const check = useCallback(async () => {
    try {
      const response = await fetch('/api/app-version', { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      if (Capacitor.isNativePlatform()) {
        // El APK legado (build 3) se publicó antes de incluir @capacitor/app.
        const info = Capacitor.isPluginAvailable('App')
          ? await App.getInfo() : { build: '3', version: '1.0.2' }
        setLegacyInstall(!Capacitor.isPluginAvailable('AppUpdater'))
        const nativeRelease = data.android as Release | null
        if (!nativeRelease || nativeRelease.build_number === null ||
          Number(info.build) >= nativeRelease.build_number) { setRelease(null); return }
        const overdue = nativeRelease.mandatory && (!nativeRelease.mandatory_after ||
          Date.now() >= new Date(nativeRelease.mandatory_after).getTime())
        const required = overdue || (nativeRelease.minimum_supported_build !== null &&
          Number(info.build) < nativeRelease.minimum_supported_build)
        setCurrent(info.version)
        setPlatform('android')
        setRelease(nativeRelease)
        setForced(required)
        const offeredKey = `jrm_update_offered_${nativeRelease.id}_${info.build}`
        if (!localStorage.getItem(offeredKey)) {
          localStorage.setItem(offeredKey, '1')
          void record('offered', nativeRelease, info.version, Number(info.build))
        }
        if (required) setOpen(true)
      } else {
        const installedBuild = document.documentElement.dataset.buildId
        if (!installedBuild || installedBuild === data.webBuildId) { setRelease(null); return }
        const webRelease = data.web as Release | null
        const overdue = webRelease?.mandatory && (!webRelease.mandatory_after ||
          Date.now() >= new Date(webRelease.mandatory_after).getTime())
        setCurrent(installedBuild.slice(0, 8))
        setPlatform('web')
        setRelease(webRelease || {
          id: data.webBuildId, version: data.webVersion, build_number: null,
          release_notes: 'Hay una nueva versión de JRM-TMS.', mandatory: false,
          mandatory_after: null, minimum_supported_version: null, minimum_supported_build: null, installer_url: null,
          artifact_sha256: null,
        })
        const installedVersion = document.documentElement.dataset.appVersion || ''
        const required = Boolean(overdue || belowMinimumVersion(installedVersion, webRelease?.minimum_supported_version || null))
        setForced(required)
        const offeredKey = `jrm_update_offered_${webRelease?.id || data.webBuildId}_${installedBuild}`
        if (!localStorage.getItem(offeredKey)) {
          localStorage.setItem(offeredKey, '1')
          void record('offered', webRelease, installedVersion)
        }
        if (required) setOpen(true)
      }
    } catch { /* Una falla de red no interrumpe la operación. */ }
  }, [record])

  useEffect(() => {
    const initial = window.setTimeout(() => void check(), 0)
    const timer = window.setInterval(() => void check(), 6 * 60 * 60 * 1000)
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [check])

  if (!release) return null
  const installer = validInstallerUrl(release.installer_url)
  const update = async () => {
    if (platform === 'web') {
      void record('install_started', release, current)
      const url = new URL(window.location.href)
      url.searchParams.set('_build', release.id)
      window.location.replace(url.toString())
    } else if (legacyInstall && installer) {
      window.open(installer, '_system')
    } else if (installer && nativeAppUpdater && release.artifact_sha256) {
      try {
        setUpdateError('')
        if (downloadState === 'ready') {
          await record('install_started', release, current)
          await nativeAppUpdater.install()
        } else {
          setDownloadState('downloading')
          await nativeAppUpdater.download({ url: installer, sha256: release.artifact_sha256 })
          setDownloadState('ready')
          await record('downloaded', release, current)
        }
      } catch (error) {
        setUpdateError(error instanceof Error ? error.message : 'No se pudo preparar la actualización.')
        if (downloadState !== 'ready') setDownloadState('idle')
        await record('failed', release, current)
      }
    } else if (installer) {
      window.open(installer, '_system')
    }
  }
  return (
    <div className={forced
      ? 'fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-5'
      : 'fixed bottom-5 left-5 z-[90] max-w-[calc(100vw-2.5rem)]'}>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}
          className="rounded-full bg-[#002855] px-4 py-2 text-sm font-semibold text-white shadow-lg">
          <Download className="mr-2 inline h-4 w-4" /> Nueva versión {release.version}
        </button>
      )}
      {open && (
        <section role={forced ? 'alertdialog' : 'dialog'} aria-label="Actualización de JRM-TMS"
          aria-modal={forced ? true : undefined}
          className="w-96 max-w-full rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#cf152d]">
                {forced ? 'Actualización necesaria' : 'Actualización disponible'}
              </p>
              <h2 className="mt-1 text-lg font-bold">JRM-TMS {release.version}</h2>
              <p className="text-xs text-slate-500">Versión instalada: {current}</p>
            </div>
            {!forced && <button type="button" aria-label="Cerrar" onClick={() => setOpen(false)}><X className="h-5 w-5" /></button>}
          </div>
          <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">{release.release_notes || 'Mejoras de estabilidad y seguridad.'}</p>
          {platform === 'android' && legacyInstall && <p className="mt-3 text-sm text-amber-800">
            Esta instalación usa una firma de prueba. Sincroniza tus tareas pendientes, abre JRM-TMS en Chrome,
            descarga el APK, desinstala la app anterior e instala la nueva. Este cambio de firma se hace una sola vez.
          </p>}
          {platform === 'android' && !installer && <p className="mt-3 text-sm text-red-700">El instalador aún no está publicado. Contacta a soporte.</p>}
          {platform === 'android' && downloadState === 'ready' && <p className="mt-3 text-sm font-semibold text-emerald-700">Descarga verificada y lista para instalar.</p>}
          {updateError && <p className="mt-3 text-sm text-red-700">{updateError}</p>}
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => void update()} disabled={platform === 'android' && (!installer || downloadState === 'downloading')}
              className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              <RefreshCw className="h-4 w-4" /> {platform === 'web' ? 'Recargar ahora' :
                legacyInstall ? 'Abrir descarga' : downloadState === 'downloading' ? 'Descargando...' : downloadState === 'ready' ? 'Instalar ahora' : 'Descargar actualización'}
            </button>
            {!forced && <button type="button" onClick={() => { void record('deferred', release, current); setOpen(false) }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Más tarde</button>}
          </div>
          {forced && <p className="mt-3 text-xs text-slate-500">Guarda tu trabajo antes de actualizar. Si estás en ruta, finaliza la tarea activa.</p>}
        </section>
      )}
    </div>
  )
}
