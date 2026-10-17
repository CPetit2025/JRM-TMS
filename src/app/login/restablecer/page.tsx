"use client"

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, KeyRound, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type Stage = 'checking' | 'ready' | 'invalid' | 'done'

// Destino del enlace de recuperación. Supabase canjea el código del enlace al cargar el cliente (mismo navegador en
// que se pidió); también acepta el formato token_hash por si la plantilla del correo lo usa. Con la sesión de
// recuperación se fija la nueva contraseña y se cierra la sesión para ingresar con ella.
export default function RestablecerPage() {
  const supabase = useMemo(() => createClient(), [])
  const [stage, setStage] = useState<Stage>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const params = new URLSearchParams(window.location.search)
      const tokenHash = params.get('token_hash')
      if (tokenHash) await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' })
      // getSession espera a que el cliente termine de canjear el código (?code=) o el fragmento (#access_token)
      let { data: { session } } = await supabase.auth.getSession()
      const code = params.get('code')
      if (!session && code) session = (await supabase.auth.exchangeCodeForSession(code)).data.session
      if (cancelled) return
      if (session) window.history.replaceState(null, '', '/login/restablecer')
      setStage(session ? 'ready' : 'invalid')
    })()
    return () => { cancelled = true }
  }, [supabase])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) { toast.error('La contraseña debe tener al menos 8 caracteres'); return }
    if (password !== confirm) { toast.error('Las contraseñas no coinciden'); return }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setSaving(false)
      toast.error(/different|same/i.test(error.message) ? 'La nueva contraseña debe ser distinta de la anterior' : 'No se pudo cambiar la contraseña. Pide un enlace nuevo.')
      return
    }
    await supabase.auth.signOut()
    setSaving(false)
    setStage('done')
  }

  const field = 'min-w-0 w-full px-4 py-3 text-base bg-white text-slate-900 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none'
  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#002855]/10 text-[#002855]"><KeyRound className="h-5 w-5" /></span>
          <div><h1 className="text-xl font-bold text-slate-800">Nueva contraseña</h1><p className="text-sm text-slate-500">JRM · Torre de Control TMS</p></div>
        </div>
        {stage === 'checking' && <p className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Validando el enlace…</p>}
        {stage === 'invalid' && <div className="space-y-4 text-sm text-slate-700">
          <p className="rounded-lg bg-amber-50 p-3 text-amber-900">El enlace venció, ya se usó o se abrió en otro navegador. Pide uno nuevo desde «¿Olvidaste tu contraseña?» y ábrelo en el mismo navegador.</p>
          <Link href="/login" className="block w-full rounded-lg bg-[#002855] px-4 py-3 text-center font-medium text-white">Ir a iniciar sesión</Link>
        </div>}
        {stage === 'ready' && <form onSubmit={save} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">Nueva contraseña
            <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} className={`mt-2 ${field}`} required /></label>
          <label className="block text-sm font-medium text-slate-700">Repite la contraseña
            <input type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} className={`mt-2 ${field}`} required /></label>
          <p className="text-xs text-slate-500">Mínimo 8 caracteres.</p>
          <button type="submit" disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 py-3 font-medium text-white disabled:opacity-70">
            {saving && <Loader2 className="h-5 w-5 animate-spin" />}Guardar contraseña</button>
        </form>}
        {stage === 'done' && <div className="space-y-4 text-sm text-slate-700">
          <p className="flex items-start gap-2 rounded-lg bg-green-50 p-3 text-green-900"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />Contraseña actualizada. Ingresa con tu nueva contraseña.</p>
          <Link href="/login" className="block w-full rounded-lg bg-[#002855] px-4 py-3 text-center font-medium text-white">Ir a iniciar sesión</Link>
          <Link href="/app/login" className="block text-center text-[#002855] hover:underline">Soy conductor: ir al Portal Operativo</Link>
        </div>}
      </div>
    </main>
  )
}
