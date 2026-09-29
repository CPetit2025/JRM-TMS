# F2 · Solicitud observada por partida, reserva al aprobar y roles de Despacho

Migración: `supabase/migrations/20260929190000_solicitud_f2_partida_observada.sql` · Prueba: `supabase/tests/caja_c8_solicitud_partida.test.sql`

## Reglas

1. **Registro siempre permitido.** Si el costo estimado supera el saldo de la partida de transporte del contrato,
   la solicitud se guarda en estado `OBSERVADA` con el faltante (`budget_shortfall`) y el motivo
   (`budget_observation`). No se puede aprobar ni programar mientras siga observada.
2. **Levantamiento automático.** Cuando la partida aumenta (ampliación de `allocated_pen` o liberación de reservas),
   las solicitudes observadas que ya caben vuelven a `PENDIENTE DE APROBACIÓN`.
3. **Reserva al aprobar.** Al pasar a `APROBADA` se reserva el costo en la partida (`reserved_pen`). Si la solicitud
   se rechaza, cancela o vuelve a pendiente, la reserva se libera. Al programarse (`ASIGNADA`) la reserva pasa al
   flete del despacho; se consume al cerrar la ruta (F1).
4. **Programar exige aprobación previa** (`approved_at`).
5. **Roles:**
   - *Supervisor de Despacho* (permiso `despacho-aprobacion`): aprueba, rechaza y reprograma solicitudes.
   - *Supervisor de Transporte* (permiso `despacho`): planifica y asigna unidad, conductor y tripulación.
   - *Administrador de Contratos*: registra/edita solicitudes y también puede reprogramar o cancelar las de sus contratos.
6. **Unidad en ruta:** si el despacho ya salió no se puede cancelar ni reprogramar la solicitud; la partida se
   consume al cerrar la ruta. Si el despacho sigue `PROGRAMADO`, la solicitud se desvincula y, si el despacho queda
   vacío, se cancela liberando la reserva.

Toda transición de estado desde la pantalla pasa por `set_transport_request_status`.
