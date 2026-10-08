import type { ComponentProps } from 'react'
import styles from './data-table.module.css'

/** Shared presentation only: each module owns its columns, permissions and data.
 *  `dense`: 38–42 px header and 40–48 px rows for list screens where many records must be visible. */
export function DataTable({ className = '', dense = false, ...props }: ComponentProps<'table'> & { dense?: boolean }) {
  return <table {...props} className={`${styles.table} ${dense ? styles.dense : ''} ${className}`} />
}
