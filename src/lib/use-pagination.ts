'use client'
import { useMemo, useState } from 'react'
import { compareCells, type SortDirection } from '../components/ui/table-sort'

const SIZES = [25, 50, 100]
const storageKey = (key: string) => `tms:pageSize:${key}`
export type PageSort = { column: number; direction: SortDirection }
/** Value shown in header column `column` (header cell index, counting checkbox columns) for `row`. */
export type SortValue<T> = (row: T, column: number) => unknown

function readSize(key: string) {
  try { const n = Number(localStorage.getItem(storageKey(key))); return SIZES.includes(n) ? n : 25 } catch { return 25 }
}

/** Text a cell shows, also through JSX (badges, links), so header sorting matches what the user sees. */
export const cellValue = (node: unknown): string | number | null => {
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) { const parts = node.map(cellValue).filter(v => v != null); return parts.length ? parts.join('').trim() : null }
  if (node && typeof node === 'object' && 'props' in node) return cellValue((node as { props?: { children?: unknown } }).props?.children)
  return null
}

/** Same semantics as DataTable's header sort (compareCells over the cell text); null sort keeps the original order. */
export function sortRows<T>(rows: readonly T[], sort: PageSort | null, sortValue?: SortValue<T>): readonly T[] {
  if (!sort || !sortValue) return rows
  const text = (row: T) => { const v = sortValue(row, sort.column); return v == null ? '' : String(v) }
  return rows.map(row => [row, text(row)] as const).sort((a, b) => compareCells(a[1], b[1], sort.direction)).map(([row]) => row)
}

/** Client-side pagination over an already filtered array. Page size (25/50/100) is remembered per table.
 *  With `sortValue`, pass `onSortChange` to `<DataTable>` so header sorting orders the whole array, not just the page. */
export function usePagination<T>(rows: readonly T[], key: string, sortValue?: SortValue<T>) {
  const [page, setPage] = useState(1)
  const [pageSize, setSize] = useState(() => typeof window === 'undefined' ? 25 : readSize(key))
  const [sort, setSort] = useState<PageSort | null>(null)
  // sortValue is usually an inline lambda: re-sorting each render is cheap for client-side lists
  const sorted = useMemo(() => sortRows(rows, sort, sortValue), [rows, sort, sortValue])
  // No reset when rows change (auto-refreshing lists would jump to page 1): only clamp to the last page
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pages)
  const setPageSize = (size: number) => {
    setSize(size); setPage(1)
    try { localStorage.setItem(storageKey(key), String(size)) } catch { /* private mode */ }
  }
  const onSortChange = sortValue ? (next: PageSort | null) => { setSort(next); setPage(1) } : undefined
  return { pageRows: sorted.slice((current - 1) * pageSize, current * pageSize), page: current, pageSize, setPage, setPageSize, total: rows.length, onSortChange }
}
