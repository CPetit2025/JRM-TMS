'use client'
import { useEffect, useMemo, useState } from 'react'
import { NotebookPen } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// Observaciones operativas registradas al programar la ruta (etapa Salida del armado de ruta). Sin observaciones no se muestra.
export function ProgrammingNotes({ dispatchId }: { dispatchId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [notes, setNotes] = useState<{ id: string; text: string | null }>({ id: '', text: null })
  useEffect(() => {
    let alive = true
    void supabase.from('dispatches').select('programming_notes').eq('id', dispatchId).maybeSingle().then(({ data }) => {
      if (alive) setNotes({ id: dispatchId, text: (data as { programming_notes?: string | null } | null)?.programming_notes ?? null })
    })
    return () => { alive = false }
  }, [supabase, dispatchId])
  if (notes.id !== dispatchId || !notes.text) return null
  return <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <NotebookPen className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span><b>Observaciones de la programación:</b> {notes.text}</span>
  </p>
}
