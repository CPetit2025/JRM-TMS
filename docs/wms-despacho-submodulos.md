# Despacho WMS: liberación de LPN y reparto desde Packing List

Todas las etapas comparten la misma tarea y los mismos LPN; no duplican inventario.

| Submódulo | Ruta | Acciones |
| --- | --- | --- |
| Picking / packing | `/almacen/picking` | Recoger y consolidar paquetes en LPN lógicos conservando las etiquetas originales. Corregir observaciones y finalizar Picking. |
| Auditoría | `/almacen/auditoria` | Liberar cada LPN conforme y su contenido mientras continúa Picking. Observar, rechazar y registrar evidencia. |
| Packing List | `/almacen/packing-list` | Seleccionar varios LPN liberados, pulsar **Asignar unidad** y elegir UT1, UT2 o placa. Consultar disponibles, asignados por UT, totales y guías. |
| Carga | `/almacen/carga` | Seleccionar UT y escanear sus LPN o las etiquetas originales de sus paquetes; confirmar la carga física. |

## LPN lógico y etiquetas

Consolidar crea el LPN lógico y relaciona sus paquetes. Ya no abre automáticamente la impresión ni registra una impresión inexistente. Un paquete que viaja solo mantiene el código de su etiqueta. Un LPN de varios paquetes se asigna completo a una sola UT. No se reparte su contenido entre unidades sin deshacer/corregir el packing y volver a auditar lo afectado.

Asignar o cambiar de unidad solo cambia el destino del LPN; conserva códigos, etiquetas, cantidades y aprobación. La operación múltiple es atómica: si cualquier LPN no pertenece a la tarea, no está liberado o ya comenzó su carga, no se modifica ninguno.

## Auditoría y documento

El auditor libera LPN, no el Packing List. Lo pendiente, observado o rechazado no es seleccionable para asignación. Puede liberar y el operador puede asignar los LPN conformes mientras continúa Picking. Retirar la aprobación o corregir contenido elimina la asignación del LPN afectado si no comenzó su carga.

El PDF final es una proyección automática: se genera al finalizar Picking si ya están todos los LPN liberados, o al liberar el último LPN después del cierre de Picking. El responsable del documento proviene de Auditoría, aunque quien cierre Picking sea otro usuario. Se conservan las versiones del documento, la invalidación ante cambios y el bloqueo de autoaprobación.

Packing List actualiza de forma segura documentos de tareas anteriores ya conformes, sin volver a liberar LPN ni imprimir etiquetas. La antigua RPC de liberación se conserva para compatibilidad y devuelve el documento vigente sin duplicarlo; no aparece en la nueva interfaz.

El Packing List descargado mantiene el contenido auditado de su versión, sin mezclar asignaciones actuales de UT. Las guías son consultas separadas del reparto actual. El historial de asignaciones se registra como eventos `LPN_UNIT_ASSIGNED`; las guías no constituyen un plan de carga versionado.

## Permisos y compatibilidad

Auditoría libera; packing/carga/supervisión asignan unidades; Picking o lectura solo consultan el reparto. La selección múltiple se valida también en la base, no solo en la pantalla. Carga no edita preparación ni distribución.

Las rutas anteriores `/almacen/plan-carga` y `/almacen/plan-carga/[id]` abren Packing List. No hay otra pantalla para repetir la asignación. Los enlaces de Tareas siguen abriendo Picking. Las pestañas conservan la solicitud.

## Verificación

- `node scripts/test-wms-dispatch-browser.cjs`: Chromium con API local y datos ficticios. Verifica packing sin impresión automática, auditoría en paralelo, selección solo de liberados, asignación múltiple, generación automática del documento, carga por UT, permisos, rutas anteriores y móvil. Guarda capturas en `/workspace/artifacts/despacho-submodulos`.
- `node scripts/test-wms-picking.cjs`: integración SQL local con las migraciones reales: operación atómica, permisos, separación de funciones, documentos automáticos, versiones y etiquetas conservadas.
- `npx next typegen`, `npm run typecheck` y compilación de producción con configuración local de prueba.
