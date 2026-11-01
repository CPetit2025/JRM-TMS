# Circuito económico de transporte

OT → posición presupuestal → movimientos que explican el saldo → ruta, documento u origen → acción para resolver lo pendiente.

Complementa la [especificación del control presupuestal](especificacion.md) (D1–D7, ya aprobada). Implementación:
`supabase/migrations/20261201090000_circuito_economico_movimientos.sql`, pantallas en
`src/app/(dashboard)/despacho/control-presupuestal/` y prueba `scripts/test-budget-movements.cjs` (Caja C203).

## 1. Diagnóstico (Fase 0)

El saldo de una OT vive en `contract_budgets` (`PARTIDA_TRANSPORTE`): `reserved_pen` (comprometido), `consumed_pen`
(ejecutado) y `balance_pen` (disponible operativo, calculado por disparador). **No existe un libro de eventos**: 21
funciones suman y restan directamente sobre esas columnas. Lo que permite explicar el saldo es el estado vigente de las
filas de origen. El inventario se obtuvo de la última definición de cada función en `supabase/migrations`.

### Matriz de fuentes

| Fuente (tabla) | Evento | Efecto en la partida | Pantalla actual | Identificador | Reverso | Permiso |
|---|---|---|---|---|---|---|
| Flete por OT (`dispatch_request_freight`) | Programar ruta (`reserve_mixed_dispatch`), agregar servicio en ruta activa (`add_active_route_service`) | + comprometido (`amount_pen`) | Programación, Registro de Servicios (fila FLETE) | `FLT:<ruta>:<solicitud>` | Cancelar ruta o quitar parada → `LIBERADO`, − comprometido (`settle_…(false)`, `release_mixed_stop_freight`) | despacho |
| ″ | Cerrar ruta (`settle_mixed_dispatch_freight(true)`) | comprometido → ejecutado | Costos por ruta | ″ | — | despacho |
| ″ | Aprobar flete final en Costos por ruta (`economic_apply_item`, `final_applied_pen`) | ± ejecutado (final − tarifa) | Costos por ruta | ″ | Reabrir ítem | cierre-economico |
| ″ | Editar el flete en Registro de Servicios (`update_contract_service_amount`, ruta abierta) | ± comprometido | Registro de Servicios | ″ | Editar de nuevo | contratos-servicios |
| Flete sin detalle por OT (`dispatches.freight_cost`, rutas anteriores a las mixtas) | Programar / cerrar (`close_dispatch_route`) / cancelar (`dispatch_release_on_cancel`) | + comprometido / → ejecutado / − comprometido | Costos por ruta | `DSP:<ruta>` | Cancelación | despacho |
| Servicio especial (`transport_unloading_costs`) | Planificar (`plan_dispatch_unloading`) | + comprometido (`planned_pen`) | Programación | `DSC:<línea>` | Anular (`void_unloading_cost`), quitar parada | despacho |
| ″ | Consumir por Caja (`caja_unloading_expense_sync` → `unloading_consume`) o cierre | − planificado, + ejecutado (`actual_pen`) | Caja, Costos por ruta | ″ | Caja desaprueba → vuelve a planificado | caja / cierre-economico |
| Cargo del Registro de Servicios (`contract_services` sin ruta ni descarga) | `register_contract_service` | + ejecutado | Registro de Servicios | `SRV:<servicio>` | `void_contract_service` (− ejecutado, queda ANULADO) | contratos-servicios |
| Gasto de Caja (`cost_allocations` CAJA) | Aprobar gasto (`budget_expense_sync`) | + ejecutado (tercero o ruta cerrada); PENDIENTE en ruta propia abierta | Caja, Costos por ruta | `IMP:<imputación>` | Desaprobar/corregir → ANULADO, − ejecutado | caja |
| Combustible estimado (`cost_allocations` COMBUSTIBLE_ESTIMADO) | Cierre de ruta propia sin carga real (`budget_route_close`) | + ejecutado (km / km·gal × precio) | Costos por ruta | ″ | Llega la carga real → ANULADO | — (automático) |
| Tarifa propia (`cost_allocations` TARIFA_PROPIA) | Cierre de ruta propia | − ejecutado (revierte el flete) | Costos por ruta | ″ | — | — (automático) |
| Reserva de solicitud (`transport_requests.reserved_pen`) | Esquema anterior a 20261014190000 | + comprometido | — | `SOL:<solicitud>` | Programar o cambiar de estado | — |

