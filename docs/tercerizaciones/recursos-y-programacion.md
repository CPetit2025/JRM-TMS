# Gestión de recursos tercerizados

La bandeja `/despacho/tercerizaciones` consulta servicios con paginación de servidor, búsqueda por ST, solicitud, OT, cliente, destino y proveedor; filtros por fecha, servicio, estado y proveedor. Ordena por atención requerida y conserva acceso a solicitudes fuera del antiguo límite de 500 registros. Cada servicio abre su detalle sin abandonar la bandeja.

## Datos y estados

`transport_outsourcing_assignments` relaciona la ficha original, servicio, proveedor, cantidad, especificación de recurso, disponibilidad, cotización, costo confirmado, moneda/tipo de cambio, revisión técnica y despacho. No crea vehículos propios. Reutiliza `suppliers`, `carriers`, `supplier_vehicles`, `supplier_personnel`, solicitudes/OT y el historial inmutable `transport_outsourcing_events`.

Una fila por vehículo o equipo permite dos plataformas de dos proveedores; estibadores pueden registrarse por grupo. Se bloquea toda cantidad superior a lo solicitado. No hay excepción de sobreasignación: debe corregirse y aprobarse la ficha original.

Flujo de asignación: **En gestión → Aprobada → Confirmada → Finalizada**, con cancelación controlada. Compras registra; `compras-aprobar` autoriza; Compras confirma al proveedor. Los cambios de una ficha aún no programada reinician la aprobación. La bandeja calcula pendiente, en gestión, observada, parcial, asignada, confirmada, cancelada y finalizada por servicio. Las etapas/cotizaciones anteriores siguen disponibles como historial; su transición se bloquea cuando existen asignaciones activas para evitar dos vías de gestión sobre el mismo requerimiento.

La ficha admite equipos/personal sin transporte mediante “Requiere transporte”. No exige placa ni conductor para estos recursos. Mantiene la vinculación a solicitud/OT y las condiciones operativas. Cada tipo tiene controles propios; la grúa requiere evaluación documentada de maniobra, no solo capacidad nominal.

## Programación y presupuesto

Un recurso confirmado aparece en Armado de Ruta al seleccionar la solicitud, o mediante “Armar ruta con este recurso”. Se cargan proveedor, unidad, conductor, documentos, licencia, fecha, costo y carga asignada. El servidor vuelve a validar revisión, disponibilidad, pertenencia, permisos y exclusividad; toma datos confirmados sin confiar en el importe enviado por el navegador. La carga individual se conserva aunque la lista de solicitudes se actualice durante la apertura del asistente.

Cada unidad genera su despacho con la misma solicitud original. Una tabla privada, sin permisos de cliente, limita la excepción para una segunda unidad de una solicitud ya asignada exclusivamente al programador y a una asignación confirmada aún disponible. El programador nativo mantiene el control de placa/conductor y presupuesto.

Los apoyos seleccionados se vinculan al despacho y aparecen en su detalle. Sus acuerdos se incorporan con `set_special_service_agreements` y `plan_dispatch_unloading`, reutilizando primero las líneas heredadas. Se comprueba el resultado y se revierte la programación completa si falla el acuerdo. No se reserva al cotizar/aprobar/confirmar. El cierre/costo real conserva el circuito existente y no crea un segundo compromiso desde este módulo.

## Cambios y seguridad

RLS de lectura por solicitud/sede y cuenta activa; sin INSERT/UPDATE/DELETE de cliente. RPC de escritura con permisos, bloqueo de filas, revisión y versión optimista. La confirmación toma bloqueos transaccionales por identidad de equipo/persona y rechaza horarios superpuestos y vehículos propios.

Un recurso programado solo se rectifica con permisos conjuntos de Compras y Supervisor de Transporte, confirmación explícita del despacho afectado y motivo. Solo mientras está PROGRAMADO; actualiza el recurso y el despacho atómicamente y deja auditoría en ambos. No cambia proveedor, cantidad, período ni costo por esta vía; para ello se cancela/reprograma con el flujo nativo. Finalizar requiere operación terminada y cierre económico cerrado; asignar no finaliza. Cancelar una asignación vinculada exige cancelar primero el despacho.

## Verificación y alcance

- `node scripts/test-outsourcing-resources.cjs`: cantidades, dos proveedores, parcialidad, aprobaciones, ficha sin transporte, equipo independiente, evaluación de grúa, conflictos, versiones, cancelación, auditoría, filtros, paginación y permisos.
- `node scripts/test-outsourcing-routes.cjs`: ejecuta el programador nativo y los acuerdos/planificador económico reales en PostgreSQL local (PGlite), dos unidades/proveedores, apoyo, vínculo original, reserva única por unidad y apoyo, reutilización bloqueada, excepción privada y rectificación sin nueva reserva.
- `node scripts/test-outsourcing-resources-browser.cjs`: Chromium con API local simulada; tabla, modal, persistencia de datos, aprobación/confirmación, apertura de Armado de Ruta y móvil sin desbordamiento. Capturas: `/workspace/artifacts/tercerizaciones-recursos` (datos de prueba, no operaciones de producción).
- Regresión del asistente y flujo anterior: `test-outsourcing-wizard.cjs`, `test-transport-outsourcing.cjs`.
- TypeScript, ESLint de archivos modificados y compilación de producción.

Límites explícitos: revisión documental interna, sin consulta externa a SUNAT/MTC. La evaluación técnica de izaje la registra un responsable, no la certifica el software. Los recursos complementarios se ejecutan/cancelan/cierran en el circuito operativo del despacho; no se incorpora un cierre autónomo de operaciones sin ruta. Las divisas se convierten con un tipo de cambio declarado y auditado; el libro presupuestal permanece en PEN.
