# Despacho F1 · Estados del despacho y partida de transporte

Corrige los hallazgos del análisis Demanda → Operación (migración `20260929180000_despacho_f1_estados_partida.sql`,
prueba `supabase/tests/caja_c7_despacho_estados.test.sql`).

| # | Antes | Ahora |
|---|---|---|
| C1 | `transition_dispatch_status` sin permiso ni sede: cualquier usuario cambiaba despachos | Personal de Despacho/Monitoreo/Torre de la sede; el conductor solo marca hitos de su viaje (en curso, espera de autorización, retorno completado). El autor del cambio es siempre el usuario real. |
| C2 | Cancelar no liberaba nada | `cancel_dispatch` (motivo obligatorio, solo **PROGRAMADO**): libera la reserva de la partida, anula el FLETE y devuelve las solicitudes a **APROBADA** para reprogramarlas. En ruta no se cancela: la partida se consume al cerrar. |
| C3 | "Entregado" no se podía cerrar; LIQUIDADO por transición saltaba el consumo | "Entregado" exige todas las paradas confirmadas en el app y se cierra con **Cerrar ruta** (consume la partida). LIQUIDADO solo por el cierre. |
| C4 | Servicios consumían sin saldo; editar un FLETE reservado movía el consumido | Registrar/editar valida saldo (el Administrador puede exceder para históricos). Un FLETE de despacho abierto ajusta la **reserva** y el flete del despacho. |

La migración recalcula la reserva de cada partida como la suma de fletes de sus despachos abiertos y deja cada
ajuste en `contract_budget_adjustments` (solo lectura para el Administrador).
