# Modalidad de atención desde la solicitud

La solicitud define Transporte gestionado por JRM o Recojo por el cliente. El armado de ruta hereda esa modalidad; no puede cambiarla ni mezclar modalidades, sedes internas u OT. El recojo genera Nota de Salida con flete JRM cero, sin conductor propio ni distancia GPS ficticia.

| Regla | Área OT / Administración de Contratos | Otras áreas |
|---|---|---|
| OT en la solicitud | Obligatoria, activa y asignada al usuario | Opcional al registrar |
| Modalidad | Transporte JRM o Recojo por el cliente | Igual |
| Costos a cargo de JRM | Partida de la OT | Debe vincularse una OT antes de aprobar y programar gastos |
| Recojo sin gastos JRM | Puede aprobarse aunque la OT no tenga partida de transporte | Puede registrarse, aprobarse y programarse sin OT |

El formulario no solicita Sede de atención ni Centro de costo. La sede permanece únicamente como alcance interno de acceso: se hereda de la OT, de la solicitud al editar, o de la sede principal autorizada / acceso de sedes del usuario. Nunca se asigna una sede fuera de su autorización.

Cliente que recoge, Contacto autorizado y Teléfono del contacto son opcionales en esta etapa. Su ausencia no impide guardar, aprobar o programar un recojo. Los datos existentes se conservan cuando la API los omite al editar.

Los gastos de transporte se imputan a una OT, sin aprobación directa por centro de costo. Otras áreas pueden registrar un transporte sin OT: si el tarifario determina gastos JRM, queda observado con «Vincule una OT para financiar los costos a cargo de JRM». Al vincular una OT con saldo suficiente, pasa nuevamente a aprobación. El recojo elimina solo el flete: los recursos adicionales pagados por JRM, como descarga, conservan sus costos y requieren partida OT.

Cambiar una solicitud aprobada libera su reserva y exige nueva aprobación. Una solicitud asignada debe retirarse del despacho antes de editar su modalidad o financiamiento. Se mantienen auditoría, columnas e historia de servicios ejecutados. RT-000006 / OT 16523 ya fue corregida según la confirmación expresa del dueño; no se reclasifican otros casos históricos automáticamente.

Implementación: `20261007140000_request_attention_mode.sql` y la migración posterior `20261007150000_request_optional_pickup_details.sql`. No se modifica una migración aplicada. El guardado atómico aplica modalidad, tarifa y descarga conjuntamente; las validaciones de aprobación y programación también se ejecutan en el servidor y cubren escrituras directas.

Validación: `node scripts/test-request-attention.cjs` ejecuta las funciones reales en PostgreSQL aislado con restricciones tipo producción. Cubre registro sin datos de retiro/sede/CC, OT según área, alcance de sedes, financiamiento OT, costos adicionales, cambio de modalidad y rollback. `caja_c45_solicitud_recojo_cliente.test.sql` prueba guardado, aprobación y programación en la base real con ROLLBACK.