**Activación y históricos.** La imputación de Caja/combustible/tarifa propia rige para rutas con salida desde
`economic_settings.budget_imputation_since` (D7). Lo anterior conserva su flete como ejecutado. Saldos cargados antes de
que existieran estas fuentes (o movidos por migraciones de corrección) no tienen fila que los explique: aparecen como
**diferencia de conciliación**, no se recalculan. La prueba C203, que corre en producción después de cada despliegue,
informa cuántas partidas la tienen.

### Hallazgos

1. **Comprometido huérfano al editar el flete de una ruta mixta abierta** (corregido): `update_contract_service_amount`
   ajustaba la reserva y el servicio, pero no el renglón `dispatch_request_freight`. Al cerrar, la ruta consumía el monto
   anterior y la diferencia quedaba comprometida para siempre. Ahora actualiza el renglón. Los casos ya ocurridos
   aparecen como diferencia de conciliación.
2. **Ajuste del flete final en ruta propia** (decisión pendiente, ver §6): el reverso de tarifa propia usa la tarifa
   programada. Si en Costos por ruta se aprueba un flete final distinto para una ruta propia, la diferencia queda en el
   ejecutado de la OT.
3. **Registro de Servicios no es el libro de compromisos**: sus filas FLETE son la representación del flete por OT y sus
   filas de descarga, la de `transport_unloading_costs`. Sumar el Registro y esas fuentes duplica importes. La consulta
   de movimientos toma cada importe una sola vez (el cargo del Registro solo cuando no representa un flete ni una
   descarga).

## 2. Contrato funcional y económico (Fase 1)

| Término | Definición | Dónde |
|---|---|---|
| Asignado | Partida de transporte de la OT raíz (`allocated_pen`) | Resumen |
| Límite operativo / tope | Asignado × % operativo (80 % salvo margen pactado) | Resumen |
| Comprometido | Reservas vigentes: flete de rutas abiertas, servicios planificados y reservas residuales | Resumen, Movimientos |
| Ejecutado | Costos reales: flete de rutas cerradas ± ajuste final, servicios consumidos, cargos, Caja, combustible (real o estimado), menos el reverso de tarifa propia | Resumen, Movimientos |
| Consumo (utilización) | Comprometido + ejecutado sobre asignado | Resumen |
| Disponible | Tope − consumo + autorizado por Gerencia | Resumen, programación |
| Pagado | Fuera de este circuito (Finanzas/Caja). No se mezcla con el ejecutado | — |
| Estimado | Combustible calculado por km; se marca **Estimado** hasta que lo reemplaza la carga real | Movimientos |
| Reverso | Fila que anula o compensa otra: liberado, anulado o tarifa propia. Se muestra; no se borra | Movimientos |
| Ajuste | Diferencia aprobada en Costos por ruta (flete o servicio final distinto del programado) | Movimientos (incluido en el importe del flete) |
| Autorizado sobre el tope | Autorización vigente de Gerencia. No cambia la partida, solo amplía el disponible | Pendientes y autorizaciones |

**Representación común de lectura** (`budget_movements`, una fila por movimiento): identificador estable, fuente,
concepto, OT de referencia y OT que financia, ruta, solicitud, proveedor, origen, fecha, estado, importe,
real/estimado, efecto en comprometido, efecto en ejecutado, reverso, sustento (guía, RUC, gasto de Caja, cálculo del
combustible) y enlace al origen. Se calcula al leer, sin guardar un segundo libro.

**Período.** El ejecutado sí tiene fecha: saldo inicial + movimientos del período = ejecutado al corte. El comprometido
es el estado vigente: el sistema no guarda su historia por fecha, así que no se informa "comprometido al corte".

