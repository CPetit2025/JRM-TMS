'use client'
import { useState } from 'react'

const SIZES = [25, 50, 100]
const storageKey = (key: string) => `tms:pageSize:${key}`

function readSize(key: string) {
  try { const n = Number(localStorage.getItem(storageKey(key))); return SIZES.includes(n) ? n : 25 } catch { return 25 }
}

/** Client-side pagination over an already filtered/sorted array. Page size (25/50/100) is remembered per table.
 *  Sorting, totals and exports keep using the full array; only `pageRows` is rendered. */
export function usePagination<T>(rows: readonly T[], key: string) {
  const [page, setPage] = useState(1)
  const [pageSize, setSize] = useState(() => typeof window === 'undefined' ? 25 : readSize(key))
  // No reset when rows change (auto-refreshing lists would jump to page 1): only clamp to the last page
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pages)
  const setPageSize = (size: number) => {
    setSize(size); setPage(1)
    try { localStorage.setItem(storageKey(key), String(size)) } catch { /* private mode */ }
  }
  return { pageRows: rows.slice((current - 1) * pageSize, current * pageSize), page: current, pageSize, setPage, setPageSize, total: rows.length }
}
