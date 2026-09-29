# Solicitud: descarga obligatoria con memoria, buscador de OT y vista rápida de contratos

Migración: `supabase/migrations/20260930090000_solicitud_descarga_memoria.sql` · Prueba: `supabase/tests/caja_c12_descarga_memoria.test.sql`

## Descarga especial (obligatoria)
- En "Crear Nueva Solicitud" hay que responder **¿La entrega requiere descarga especial?** (Sí / No). Sin respuesta no se guarda.
- Si es "Sí" se indica al menos un recurso (montacargas, grúa, estiba, otros); el monto puede quedar vacío = por cotizar.
- La respuesta se guarda en `transport_requests.unloading_required`.

## Memoria de solicitudes anteriores
- Al elegir la OT y el destino, el sistema busca (`get_unloading_history`) solicitudes anteriores:
  1. al **mismo destino** (dirección normalizada: sin tildes, mayúsculas ni signos),
  2. del **mismo cliente en el mismo distrito**,
  3. de la **misma OT**.
- Muestra qué necesitaron (con el costo real si ya se consumió, si no el planificado o estimado) y el botón
  **Usar como referencia**, que copia los recursos y montos.
- Si se responde "No" pero una entrega anterior al mismo destino sí necesitó descarga, se pide confirmación.

## Buscador de OT
- Busca por código de la OT madre **o de sus subcontratos y errores**, por cliente o por destino.
- Muestra cada OT con sus componentes debajo, el cliente, el destino y el saldo de la partida (verde / ámbar / rojo).
- Elegir un subcontrato o error selecciona su OT madre y marca ese componente.

## Contratos y OTs
- Nueva columna **Alta** (fecha de registro). No existe todavía un campo de vencimiento del contrato.
- Al hacer clic en una fila se abre una **vista rápida**: partida (asignado, reservado, consumido, saldo), subcontratos y
  errores, últimas solicitudes y accesos a Editar, Responsable y "Abrir ficha completa".
