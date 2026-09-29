# Bloque 1 · Novedades con autor, "Cerrado" y RUC validado

Migración: `supabase/migrations/20260929220000_bloque1_trazabilidad_ruc.sql` · Prueba: `supabase/tests/caja_c11_trazabilidad_ruc.test.sql`

## Novedades del despacho con autor real (brecha #6)
- Cada novedad de Monitoreo (y cualquier evento del despacho) guarda al usuario de la sesión: `created_by` = nombre,
  `created_by_user` = id. Lo pone la base de datos; la web ya no puede escribir otro nombre ("Operador GPS").
- Los eventos antiguos que guardaron el id del usuario como texto se muestran con el nombre.
- Torre de Control muestra "Reportado por: <nombre>".

## "Cerrado" en vez de "Liquidado" (brecha #8)
- El cierre operativo de la ruta (estado técnico `LIQUIDADO`) se muestra como **CERRADO** en Despacho, Torre,
  Dashboard, ficha del trabajador, Caja y app del conductor (`src/lib/dispatch-status.ts`).
- "Liquidación" queda solo para Caja (liquidación del viaje y del anticipo). El estado técnico no cambia.

## RUC de clientes (brecha #2)
- Cliente nuevo o cambio de RUC: hay que pulsar **SUNAT** y verificar el RUC antes de guardar. Se guarda la fecha de
  verificación y el estado/condición (aviso si no está ACTIVO / HABIDO). Si SUNAT no responde se puede guardar con confirmación.
- En la base de datos: el RUC debe cumplir el dígito verificador y no puede repetirse (se comparan solo los dígitos,
  así "20-123…" y "20123…" son el mismo). Los clientes existentes se pueden seguir editando mientras no cambien su RUC.
- La importación por Excel (upsert por RUC) sigue actualizando los clientes existentes.
- `list_duplicate_client_tax_ids()` lista los RUC que ya estaban repetidos para depurarlos.
