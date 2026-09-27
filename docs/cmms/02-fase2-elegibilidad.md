# Fase 2 — Motor central de disponibilidad y elegibilidad

Fecha: 2026-09-26 · Rama: `feat/f2-eligibility-guard`

## Estado

**Implementada y probada en transacción revertida contra la BD de producción.**
**Pendiente de aplicar** (`supabase db push`) y de validar la UI en el navegador.

## Hallazgos que motivaron la fase

| Severidad | Hallazgo |
|---|---|
| Crítico | `mantenimiento/flota/page.tsx` cambiaba `vehicles.status` con un `update` directo, sin motor ni trigger que lo impidiera. |
| Crítico | La firma de 5 argumentos de `transition_vehicle_status` tenía valores por defecto: toda llamada de 3 argumentos (`complete_maintenance_order`, `submit_maintenance_request`, cierre de despacho) fallaba con `42725 function is not unique`. |
| Alto | La última versión de `check_asset_eligibility` (compliance_documents) había perdido los controles de preventivo vencido y bloqueo administrativo, y solo contaba fallas con estado `PENDIENTE`. |
| Alto | Coexistían dos motores (`check_asset_eligibility` y `check_vehicle_eligibility`) con reglas distintas. |
| Alto | La versión de 3 argumentos de `transition_vehicle_status` no validaba permisos y seguía usando `EN_RUTA`, estado eliminado por Flota 360. |
| Alto | La 5 argumentos escribía `vehicles.updated_at`, columna inexistente. |
| Alto (F1) | `20260924133100` convertía los 7 vehículos de producción a `otros` (tipos con tilde/minúscula) y rompía el cruce con tarifas. Corregido con tipos canónicos en mayúsculas. |

## Diseño

- **Motor único:** `check_asset_eligibility(plate, context)` con contextos `RELEASE`, `DISPATCH` y `OPERATION`. Sin `EXCEPTION` silenciosos.
- **Reglas evaluadas:**
  - bloqueo administrativo;
  - OT no `CERRADA`/`CANCELADA` (una OT `TERMINADA` sigue bloqueando);
  - falla crítica abierta;
  - preventivo `VENCIDO` según `vw_maintenance_projections`;
  - SOAT, revisión técnica y póliza de seguro;
  - otros documentos vencidos;
  - odómetro/horómetro;
  - viaje activo;
  - para despacho, que la unidad esté `DISPONIBLE`.
- **Equipos no vehiculares:** montacargas, apiladores y transpaletas no exigen SOAT ni RT; en ellos se controla el horómetro.
- **Resultado:** `APTO`, `APTO_CON_OBSERVACION` o `NO_APTO`, con `motives`, `observations` y `checks`.
- **Adaptadores:** `check_vehicle_eligibility` y `check_dispatch_eligibility` conservan su contrato JSON (`BLOQUEADO`, `blocking_reasons`) y delegan en el motor.
- **Transición única:** `transition_vehicle_status` (5 argumentos, sin defaults; la de 3 delega en ella) aplica, en este orden:
  1. permisos;
  2. máquina de estados de Flota 360;
  3. compuerta de elegibilidad para `DISPONIBLE`, `ASIGNADA` y `EN_OPERACION`;
  4. auditoría en `vehicle_history_logs`.
- **Bloqueo administrativo:** `set_vehicle_administrative_block` requiere motivo, queda auditado y pasa la unidad a `BLOQUEADA`.
- **Guard `trg_guard_vehicle_status`:**
  - los roles `authenticated`/`anon` no pueden cambiar `status`, `is_blocked` ni `block_reason`;
  - todo alta desde el cliente entra como `OBSERVADA`;
  - las funciones `SECURITY DEFINER` (flujos del servidor) no se ven afectadas.
- **UI Flota:** acciones Liberar, Enviar a mantenimiento, Bloqueo administrativo y Fuera de servicio vía RPC, mostrando los motivos del motor.

## Pruebas

`supabase/tests/f2_motor_elegibilidad.test.sql` — **19/19 PASS**

| # | Caso | Resultado esperado |
|---|---|---|
| T1 | Unidad con documentos vigentes | Se libera |
| T2 | SOAT vencido | `NO_APTO` |
| T3 | OT cerrada + SOAT vencido (caso del plan) | `NO_APTO` |
| T4 | OT abierta | Bloquea la liberación |
| T5 | OT en `TERMINADA` | Bloquea |
| T6 | OT cerrada | Deja de bloquear |
| T7 | Falla crítica con o sin tilde | Bloquea |
| T8 | Preventivo vencido | Bloquea |
| T9 | Montacargas sin SOAT | Solo observación |
| T10 | Transición inválida | Rechazada |
| T11 | Despacho sobre unidad no `DISPONIBLE` | `BLOQUEADO` |
| T12 | Bloqueo administrativo vía RPC | `BLOQUEADA` y `NO_APTO` |
| T13 | Cambio de estado | Queda en auditoría |
| T14 | Usuario sin permisos intenta liberar | Rechazado |
| T15 | Usuario sin permisos intenta desbloquear | Rechazado |
| T16 | `UPDATE` directo de `status` | Rechazado |
| T17 | `UPDATE` directo de `is_blocked` | Rechazado |
| T18 | `INSERT` directo | Entra como `OBSERVADA` |
| T19 | `anon` ejecuta las RPC de estado | Sin permiso |

`supabase/tests/cmms_regresion.test.sql` — **PASS**: plan → OT → cierre → motor, falla → OT y vistas.

Se ejecutan con la cadena de migraciones pendientes en una transacción que termina en `ROLLBACK`. Una vez aplicadas las migraciones:

```bash
npx supabase db query --linked -f supabase/tests/f2_motor_elegibilidad.test.sql
```

- `tsc --noEmit`: OK.
- `next build`: OK.
- Lint de `flota/page.tsx`: 24 → 22 problemas (todos preexistentes, `any`).

## Observaciones abiertas (no bloquean F2; se tratan en fases siguientes)

1. **T16/T17 no distinguen quién rechazó el `UPDATE`.** Pasan si el estado no cambia, sea por el guard o porque RLS filtró la fila. El guard está verificado por diseño (`current_user`), pero la prueba no aísla la causa.
2. **Cierre de OT (F4).** `complete_maintenance_order` solo libera cuando el resultado es `APTO`; con `APTO_CON_OBSERVACION` la unidad queda en `MANTENIMIENTO`. Esto se unificará en el Gestor de OT.
3. **Cierre de despacho.** Si la unidad es `NO_APTO` al cerrar el despacho, `transition_dispatch_status` ignora el rechazo y la unidad queda en `EN_OPERACION`. Conviene enviarla a `OBSERVADA` automáticamente.
4. **Pendientes de despliegue.** Falta aplicar las migraciones en producción y probar la UI de Flota en el navegador.
