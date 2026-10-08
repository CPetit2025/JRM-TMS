# Número de despacho

Desde la migración `20261009070000_dispatch_simple_number.sql` el número de despacho es un correlativo simple:
**10001, 10002, 10003…** (antes: `DESP-AAAAMMDD-XXXXXXXX`).

- **Despachos nuevos**: el número lo asigna la base de datos al registrar el despacho (mayor número existente + 1,
  con un bloqueo para registros simultáneos), sea flota propia, tercero o ruta mixta. Un registro que se revierte
  no consume número, así que la numeración no tiene huecos (migración `20261009090000`). La descripción del flete en el Registro de
  servicios usa el mismo número ("Flete del despacho 10025").
- **Despachos existentes**: se renumeraron en orden de creación a partir de 10001. El código anterior queda en
  `dispatches.legacy_dispatch_number` y se puede buscar en Despacho (aparece al pasar el mouse sobre el número)
  y en el asistente JRM IA. Los textos de las tablas vinculadas al despacho (fletes, gastos, eventos) se
  actualizaron al número nuevo.
- Un número escrito a mano con otro formato no se modifica.
- Prueba: `supabase/tests/caja_c60_numero_despacho.test.sql` (C60).
