'use client'
import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { FindingsView } from '@/components/hallazgos/FindingsView'

export default function HallazgosPage() {
  return <Suspense fallback={<Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />}><FindingsView /></Suspense>
}
