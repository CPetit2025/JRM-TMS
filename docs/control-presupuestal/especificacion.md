# Control presupuestal de transporte por OT — especificación para revisión

Estado: **borrador para revisión** (31/10/2026). No hay código. Definición funcional aprobada:
[`docs/intent/control-presupuestal-transporte.md`](../intent/control-presupuestal-transporte.md).

Fuente: revisión del código de `master` (PR #396) y sus migraciones. No se consultó la base de producción; los conteos
reales se obtienen con `supabase/diagnostics/operaciones_fase0.sql` y las consultas de la sección 8.

---

## 1. Resumen

El TMS **ya tiene** la mitad del control presupuestal: una partida por OT (`contract_budgets`), un tope operativo del
80 % que **ya bloquea** al programar, y reservas y consumos del flete y de los servicios especiales. Lo que falta es lo
que hace al control **completo y preventivo**:

1. **Faltan gastos:** combustible, peajes, viáticos y estacionamiento de Caja **no tocan la partida de la OT**.
2. **No hay niveles:** no existe la alerta del 70 %; el bloqueo del 80 % llega **tarde** (también rechaza gastos ya
   ejecutados en Caja o en el cierre) y la excepción actual **sube el porcentaje** de la OT (oculta el sobrecosto).
3. **No hay una vista por OT** de presupuesto / comprometido / ejecutado / consumo %, ni un flujo de desvíos con roles.

Propuesta: **no crear un sistema paralelo**. Se mantiene `contract_budgets` como saldo único, se imputan a la OT los gastos
de Caja que faltan, se separa «comprometer» (bloqueable) de «ejecutar» (nunca bloqueado, genera desvío), se agregan
autorizaciones con niveles y una bandeja de desvíos. El Cierre económico actual se convierte en una pestaña de esa
bandeja y su historial se conserva.

---

## 2. Diagnóstico: qué existe

### 2.1 Partida de la OT

| Elemento | Qué hace hoy | Se reutiliza |
|---|---|---|
| `contract_budgets` (concepto `PARTIDA_TRANSPORTE`) | `allocated_pen`, `reserved_pen` (comprometido), `consumed_pen` (ejecutado), `balance_pen`. La OT raíz agrupa a sus subcontratos (familia). | **Sí, es el saldo único** |
| Disparador `transport_budget_balance` | `saldo = límite operativo − reservado − consumido`; **rechaza cualquier aumento** que deje saldo negativo. | Sí, con cambio (ver R5) |
| `transport_operating_limit` / `transport_operating_pct` | Límite = 80 % de la asignación (configurable por OT o cliente en `transport_margin_overrides`). | Sí; los overrides se reemplazan (D4) |
| Bloqueos actuales | Programar (una OT, mixta, tercero), servicios especiales acordados, agregar servicio a ruta activa, cargos manuales. | Sí |

### 2.2 Compromisos y consumos que ya mueven la partida

| Evento | Movimiento |
|---|---|
| Programar ruta (flete) | + comprometido (por OT en rutas mixtas: `dispatch_request_freight`) |
| Acordar servicio especial | + comprometido (`transport_unloading_costs` PLANIFICADO) |
| Cerrar ruta | comprometido → ejecutado |
| Caja: alquiler de equipo y cuadrilla de estiba | ejecutado (vía `unloading_consume`) |
| Cierre económico (costo final) | ejecutado ± diferencia |
| Cancelar / anular | − comprometido |
| Cargo manual (Registro de Servicios) | + ejecutado |

### 2.3 Brechas

| # | Brecha | Efecto |
|---|---|---|
| B1 | Gastos de Caja **combustible, peaje, viáticos/alimentación, hospedaje, estacionamiento** no se imputan a ninguna OT. `dispatch_expenses` no tiene OT; en rutas mixtas la ruta no tiene OT única. | El gasto real del viaje no aparece en la partida. |
| B2 | No hay alerta del 70 % ni niveles de autorización. | No hay control preventivo. |
| B3 | El tope rechaza también **gastos ya ejecutados** (aprobación de Caja, cierre económico). | Un gasto real puede quedar sin registrar o bloquear la operación. |
| B4 | La excepción (`transport_margin_overrides`) **sube el %** de la OT. | Oculta el sobrecosto (contra la regla fija 3). |
| B5 | Rutas mixtas: el flete se reparte por el **referencial** de cada solicitud, no por peso. | Reparto distinto al aprobado. |
| B6 | Combustible por ruta: hay rendimiento por unidad (`vehicles.expected_km_per_gallon`, respaldo 10 km/gal y precio S/ 16 en `caja_settings`), km estimados y reales por parada; **las cargas no se asocian a una ruta** de forma confiable. | El combustible real por ruta solo es exacto cuando la carga se hace en la ruta. |
| B7 | Peso por solicitud/OT: declarado opcional, por componente (una solicitud puede tener varias OT) o por guía ERP (si la guía está vinculada). | El reparto por peso necesita una regla de respaldo. |
| B8 | No existe marca «la tarifa incluye combustible/peajes». | Riesgo de duplicar flete propio + combustible real. |
| B9 | El indicador de uso actual mezcla bruto y operativo y usa la OT propia, no la familia; el 80 % está fijo en varias pantallas. | Cifras inconsistentes entre pantallas. |
| B10 | `contract_services` (Registro de Servicios) **no es** un libro de compromisos ni de gasto (el flete se registra al programar sin consumir). | No sirve como base del cálculo. |
| B11 | Órdenes de referencia (OC/OS/RQ, sin OT) no tienen partida: tienen un importe autorizado por solicitud, que el cierre puede superar sin control. | Fuera del 80 %; control propio. |

---

## 3. Arquitectura propuesta

Principio: **una sola fuente por dato**. Cada costo vive en su tabla de origen; la imputación a la OT se guarda una vez;
el saldo se mantiene en `contract_budgets`.

```
 Orígenes (existentes)                      Imputación a OT                 Saldo y control
 ─────────────────────                      ───────────────                 ───────────────
 dispatch_request_freight (flete por OT) ─┐
 transport_unloading_costs (servicios)  ──┼─ ya imputados por OT ─────────┐
 contract_services manuales             ──┘                                ├─► contract_budgets (reservado/consumido)
 dispatch_expenses (Caja)  ─────────────► cost_allocations (NUEVA) ────────┤        │
 combustible estimado (km × rendimiento) ─► cost_allocations (NUEVA) ──────┘        ▼
                                                                     ot_budget_position (vista)
                                                                     nivel 70/80/100 · desvíos · autorizaciones
```

### 3.1 Componentes nuevos (mínimos)

| Componente | Para qué | Notas |
|---|---|---|
| `cost_allocations` (tabla) | Imputa a la(s) OT un gasto de Caja o un combustible estimado: origen, OT, monto, base de reparto (DIRECTO/PESO/KM/IGUAL), estado (COMPROMETIDO/EJECUTADO/ANULADO). Clave única (origen, OT): **no se duplica**. | Solo para lo que hoy no tiene imputación (B1, B6). Flete y servicios siguen en sus tablas. |
| `ot_budget_position(contract_id)` (función/vista) | Asignado, límite operativo (80 %), comprometido, ejecutado, consumo %, nivel (NORMAL/ALERTA/BLOQUEO/EXCEDIDO), autorizaciones vigentes. Siempre sobre la **familia** de la OT. | Única cifra para todas las pantallas (B9). |
| `budget_authorizations` (tabla) | Excepción con nivel (80–100 % / >100 % / emergencia), monto máximo, motivo, evidencia, solicitante, recomendación del Jefe, autorización de Gerencia, vigencia, monto usado. | **No cambia** el presupuesto ni el %; permite comprometer por encima del tope hasta su monto (B4). |
| `budget_deviations` (tabla) + historial | Desvíos: gasto sin compromiso, gasto sobre lo acordado (umbral actual), OT sobre el 80 %, gasto sin sustento > N días. Estados: PENDIENTE_SUSTENTO → SUSTENTADO → RECOMENDADO → APROBADO / RECHAZADO. | Reemplaza el flujo de aprobación del Cierre económico. |
| Pantalla **Control presupuestal** (Operación) | Bandeja de excepciones + posición por OT + consulta para Finanzas. | Reemplaza `/despacho/documentos/economico`. |

### 3.2 Cambios a lo existente

| Pieza | Cambio |
|---|---|
| `transport_budget_balance` | Distinguir **comprometer** (sigue bloqueando sobre el límite salvo autorización vigente) de **ejecutar** (nunca bloquea; si excede, crea desvío). |
| Programación (`schedule_route_resources`, mixtas, servicios, agregar servicio) | Antes de reservar: nivel de la OT. 70–80 % avisa; >80 % pide autorización vigente de Gerencia; >100 % pide ampliación. |
| Caja (`review_dispatch_expense` al aprobar) | Imputa el gasto a su(s) OT en `cost_allocations` y a `consumed_pen`. Sin OT identificable: desvío «gasto sin OT». |
| Reparto en rutas mixtas | Base por peso (D3) para costos compartidos; directo para exclusivos. El flete por OT de programación se mantiene como ingresó (no se recalcula hacia atrás). |
| `transport_margin_overrides` | Se deja de usar para excepciones (D4); sus registros quedan como historial. |
| Cierre económico | Sus validaciones de costo final pasan a ser desvíos (sección 6). |

---

## 4. Flujos

**F1 · Programar (preventivo).** El armado de ruta muestra, por cada OT, consumo actual y el que quedaría.
`< 70 %` sigue; `70–80 %` sigue con aviso al Jefe de Distribución; `> 80 %` no confirma sin una autorización vigente de
Gerencia (el Jefe la solicita/recomienda desde el mismo aviso); `> 100 %` no confirma: solicitud de ampliación.

**F2 · Ejecutar (Caja / servicios).** El Supervisor registra el gasto con sustento. Al aprobarse en Caja se imputa a la OT
(directo si es de una OT; prorrateado por peso si es compartido). **Nunca se bloquea.** Si deja la OT sobre su límite o
supera lo acordado: desvío PENDIENTE_SUSTENTO asignado al Supervisor.

**F3 · Cerrar la ruta.** Comprometido → ejecutado (como hoy). El combustible: si hay cargas de la ruta, se usan; si no, el
estimado (km × rendimiento × precio) queda imputado y marcado «estimado» (D2). Lo que coincide con lo acordado dentro del
umbral se cierra solo.

**F4 · Desvío.** Supervisor sustenta (motivo + evidencia) → Jefe recomienda aprobar/rechazar → si toca el margen
protegido, Gerencia decide. Todo queda con usuario, fecha, motivo, monto y evidencia. Aprobar **no** cambia el
presupuesto; rechazar abre la acción correctiva (recupero, ajuste del gasto o reclamo al proveedor).

**F5 · Emergencia.** Programar sin autorización previa con motivo «emergencia» y evidencia: queda autorización pendiente
de regularizar por Gerencia en N horas; el desvío se marca EMERGENCIA.

**F6 · Finanzas.** Consulta (solo lectura) por OT, concepto y período: asignado, comprometido, ejecutado, % y desvíos;
exporta a Excel.

---

## 5. Reglas de negocio

- **R1** Consumo % = (comprometido + ejecutado) / asignado, sobre la familia de la OT. Niveles: <70 NORMAL, 70–80
  ALERTA, >80–100 BLOQUEO, >100 EXCEDIDO. Los cortes 70/80 son configurables solo por jefatura (no por OT).
- **R2** Un compromiso que se ejecuta **se mueve** de comprometido a ejecutado; nunca se suma dos veces.
- **R3** Comprometer por encima del 80 % exige autorización vigente de Gerencia con saldo suficiente; por encima del
  100 %, ampliación presupuestal.
- **R4** Una autorización no modifica asignado, límite ni %; consume su propio monto y queda visible como sobrecosto.
- **R5** Un gasto ejecutado se registra siempre. Si excede: desvío PENDIENTE_SUSTENTO.
- **R6** Imputación: exclusivo → directo; compartido → por peso; sin peso confiable → criterio configurable
  (km por parada, partes iguales). Cada imputación guarda su base.
- **R7** Combustible propio: real cuando la carga pertenece a la ruta; si no, estimado y marcado como tal. No se imputa
  combustible cuando la tarifa del flete lo incluye (D1).
- **R8** Sin duplicados: cada gasto de Caja tiene a lo más una imputación por OT; Caja de alquiler de equipo y estiba sigue
  su vínculo actual con el servicio (no se imputa otra vez); facturas de grifo no se imputan (concilian cargas).
- **R9** Gasto con `is_billable` (recuperable del cliente): se imputa y se marca recuperable; no se descuenta solo.
- **R10** Lo conforme no se revisa: dentro del umbral y con sustento, se cierra automático.
- **R11** Anticipos al conductor no son compromiso de la OT; solo los gastos aprobados.
- **R12** Órdenes de referencia (OC/OS/RQ): fuera del 80 %; su control es el importe autorizado por solicitud, ahora
  también en el cierre (B11).

---

## 6. Migración del Cierre económico

Nada se borra. El Cierre económico se convierte en parte del Control presupuestal:

| Hoy | Después |
|---|---|
| `transport_unloading_costs` (final, estados por ítem), etapas del flete | Se mantienen: son el costo acordado y ejecutado de cada servicio/flete. |
| Validar costo final / Conforme | Igual, pero dentro del umbral se cierra automático (R10). |
| Ítem «Por aprobar» (sobre el umbral) | Desvío tipo «costo final sobre lo acordado», con el flujo F4. |
| `economic_closures`, `economic_closure_events`, `service_cost_events` | **Solo lectura**: pestaña «Historial» de la ruta en el Control presupuestal. |
| `economic_settings` (umbral, días) | Configuración del Control presupuestal. |
| `/despacho/documentos/economico` | Redirige al Control presupuestal (pestaña Rutas). |
| Ítems hoy «Por aprobar» u «Observados» | Se migran como desvíos PENDIENTE_SUSTENTO / RECOMENDADO con su historial. |

Orden: (1) se crea lo nuevo en paralelo y de solo lectura, (2) se valida con Finanzas que las cifras cuadran contra
`contract_budgets`, (3) se activan bloqueos y desvíos, (4) se retira la pantalla anterior.

---

## 7. Decisiones pendientes (necesito tu respuesta)

| # | Decisión | Mi recomendación |
|---|---|---|
| **D1** | Flete **propio** con OT: hoy la OT consume una **tarifa interna**. Si además imputamos combustible/peajes reales, se duplica. ¿Qué consume la OT? | **Presupuestado = tarifa interna** (se compromete al programar); **ejecutado = costos variables reales** de la ruta (combustible real o estimado + peajes + viáticos + estacionamiento) al cerrar, en lugar de la tarifa. Así se ve si la flota propia cuesta más que su tarifa. |
| **D2** | Combustible sin carga en la ruta | Estimado = km reales por parada (o estimados si no hay GPS) × precio / rendimiento de la unidad; marcado «estimado». |
| **D3** | Fuente del peso para repartir | 1) peso de guía ERP vinculada, 2) peso por componente de la solicitud, 3) peso declarado, 4) partes iguales. Se guarda cuál se usó. |
| **D4** | `transport_margin_overrides` (subir el % por OT/cliente) | Dejar de usarlo para excepciones (reemplazado por autorizaciones). Si alguna OT tiene un % pactado distinto, que lo fije la jefatura como presupuesto, no como excepción. |
| **D5** | Tercero: ¿el flete contratado incluye combustible y peajes? | Sí por defecto; un peaje pagado por JRM a un tercero se imputa como gasto extraordinario con sustento. |
| **D6** | Permisos | Nuevos: `control-presupuestal` (ver), `control-presupuestal:recomendar` (Jefe de Distribución), `control-presupuestal:autorizar` (Gerencia). Finanzas solo lectura. |
| **D7** | ¿Imputar hacia atrás? | Solo desde la fecha de activación; lo anterior queda como historial (evita mover partidas cerradas). |

