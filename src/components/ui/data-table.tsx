'use client'
import { useEffect, useRef, type ComponentProps } from 'react'
import styles from './data-table.module.css'
import { compareCells, nextDirection, type SortDirection } from './table-sort'

type SortState = { column: number; direction: SortDirection }

/** Shared presentation only: each module owns its columns, permissions and data.
 *  `dense`: 38–42 px header and 40–48 px rows for list screens where many records must be visible.
 *  Every column header sorts by click or keyboard (ascending → descending → original order):
 *  - tables with their own sorting (a header with aria-sort), grouped/expandable rows (colspan/rowspan)
 *    or `sortable={false}` keep their order;
 *  - `onSortChange` lets a paginated table sort all its data instead of the visible page;
 *  - a cell may set `data-sort-value` when its visible text is not the right sort key. */
export function DataTable({ className = '', dense = false, sortable = true, onSortChange, ...props }: ComponentProps<'table'> & {
  dense?: boolean; sortable?: boolean; onSortChange?: (sort: SortState | null) => void
}) {
  const ref = useRef<HTMLTableElement>(null)
  const onSortRef = useRef(onSortChange)
  useEffect(() => { onSortRef.current = onSortChange }, [onSortChange])

  useEffect(() => {
    const table = ref.current
    if (!table || !sortable) return
    let teardown: (() => void) | null = null
    let headerSignature: HTMLTableCellElement[] = []
    let sort: SortState | null = null
    let applying = false
    const original = new WeakMap<HTMLTableRowElement, number>()
    let counter = 0

    const setup = () => {
      teardown?.(); teardown = null; sort = null
      const headerRow = table.tHead?.rows.length === 1 ? table.tHead.rows[0] : null
      const headers = headerRow ? Array.from(headerRow.cells) : []
      headerSignature = headers
      // Native sorting already present (aria-sort set by the module) or merged header cells: leave the table untouched
      if (!headers.length || headers.some(th => (th.hasAttribute('aria-sort') && !th.hasAttribute('data-auto-sort')) || th.colSpan > 1)) return
      const bodies = () => Array.from(table.tBodies)
      // Group headers, detail rows and empty states use colspan/rowspan: sorting them would break the layout
      const orderable = () => bodies().every(body => Array.from(body.rows).every(row => row.cells.length === headers.length
        && Array.from(row.cells).every(cell => cell.colSpan === 1 && cell.rowSpan === 1))) && bodies().some(body => body.rows.length > 1)
      const apply = () => {
        if (onSortRef.current || !orderable()) return
        applying = true
        for (const body of bodies()) {
          const rows = Array.from(body.rows)
          rows.forEach(row => { if (!original.has(row)) original.set(row, counter++) })
          const value = (row: HTMLTableRowElement) => { const c = row.cells[sort?.column ?? 0]; return c ? c.dataset.sortValue ?? c.textContent : '' }
          const sorted = [...rows].sort((a, b) => (sort ? compareCells(value(a), value(b), sort.direction) : 0) || (original.get(a) ?? 0) - (original.get(b) ?? 0))
          if (sorted.some((row, index) => row !== rows[index])) sorted.forEach(row => body.appendChild(row))
        }
        applying = false
      }
      const paint = () => {
        const enabled = !!onSortRef.current || orderable()
        table.toggleAttribute('data-sortable', enabled)
        headers.forEach((th, index) => {
          if (!th.hasAttribute('data-auto-sort')) return
          th.setAttribute('aria-sort', sort?.column === index ? sort.direction : 'none')
          th.tabIndex = enabled ? 0 : -1
        })
      }
      const sortBy = (index: number) => {
        if (!onSortRef.current && !orderable()) return
        const direction = nextDirection(sort?.column === index ? sort.direction : null)
        sort = direction ? { column: index, direction } : null
        paint()
        if (onSortRef.current) onSortRef.current(sort)
        else apply()
      }
      const cleanups: (() => void)[] = []
      headers.forEach((th, index) => {
        const label = (th.textContent || '').trim()
        if (!label || /^acci[oó]n(es)?$/i.test(label) || th.querySelector('input, button, select, a')) return
        th.setAttribute('data-auto-sort', '')
        if (!th.title) th.title = `Ordenar por ${label}`
        const click = () => sortBy(index)
        const key = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sortBy(index) } }
        th.addEventListener('click', click); th.addEventListener('keydown', key)
        cleanups.push(() => { th.removeEventListener('click', click); th.removeEventListener('keydown', key); th.removeAttribute('data-auto-sort'); th.removeAttribute('aria-sort'); th.removeAttribute('tabindex') })
      })
      paint()
      teardown = () => { cleanups.forEach(fn => fn()); table.removeAttribute('data-sortable') }
      refresh = () => { paint(); if (sort) apply() }
    }
    let refresh = () => {}
    setup()
    // React keeps updating rows and sometimes columns (refresh, filters): rebuild headers or re-apply the order
    const observer = new MutationObserver(() => {
      if (applying) return
      const headerRow = table.tHead?.rows.length === 1 ? table.tHead.rows[0] : null
      const headers = headerRow ? Array.from(headerRow.cells) : []
      if (headers.length !== headerSignature.length || headers.some((th, index) => th !== headerSignature[index])) { refresh = () => {}; setup() }
      else refresh()
    })
    observer.observe(table, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); teardown?.() }
  }, [sortable])

  return <table ref={ref} {...props} className={`${styles.table} ${dense ? styles.dense : ''} ${className}`} />
}
