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
    let refresh = () => {}
    // Position of each row in the order React rendered it. Rows React inserts later are placed right before the
    // row React put them in front of (the mutation's nextSibling), so «original order» always matches the screen data.
    const base = new WeakMap<HTMLTableRowElement, number>()
    const isRow = (node: Node | null): node is HTMLTableRowElement => node instanceof HTMLTableRowElement
    const seed = (body: HTMLTableSectionElement) => {
      let last = 0
      for (const row of Array.from(body.rows)) { if (base.has(row)) last = Math.max(last, base.get(row)!); else base.set(row, last += 1) }
    }
    const ingest = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type !== 'childList' || !(record.target instanceof HTMLTableSectionElement) || record.target.tagName !== 'TBODY') continue
        const body = record.target
        let next = record.nextSibling
        while (next && !isRow(next)) next = next.nextSibling
        for (const node of Array.from(record.addedNodes).reverse()) {
          if (!isRow(node)) continue
          const others = Array.from(body.rows).filter(row => row !== node && base.has(row)).map(row => base.get(row)!)
          const upper = isRow(next) && base.has(next) ? base.get(next)! : Infinity
          const lower = Math.max(0, ...others.filter(value => value < upper))
          base.set(node, upper === Infinity ? lower + 1 : (lower + upper) / 2)
          next = node
        }
      }
    }
    const observer = new MutationObserver(records => {
      ingest(records)
      const headerRow = table.tHead?.rows.length === 1 ? table.tHead.rows[0] : null
      const headers = headerRow ? Array.from(headerRow.cells) : []
      if (headers.length !== headerSignature.length || headers.some((th, index) => th !== headerSignature[index])) { refresh = () => {}; setup() }
      else refresh()
    })

    const setup = () => {
      teardown?.(); teardown = null; sort = null
      const headerRow = table.tHead?.rows.length === 1 ? table.tHead.rows[0] : null
      const headers = headerRow ? Array.from(headerRow.cells) : []
      headerSignature = headers
      // Native sorting already present (aria-sort set by the module) or merged header cells: leave the table untouched.
      // A header that is already clickable (its own sort or action) is treated the same way.
      if (!headers.length || headers.some(th => ((th.hasAttribute('aria-sort') || th.classList.contains('cursor-pointer')) && !th.hasAttribute('data-auto-sort')) || th.colSpan > 1)) return
      const bodies = () => Array.from(table.tBodies)
      bodies().forEach(seed)
      // Group headers, detail rows and empty states use colspan/rowspan: sorting them would break the layout
      const orderable = () => bodies().every(body => Array.from(body.rows).every(row => row.cells.length === headers.length
        && Array.from(row.cells).every(cell => cell.colSpan === 1 && cell.rowSpan === 1))) && bodies().some(body => body.rows.length > 1)
      const apply = () => {
        if (onSortRef.current || !orderable()) return
        ingest(observer.takeRecords())
        for (const body of bodies()) {
          seed(body)
          const rows = Array.from(body.rows)
          const value = (row: HTMLTableRowElement) => { const c = row.cells[sort?.column ?? 0]; return c ? c.dataset.sortValue ?? c.textContent : '' }
          const sorted = [...rows].sort((a, b) => (sort ? compareCells(value(a), value(b), sort.direction) : 0) || (base.get(a) ?? 0) - (base.get(b) ?? 0))
          if (sorted.some((row, index) => row !== rows[index])) sorted.forEach(row => body.appendChild(row))
        }
        observer.takeRecords() // our own moves are not React changes
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
        const wasSorted = !!sort
        sort = direction ? { column: index, direction } : null
        paint()
        if (onSortRef.current) onSortRef.current(sort)
        else if (sort || wasSorted) apply()
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
    setup()
    // React keeps updating rows and sometimes columns (refresh, filters): rebuild headers or re-apply the order
    observer.observe(table, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); teardown?.() }
  }, [sortable])

  return <table ref={ref} {...props} className={`${styles.table} ${dense ? styles.dense : ''} ${className}`} />
}