---

## 8. Validación previa con datos reales (solo lectura)

Antes de construir, medir en producción:
1. Gasto de Caja aprobado por tipo en los últimos 90 días y cuánto tiene `dispatch_id` y `transport_request_id`.
2. Rutas con varias OT y cuántas solicitudes tienen peso (declarado, por componente, por guía ERP).
3. Unidades con `expected_km_per_gallon` cargado y rutas con km reales por parada.
4. OT por encima del 70 % y del 80 % de su límite hoy, y uso de `transport_margin_overrides`.

---

## 9. Implementación por etapas (cada una probada y desplegada)

1. **Posición por OT (solo lectura):** `ot_budget_position` + pantalla con niveles y consulta para Finanzas.
2. **Imputación de Caja y combustible:** `cost_allocations`, imputación al aprobar en Caja, combustible estimado al cerrar.
3. **Autorizaciones y bloqueo preventivo:** `budget_authorizations`, niveles en programación, ejecutar nunca bloquea.
4. **Desvíos:** bandeja con flujo Supervisor → Jefe → Gerencia; migración de lo pendiente del Cierre económico.
5. **Retiro del Cierre económico:** redirección, historial de solo lectura, limpieza de pantallas.

## 10. Riesgos

- Imputar Caja a la partida hará subir el consumo de muchas OT de golpe: activar con D7 (desde una fecha) y comunicarlo.
- El reparto por peso depende de la calidad del peso (D3); mostrar siempre la base usada.
- El combustible estimado puede diferir del real: marcarlo y conciliar cuando lleguen las cargas.
- Cambiar el disparador del saldo afecta a toda la operación: pruebas tipo producción con las restricciones reales.
