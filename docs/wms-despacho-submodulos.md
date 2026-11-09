# Despacho WMS por submódulos

Todas las etapas comparten la misma tarea y los mismos LPN; no duplican inventario.

| Submódulo | Ruta | Acciones |
| --- | --- | --- |
| Picking | `/almacen/picking` | Tomar tarea, recoger paquetes, consolidar LPN, imprimir etiquetas y corregir observaciones. Finalizar Picking. |
| Auditoría | `/almacen/auditoria` | Aprobar, observar, rechazar y registrar evidencia por LPN mientras continúa Picking. |
| Packing List | `/almacen/packing-list` | Vista preliminar, consulta y descarga del documento liberado. Liberación exclusiva de auditor/supervisor. |
| Plan de carga | `/almacen/plan-carga` | Crear UT sin placa o con placa, asignar LPN, modificar la distribución y consultar guías por unidad. |
| Carga | `/almacen/carga` | Seleccionar UT, escanear LPN/paquetes y confirmar carga completa o excepción parcial supervisada. |

## Trabajo en paralelo

Un LPN cerrado está disponible para Auditoría aunque Picking siga en curso. Plan de carga también puede distribuir los LPN cerrados durante la preparación. Asignar una UT no aprueba un bulto ni libera su contenido.

La liberación requiere Picking finalizado, ausencia de paquetes sueltos y todos los LPN aprobados. Se mantienen las validaciones de separación de funciones y permisos de la base de datos.

El Packing List siempre se genera a partir de su snapshot liberado, sin mezclar asignaciones actuales de UT. Las guías de carga son consultas separadas de la distribución actual por unidad; todavía no representan un plan versionado. Esta separación no cambia la compatibilidad de carga sin UT del backend existente: hacer obligatoria al menos UT1 y versionar el plan requieren una migración posterior.

## Permisos y compatibilidad

El menú y el middleware usan los mismos permisos de etapa. Picking no presenta controles de UT/carga; Plan de carga no permite escanear Picking ni aprobar auditoría; Carga no permite editar la preparación o la distribución. Los permisos de lectura de Packing List no autorizan su liberación.

Los enlaces anteriores `/almacen/tareas` y `/almacen/tareas/[id]` siguen funcionando mediante redirección a Picking. Las rutas móviles de picking, packing y carga llevan al submódulo correspondiente. Las pestañas conservan la tarea elegida.

## Verificación

- `node scripts/test-wms-dispatch-browser.cjs`: Chromium con API local simulada, datos ficticios y sin operaciones reales. Recorre las etapas, auditoría en paralelo, liberación posterior a Picking, selección de UT, permisos, enlaces antiguos y pantalla móvil. Guarda capturas en `/workspace/artifacts/despacho-submodulos`.
- `node scripts/test-wms-picking.cjs`: integración SQL local que valida las reglas reales de auditoría, liberación y unidades.
- `npx next typegen` y `npm run typecheck`.
