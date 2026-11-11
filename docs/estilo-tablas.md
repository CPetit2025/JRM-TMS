# Estilo de tablas y paginación

Regla: toda lista en `src/app/(dashboard)` usa `DataTable` (`dense` en listas) y, al pie de la misma tarjeta,
`TablePagination` (25/50/100) alimentada por `usePagination`. El orden se calcula sobre todas las filas
(`sortValue` → `onSortChange`), no solo sobre la página visible.

`npm run check:guards` falla si una página nueva del panel escribe `<table>` directamente
(las excepciones existentes están listadas en `scripts/check-release-guards.cjs`).

```tsx
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'

const pg = usePagination(rows, 'mi-lista', (row, col) => row[col])

<div className="overflow-x-auto">
  <DataTable dense onSortChange={pg.onSortChange}>
    <thead><tr><th scope="col">Código</th></tr></thead>
    <tbody>{pg.pageRows.map(r => <tr key={r.id}><td>{r.code}</td></tr>)}</tbody>
  </DataTable>
</div>
<TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize}
  onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="registros" />
```
