'use client'

import { useEffect } from 'react'

export function LegacyAiKeyCleanup() {
  useEffect(() => {
    try {
      const stored = localStorage.getItem('jrm_sys_config')
      if (!stored) return
      const settings = JSON.parse(stored) as Record<string, unknown>
      if (!('openAiKey' in settings) && !('geminiKey' in settings) && !('aiProvider' in settings)) return
      delete settings.openAiKey
      delete settings.geminiKey
      delete settings.aiProvider
      localStorage.setItem('jrm_sys_config', JSON.stringify(settings))
    } catch { /* La configuración antigua puede no ser JSON válido. */ }
  }, [])

  return null
}
