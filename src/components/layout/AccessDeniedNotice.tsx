'use client'
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { toast } from 'sonner'
import { pathLabel } from '@/lib/nav/web-access'

// Aviso cuando el control de acceso devuelve a Inicio a quien abrió por dirección una página sin permiso.
// Se muestra una vez y se limpia la dirección para que no se repita al recargar.
export function AccessDeniedNotice() {
  const pathname = usePathname()
  useEffect(() => {
    const url = new URL(window.location.href)
    const denied = url.searchParams.get('sin_acceso')
    if (!denied) return
    const label = pathLabel(denied)
    toast.warning(`No tienes acceso a ${label ? `«${label}»` : denied}`, {
      description: 'Pide al administrador el permiso de ese módulo para tu rol.',
    })
    url.searchParams.delete('sin_acceso')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  }, [pathname])
  return null
}
