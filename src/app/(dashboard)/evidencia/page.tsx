'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, ShieldAlert } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { receiptUrl } from '@/lib/caja'

// Enlace permanente a una evidencia (usado en las exportaciones Excel): exige sesión, firma la URL del
// archivo privado al abrirse y redirige. El permiso lo decide la política del bucket.

function Redirect() {
  const params = useSearchParams()
  const ref = params.get('ref')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!ref) return
    void receiptUrl(createClient(), ref).then(url => { if (url) window.location.replace(url); else setFailed(true) })
  }, [ref])
  if (!ref || failed) return (
    <div className="p-10 text-center text-slate-600">
      <ShieldAlert className="w-8 h-8 mx-auto mb-2 text-amber-500" />
      {ref ? 'No tiene permiso para ver esta evidencia o el archivo ya no existe.' : 'Enlace de evidencia inválido.'}
    </div>
  )
  return <div className="p-10 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>
}

export default function EvidenciaPage() {
  return <Suspense fallback={null}><Redirect /></Suspense>
}
