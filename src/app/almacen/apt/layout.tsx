'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

const RECEIPT_SOURCE = '/almacen/apt/etiquetado'

export default function AptLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || ''
  const router = useRouter()
  useEffect(() => {
    if (pathname !== RECEIPT_SOURCE) router.replace(RECEIPT_SOURCE)
  }, [pathname, router])
  if (pathname === RECEIPT_SOURCE) return <>{children}</>
  return <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 text-center">
    <h1 className="font-bold text-[#002855]">Inventario multi‑almacén</h1>
    <p className="mt-2 text-sm text-slate-600">Este inventario se gestiona desde TMS. En WMS, los ingresos para etiquetado tienen una fuente independiente.</p>
    <Link href={RECEIPT_SOURCE} className="mt-4 inline-flex rounded-lg bg-[#002855] px-4 py-2 text-sm font-bold text-white">Ir a actualizar ingresos WMS</Link>
  </div>
}