## 3. Conciliación (Fase 2)

`budget_movements` compara, para la familia de la OT (raíz + subcontratos/errores con partida propia), lo guardado en
`contract_budgets` con lo que explican los movimientos y devuelve la diferencia. Reglas para no contar dos veces:

- El flete se toma de `dispatch_request_freight` (o de la ruta, si es anterior); la fila FLETE del Registro solo enlaza.
- La descarga se toma de `transport_unloading_costs`; su fila del Registro solo enlaza.
- Ruta propia: flete ejecutado + reverso de tarifa propia = 0; quedan Caja y combustible.
- Combustible estimado anulado por la carga real: sin efecto, visible.
- Ruta multi-OT: cada imputación ya trae su parte (peso, partes iguales o directo, con su redondeo). La parte de una
  solicitud sin OT no se carga a ninguna partida.
- Anulados y liberados: efecto cero, visibles como reverso.
- Un movimiento de un contrato sin partida propia se marca **Sin partida** y no entra en lo explicado (su
  actualización no movió ningún saldo).

## 4. Experiencia (Fases 3 y 4)

Control presupuestal tiene cuatro pestañas, sin pantallas nuevas que repitan totales:

1. **Resumen por OT** (sin cambios en las cifras): comprometido y ejecutado abren su composición en Movimientos.
2. **Movimientos**: OT, desde, fecha de corte, efecto y búsqueda, guardados en la dirección (se conservan al ir al
   origen y volver). Posición, ejecutado del período, conciliación y tabla paginada (100 por página) con enlace a
   Costos por ruta o al Registro de Servicios.
3. **Pendientes y autorizaciones**: `budget_pending` (diferencia de conciliación, gasto de Caja sin imputar en ruta
   cerrada, gasto por imputar al cierre, combustible estimado sin reemplazar, cargo manual sin guía ni proveedor ni ruta,
   posible duplicado). Cada uno con causa, importe, antigüedad, quién registró (solo si consta) y acción. Debajo, los
   desvíos y las autorizaciones existentes. No hay un flujo de aprobación nuevo.
4. **Costos por ruta** (antes Cierre económico): sigue siendo la autoridad del costo final; misma dirección.

El Registro de Servicios conserva su función y su dirección. El detalle de cada servicio enlaza a su movimiento en
Control presupuestal. Para la ruta ejecutada enlaza a Costos por ruta.

## 5. Validación (Fase 5)

`scripts/test-budget-movements.cjs` (PGlite, tipo producción) recorre ruta propia con OT; multi-OT con solicitud sin OT;
tercero; servicio especial planificado, consumido y ajustado; gasto de Caja aprobado, corregido y rechazado; combustible
estimado reemplazado por el real; cancelación; ajuste aprobado en Costos por ruta; cargos manuales iguales; histórico
sin rastro; componente de la OT; permisos (sede, lectura, subcontrato que abre su raíz); paginación, filtros y
validaciones; migración aplicada dos veces; edición del flete por OT. En cada paso, la diferencia de conciliación es
cero salvo la histórica, que se expone y no se corrige. `supabase/tests/caja_c203_circuito_economico.test.sql` verifica
la instalación en producción y cuenta las partidas con diferencia, sin modificar datos.

## 6. Limitaciones y decisiones pendientes

- **Ajuste del flete final en ruta propia** (cambia importes): ¿la diferencia aprobada en Costos por ruta debe quedar en
  el ejecutado de la OT, o también revertirse porque el costo de la ruta propia son sus gastos reales (D1)? Mientras
  tanto, queda en el ejecutado y se ve como parte del flete.
- **Diferencias históricas**: se informan por OT. Corregirlas exige un ajuste documentado por partida. No se hace
  ninguna actualización masiva sin decisión explícita y un procedimiento revisable.
- **Comprometido por fecha**: no hay historia. Para tenerla habría que registrar eventos, es decir, un libro, cosa que
  este trabajo evita a propósito.
- **Pagado**: no se concilia aquí (Finanzas).
- Exportar movimientos a Excel no está incluido. La tabla se puede filtrar y paginar.
