import type { ComponentProps } from 'react'
import styles from './data-table.module.css'

/** Shared presentation only: each module owns its columns, permissions and data. */
export function DataTable({ className = '', ...props }: ComponentProps<'table'>) {
  return <table {...props} className={`${styles.table} ${className}`} />
}
