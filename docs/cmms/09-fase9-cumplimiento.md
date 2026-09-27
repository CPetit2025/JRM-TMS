# Fase 9 — Cumplimiento vehicular

Fecha: 2026-09-28 · Migración: `20260928090000_f9_cumplimiento.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | Documentos de unidades y conductores visibles para **todos** los usuarios (`USING (true)`), y escribibles solo por el Administrador (permiso inexistente `mantenimiento`). |
| Alto | Dos fuentes para SOAT/RT: los campos del vehículo y `vehicle_documents`. |
| Alto | No existían multas, papeletas ni siniestros. |
| Alto | La elegibilidad del conductor no consideraba un conductor inactivo ni las licencias especiales. |
| Alto | Fallas, inspecciones y cumplimiento no estaban en el menú lateral (pantallas inaccesibles). |

## Implementado

- **Documentos de unidad como fuente única:**
  - Tipos: SOAT, revisión técnica, póliza, tarjeta de propiedad, permisos y certificados (habilitación, MATPEL, GNV).
  - Una renovación desactiva el documento anterior.
  - SOAT/RT del vehículo quedan como **espejo de solo lectura**: las fechas del alta se convierten en documentos y las existentes se migraron.
  - Alimentan el motor de elegibilidad (F2).
- **Documentos del conductor:** licencia, licencia especial, examen médico, MATPEL, SCTR y seguro de vida. La licencia sincroniza la ficha del conductor.
- **`check_driver_eligibility` reescrita:**
  - Bloquea por conductor inactivo, licencia vencida, documento especial vencido o despacho activo.
  - Observa examen médico ausente o vencido, licencia por vencer y multas pendientes del conductor.
- **Multas y papeletas (`traffic_fines`):**
  - Vinculan unidad, conductor y viaje. Si no se indica, **el conductor y el viaje se infieren del despacho vigente a la fecha de la infracción**.
  - Papeleta única por entidad.
  - Estados: `PENDIENTE`, `EN_REVISION`, `APELACION`, `PAGADA`, `ANULADA` y `VENCIDA`. El pago exige monto, referencia y responsabilidad; apelar o anular exige sustento.
  - Responsabilidad: `CONDUCTOR`, `EMPRESA`, `TERCERO` o `POR_DETERMINAR`.
  - Vencimiento automático diario con `pg_cron`.
- **Siniestros e incidentes (`vehicle_incidents`):**
  - Tipos: accidente, siniestro, robo, daño e incidente.
  - Si hay daño a la unidad, se genera **una** falla en el backlog con la misma criticidad; una falla crítica bloquea la unidad por el motor.
  - El cierre exige costo final y responsabilidad.
  - Registra la cobertura del seguro.
- **Sin duplicación entre conductor y Flota 360:** una sola tabla por concepto con `vehicle_id` y `driver_id`. La ficha 360 agrega la pestaña "Multas y siniestros" y los costos de cumplimiento.
- **Alertas unificadas (`vw_compliance_alerts`):** documentos de unidad y de conductor, multas abiertas y siniestros abiertos.
- **Costos (`vw_compliance_costs`):** multas pagadas por la empresa, multas cobradas al conductor, multas pendientes y costo neto de siniestros (costo menos seguro; los de terceros se excluyen). Se integran al TCO en F11.
- **RLS:** lectura por sede y permiso (`mantenimiento-vencimientos`/`flota`). El conductor ve lo suyo. El estado de las multas cambia solo por RPC.
- **UI "Cumplimiento" (`/mantenimiento/documentos`):**
  - Pestañas: Alertas, Documentos de unidades y de conductores (con archivo adjunto), Multas y papeletas (con cambios de estado) y Siniestros e incidentes.
  - Menú lateral con Fallas y Backlog, Inspecciones y Cumplimiento.
  - En el formulario de flota, SOAT/RT quedan de solo lectura al editar.

## Pruebas

`supabase/tests/f9_cumplimiento.test.sql` — **13/13 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Alta del vehículo con SOAT/RT | Se crean los documentos; el espejo es de solo lectura |
| T2 | SOAT por vencer | Alerta `POR_VENCER` y observación del motor |
| T3 | Renovación | Desactiva el anterior y actualiza el espejo |
| T4 | Revisión técnica vencida | `NO_APTO`; no se libera |
| T5 | Conductor | Inactivo bloqueado; licencia sincronizada; MATPEL vencido bloquea |
| T6 | Registro de multa | Infiere viaje y conductor; papeleta única; fuera de plazo entra `VENCIDA` |
| T7 | Estados de la multa | Requisitos por estado; sin cambio directo |
| T8 | Vencimiento diario y costos | Multa vencida automáticamente; costos por activo correctos |
| T9 | Multa pendiente del conductor | Observación en su elegibilidad |
| T10 | Siniestro con daño | Falla `CRITICA` y unidad `BLOQUEADA`; el cierre exige costo y responsabilidad; neto de seguro |
| T11 | Alertas | Unificadas |
| T12 | `pg_cron` | Vencimiento de multas agendado |
| T13 | Usuario sin permisos | No ve ni registra |

Regresión: F1 a F8 y `cmms_regresion` PASS.

## Observaciones

- **Lint del menú lateral.** `sidebar.tsx` define `NavItem` dentro del componente, algo que ya existía. Cada entrada nueva suma un aviso del mismo tipo (37 → 40).
- **Datos en producción.** Ninguna unidad tiene documentos cargados. El motor las declarará `NO_APTO` al intentar liberarlas hasta que se registren SOAT y RT.
