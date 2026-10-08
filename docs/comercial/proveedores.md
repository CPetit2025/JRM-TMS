# Proveedores (materia prima, producción y proyectos)

Maestro de empresas desde las que JRM recoge carga: materia prima, insumos, producción, proyectos y servicios.
Es distinto de los transportistas (`carriers`) y de los talleres (`maintenance_providers`).

## Datos
- `suppliers`: RUC (11 dígitos, único; la pantalla valida el dígito verificador), razón social, categoría,
  contacto y estado.
- `supplier_locations`: puntos de recojo (planta/almacén) con dirección, distrito y contacto del punto.
- `transport_requests`: `supplier_id`, `supplier_location_id`, `reference_type` (OC, RQ u OS) y `reference_number`.
  Las solicitudes antiguas conservan la OC/OS escrita en `purchase_order`.

## Reglas
- Recojos y traslados punto a punto exigen proveedor (`apply_request_supplier`); el documento es opcional.
- El guardado de la solicitud usa `save_transport_request_full`: guarda con `save_transport_request_attention` y
  aplica proveedor y documento en la misma transacción.
- Alta y edición: Comercial y Logística (permisos `proveedores`, `clientes`, `solicitudes` o `despacho`) y
  administradores. Lectura: módulos que muestran solicitudes y despachos.
- Tablas: la columna **Empresa** muestra el proveedor en recojos y punto a punto, y el cliente en entregas. Sin OT,
  la columna OT muestra el documento (por ejemplo "RQ 1203").
- Prueba: `supabase/tests/caja_c63_proveedores.test.sql`.

## Pendiente
- Validar o importar RQ/OS desde el ERP cuando se confirme que la descarga es completa.
- Carga masiva de proveedores desde Excel.
