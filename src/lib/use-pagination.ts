'use client'

import { useEffect, useMemo, useState } from 'react'

const SIZES = [25, 50, 100]

/** Client-side pagination over an already filtered/sorted array; page size remembered per table. */
export function usePagination<T>(rows: T[], key: string) {
  const storageKey = `page-size:${key}`
  const [page, setPage] = useState(1)
  const [pageSize, setSize] = useState(25)
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey))
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (SIZES.includes(saved)) setSize(saved)
    } catch { /* storage blocked */ }
  }, [storageKey])
  // Sin volver a la página 1 cuando cambia la cantidad: las listas se refrescan solas; la página solo se ajusta al máximo.
  const total = rows.length
  const current = Math.min(page, Math.max(1, Math.ceil(total / pageSize)))
  const pageRows = useMemo(() => rows.slice((current - 1) * pageSize, current * pageSize), [rows, current, pageSize])
  const setPageSize = (size: number) => {
    setSize(size); setPage(1)
    try { localStorage.setItem(storageKey, String(size)) } catch { /* storage blocked */ }
  }
  return { pageRows, page: current, pageSize, setPage, setPageSize, total }
}
