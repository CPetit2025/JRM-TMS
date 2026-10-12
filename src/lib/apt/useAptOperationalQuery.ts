'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { aptApi, clearAptCache } from './api'
import { isTransientAptReadError, startRecoverableRead } from './readRecovery'
import type { AptOperationalFilters } from './types'

type Result<T> = { identity: string; data: T | null; error: unknown; loading: boolean; retrying: boolean; receivedAt: number | null }

/** A retained result belongs to one authenticated session and one exact query. */
export function useRecoverableAptRead<T>(identity: string | null, read: () => Promise<T>, retryDelay?: number) {
  const [nonce, setNonce] = useState(0)
  const [result, setResult] = useState<Result<T> | null>(null)
  const last = useRef<{ identity: string; data: T; receivedAt: number } | null>(null)
  const cancel = useRef<(() => void) | null>(null)
  const request = useRef(read)
  useEffect(() => { request.current = read }, [read])
  const invalidate = useCallback(() => { cancel.current?.(); last.current = null; setResult(null) }, [])
  const refresh = useCallback(() => { cancel.current?.(); clearAptCache(); setNonce(n => n + 1) }, [])
  useEffect(() => {
    if (!identity) { last.current = null; return }
    if (last.current?.identity !== identity) last.current = null
    const retained = last.current
    const performRead = request.current
    setResult({ identity, data: retained?.data ?? null, error: null, loading: true, retrying: false, receivedAt: retained?.receivedAt ?? null })
    const stop = startRecoverableRead({
      read: performRead, retryDelay,
      onRetry: () => setResult(value => value?.identity === identity ? { ...value, retrying: true } : value),
      onSuccess: data => {
        const receivedAt = Date.now()
        last.current = { identity, data, receivedAt }
        setResult({ identity, data, error: null, loading: false, retrying: false, receivedAt })
      },
      onError: error => {
        if (!isTransientAptReadError(error)) last.current = null
        const previous = last.current
        setResult({ identity, data: previous?.data ?? null, error, loading: false, retrying: false, receivedAt: previous?.receivedAt ?? null })
      },
    })
    cancel.current = stop
    return stop
  }, [identity, nonce, retryDelay])
  const current = identity && result?.identity === identity ? result : null
  return { data: current?.data ?? null, error: current?.error ?? null, loading: !!identity && (!current || current.loading), retrying: current?.retrying ?? false, receivedAt: current?.receivedAt ?? null, refresh, invalidate }
}

export function useAptOperationalQuery(filters: AptOperationalFilters, queryKey: string, size: number, page: number) {
  const [sessionIdentity, setSessionIdentity] = useState<{ user: string | null; epoch: number; checked: boolean }>({ user: null, epoch: 0, checked: false })
  // StrictMode recreates subscriptions; a new auth lifetime must never reuse an identity.
  const authEpoch = useRef(0)
  const identity = sessionIdentity.user ? `${sessionIdentity.user}|${sessionIdentity.epoch}|${queryKey}|${size}|${page}` : null
  const query = useRecoverableAptRead(identity, () => aptApi.operationalSummary(filters, size, (page - 1) * size))
  const invalidate = query.invalidate
  useEffect(() => {
    const client = createClient()
    let active = true, authObserved = false
    let currentUser: string | null | undefined
    const changeSession = (user: string | null, force = false) => {
      if (!active || (currentUser === user && !force)) return
      currentUser = user
      invalidate(); clearAptCache()
      setSessionIdentity({ user, epoch: ++authEpoch.current, checked: true })
    }
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      authObserved = true
      const nextUser = session?.user.id ?? null
      changeSession(nextUser, event === 'SIGNED_OUT')
    })
    void client.auth.getSession().then(({ data: { session } }) => {
      if (active && !authObserved) changeSession(session?.user.id ?? null)
    }).catch(() => { if (active && !authObserved) changeSession(null) })
    return () => { active = false; subscription.unsubscribe() }
  }, [invalidate])
  const refresh = query.refresh
  useEffect(() => {
    const onRefresh = () => refresh()
    window.addEventListener('apt:updated', onRefresh)
    return () => window.removeEventListener('apt:updated', onRefresh)
  }, [refresh])
  return { ...query, key: identity, sessionChecked: sessionIdentity.checked, authenticated: !!sessionIdentity.user, usable: !!query.data && !query.loading && !query.error }
}
