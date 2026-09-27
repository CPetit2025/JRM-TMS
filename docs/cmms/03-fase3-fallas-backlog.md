# Fase 3 — Solicitudes, fallas y backlog

Fecha: 2026-09-27 · Migración: `20260927100000_f3_fallas_backlog.sql`

## Hallazgos corregidos

| Severidad | Hallazgo |
|---|---|
| Crítico | Dos fuentes de verdad: el dashboard, el banner y la IA leían `vehicle_failures`; la App, el backlog y las inspecciones usaban `maintenance_requests`. |
| Crítico | `chk_maintenance_requests_severity` exigía `'CRÍTICA'` (con tilde) y la App envía `'CRITICA'`: todo reporte crítico era rechazado. |
| Crítico | `submit_maintenance_request` escribía `vehicles.updated_at` (inexistente): el reporte de fallas de la App fallaba siempre. |
| Crítico | `submit_pre_route_checklist` escribía `dispatches.start_odometer` (inexistente): el checklist pre-ruta fallaba siempre. |
| Crítico | RLS debilitado: cualquier usuario autenticado veía todas las solicitudes. |
| Alto | `has_tms_permission('mantenimiento')` no coincide con ningún permiso real (los roles usan `mantenimiento-fallas`, `-ot`, `-flota`…): solo el Administrador pasaba. Afectaba a RLS, F2 (liberar/bloquear) y al backlog. |
| Alto | `ai_confirm_maintenance` creaba OT con estado `PENDIENTE`, inválido desde F4: la acción de mantenimiento del Copiloto fallaba. |
| Medio | La App subía audio y el dato "¿puede continuar?", pero no se enviaban a la BD. |

## Implementado

- **Fuente única:** se elimina `vehicle_failures`, que estaba vacía y sin funciones dependientes. Toda anomalía vive en `maintenance_requests`.
- **Vocabulario canónico:**
  - Criticidad: `CRITICA`, `ALTA`, `MEDIA`, `BAJA`.
  - Estados: `REPORTADA`, `VALIDADA`, `DIAGNOSTICADA`, `PROGRAMADA`, `CONVERTIDA_OT`, `CERRADA`, `DESCARTADA`.
  - Orígenes: `APP_CONDUCTOR`, `SUPERVISOR`, `INSPECCION`, `MANTENIMIENTO`, `COPILOTO_AI`, `TORRE_CONTROL`.
  - Un trigger normaliza las variantes heredadas (`PENDIENTE`, `CRÍTICA`, `CRITICAL`…).
- **Sin duplicados:**
  - Índice único diario por unidad y descripción.
  - Índice único `(source, source_ref_id)`, de modo que cada respuesta de inspección genera una sola solicitud.
  - Los flujos automáticos usan `ON CONFLICT DO NOTHING`.
  - La App recibe `duplicate: true` en vez de un error.
- **Bloqueo automático:** una falla `CRITICA` abierta pasa la unidad a `BLOQUEADA` a través del motor de F2, con auditoría. Cerrar la falla **no** libera la unidad: la liberación exige el motor.
- **Ciclo de vida controlado:**
  - `transition_maintenance_request` exige diagnóstico, fecha programada o motivo de descarte según el estado destino.
  - `convert_request_to_wo` es idempotente y crea la OT con origen `FALLA` y tipo `EMERGENCIA` o `CORRECTIVA`.
  - Al cerrar la OT se cierra la solicitud; al cancelarla, la solicitud vuelve al backlog.
- **Backlog (`vw_maintenance_backlog`, `security_invoker`):**
  - Antigüedad en días y por rango, calculada con fecha de Lima.
  - Impacto (`BLOQUEA_ACTIVO`, `RIESGO_OPERATIVO`, `SIN_IMPACTO_INMEDIATO`) y puntaje de prioridad.
  - Responsable (`assigned_to`), conductor y OT vinculada.
- **RLS:**
  - Lectura por sede con `mantenimiento-fallas`.
  - El conductor ve solo sus propios reportes.
  - Torre de Control ve las fallas críticas.
  - El estado solo cambia vía RPC: hay un guard para clientes directos.
- **Permisos:** `has_cmms_permission(area)` y `can_manage_fleet_status()` usan las claves reales. Se aplican también a `transition_vehicle_status` y `set_vehicle_administrative_block`.
- **App:** `submit_maintenance_request_v2` guarda audio, "¿puede continuar?", horómetro y fotos adicionales. La firma v1 se conserva para los APK ya instalados.
- **Copiloto AI:** un correctivo genera una solicitud en el backlog; un preventivo genera una OT en `BORRADOR`.
- **UI:**
  - Backlog: KPIs, filtros, acciones Validar, Diagnosticar, Programar, Convertir y Descartar, y alta manual con origen.
  - Dashboard, banner e IA leen el backlog unificado.

## Pruebas

`supabase/tests/f3_fallas_backlog.test.sql` — **16/16 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Reporte desde la App | Se normaliza criticidad, estado, origen y sede |
| T2 | Falla crítica | La unidad queda `BLOQUEADA`, con auditoría y odómetro actualizado |
| T3 | Mismo reporte el mismo día | No se duplica |
| T4 | Ciclo de vida | La transición inválida se rechaza |
| T5 | Requisitos por estado | Diagnóstico, fecha programada y motivo de descarte obligatorios |
| T6 | Vista de backlog | Muestra antigüedad, impacto, prioridad y responsable |
| T7 | Conversión a OT | Idempotente y trazable |
| T8 | OT cancelada / cerrada | La solicitud vuelve al backlog / se cierra |
| T9 | Cierre de la falla | No libera la unidad |
| T10 | Inspección con respuesta crítica | Genera una sola solicitud, bloquea y marca la inspección `FAILED` |
| T11 | Copiloto AI | Correctivo → solicitud; preventivo → OT |
| T12 | Permisos por rol real | Supervisor de Transporte vs Conductor |
| T13 | Usuario sin permisos | No gestiona ni convierte |
| T14 | RLS de lectura | Usuario sin permisos no ve solicitudes |
| T15 | Guard de cliente | Cambio directo de estado rechazado; `INSERT` normalizado |
| T16 | Fuente única | `vehicle_failures` eliminada; existe `start_odometer` |

Regresión: F2 19/19 y `cmms_regresion` PASS con F3 aplicada. `tsc` y `next build` OK. Lint de los archivos tocados sin errores nuevos.

## Observaciones

- **Neumáticos (F8).** `check_tire_tread_depth` usa columnas de otro esquema (`tipo_movimiento`, `cocada`). Se corrige en F8.
- **APK instalados.** Usarán la firma v1 hasta que se publique un APK nuevo, que usa v2 (audio y "¿puede continuar?").
