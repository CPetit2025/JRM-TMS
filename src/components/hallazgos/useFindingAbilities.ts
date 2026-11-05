'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import type { Abilities } from '@/lib/audit-findings'

/** Permisos de hallazgos del usuario y su id (para saber si es el responsable). */
export function useFindingAbilities(): Abilities & { isLoaded: boolean } {
  const supabase = useMemo(() => createClient(), [])
  const { canWrite, hasAccess, role, isLoaded } = usePermissions()
  const [userId, setUserId] = useState<string | null>(null)
  useEffect(() => { void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id || null)) }, [supabase])
  return { write: canWrite('hallazgos'), validate: hasAccess('hallazgos-validar'), admin: role === 'admin', userId, isLoaded }
}
