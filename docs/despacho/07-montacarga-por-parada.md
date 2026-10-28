# Montacarga en una parada de la ruta

Al activar el montacarga en **Armar ruta y programar unidad**, se elige el punto de entrega por solicitud y dirección. Si la ruta tiene una sola parada, se selecciona automáticamente. Con varias paradas, se exige elegir una; quitar la parada elegida antes de programar obliga a revisar la selección.

El servicio de proveedor queda vinculado a esa solicitud mediante `route_forklifts.transport_request_id`. El servidor comprueba que pertenece a la ruta. La ficha operativa, el texto para compartir, la liquidación y la nota de servicios identifican el destino; los reportes identifican también su OT. Por ejemplo, en una ruta con A, B y C, elegir B conserva un solo importe de montacarga para B, sin duplicarlo en A o C.

La tarifa, las horas y el importe del montacarga siguen siendo un servicio separado del flete. Esta asociación no crea gastos, pagos, reservas de partida ni líneas de `transport_unloading_costs`, ni reparte ese importe entre las OT de la ruta. La imputación financiera de gastos conserva el procedimiento existente.

Los servicios históricos sin solicitud asociada se muestran como **Servicio general de ruta (histórico)**; no se atribuyen automáticamente a la primera parada.

Si se cancela o reprograma una parada de una ruta aún programada, se retira su montacarga solo cuando no tiene inicio, fin, horas, importe ni liquidación registrados. Se deja un evento de auditoría. Si el servicio ya fue ejecutado o liquidado, la parada no se puede retirar de ese modo. La cancelación completa de la ruta conserva el registro histórico del servicio y permite liberar sus solicitudes.
