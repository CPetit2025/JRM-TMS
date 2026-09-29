# F3 · Asistente Documentario (guías de remisión, packing list y Nota de Despacho)

Migración: `supabase/migrations/20260929200000_documentario_f3.sql` · Prueba: `supabase/tests/caja_c9_documentario.test.sql`
Pantalla: **Operación Logística → Documentos de Despacho** (`/despacho/documentos`) · Permiso: `documentario`

## Flujo

1. El Supervisor de Transporte programa la ruta (unidad, conductor, paradas).
2. El despacho aparece en la bandeja del Asistente Documentario, ordenado por hora de salida. En rojo si faltan
   menos de 2 horas y los documentos no están listos.
3. Por cada parada el Asistente carga:
   - **Envío propio:** una o varias **guías de remisión en PDF** (producto terminado, suministros, otros), con serie-número.
   - **Recojo del cliente** (Nota de Salida / unidad EXTERNO): la **Nota de Despacho en PDF**; el cliente trae su propia guía.
   - Opcional: **packing list** (PDF preferido, Excel aceptado) por parada o general del despacho, y otros documentos.
4. Pulsa **Confirmar documentos**: el sistema verifica que cada parada tenga su guía (o Nota de Despacho).
5. Recién entonces la unidad puede salir (iniciar ruta en el app, "Preparar" en Despacho o marcar entregado un recojo).
   Cancelar un despacho programado sigue permitido sin documentos.

## Reemisión

Si después de confirmar cambian la **placa**, el **conductor** o las **paradas**, el despacho pasa a
**"Requiere reemisión"** (con el motivo) y se vuelve a bloquear la salida hasta que el Asistente actualice y confirme.
Anular una guía confirmada también exige confirmar de nuevo. Tras la salida los documentos no se anulan.

## Visibilidad y auditoría

- Despacho y Torre de Control muestran "Documentos pendientes / listos / por reemitir" en los programados.
- La galería de evidencias del despacho incluye las guías, packing list y notas.
- El conductor ve los documentos de su viaje en **Ruta Activa** del app (y el aviso si faltan).
- Cada documento guarda quién y cuándo lo cargó o anuló; la confirmación guarda quién y cuándo.
- Una misma guía (serie-número) no puede registrarse dos veces mientras esté vigente.

## Roles

- Nuevo rol **Asistente Documentario**: `documentario`, `despacho:read`, `torre-control:read`.
- Los roles que ya programaban despachos reciben `documentario` para no frenar la operación actual.
- Solo los despachos programados desde esta versión exigen documentos (`docs_required`); los anteriores siguen igual.

## Corrección incluida

`schedule_dispatch` validaba el flete contra un saldo que ya descontaba la reserva de la solicitud aprobada (F2),
lo que podía rechazar despachos válidos. Ahora esa reserva cuenta como disponible, porque se libera al programar.
