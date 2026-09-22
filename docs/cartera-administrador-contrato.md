# Cartera del Administrador de Contrato

El rol **Administrador de Contratos** es distinto de **Administrador** (sistema).
Cada OT raíz tiene un responsable principal activo como máximo. Las asignaciones
anteriores permanecen en `contract_user_assignments` con fechas de inicio y fin.

## Activación de una cartera existente

1. Crear o activar el perfil con el rol `Administrador de Contratos` y acceso a la sede.
2. Entrar como Administrador del Sistema en `/contratos` y pulsar **Responsable** en
   cada OT raíz. Elegir el usuario y registrar el motivo de la asignación.
3. Verificar que el usuario vea esa OT en `/contratos` y `/solicitudes`, y no vea
   las OT de otros responsables. Un cambio de responsable cierra el período
   anterior y concede acceso al nuevo usuario en la misma transacción.

Las OT históricas no se asignan por nombre, correo o suposición. Mientras no
tengan responsable, ningún Administrador de Contrato puede administrarlas; el
Administrador del Sistema conserva acceso y los roles operativos mantienen sus
permisos existentes.
Una nueva OT raíz creada por un Administrador de Contrato queda asignada a su
creador automáticamente.

## Alcance

- `/contratos`, presupuestos, servicios, gastos, solicitudes y registros ligados
  a una OT usan la asignación de la OT raíz. Las RPC privilegiadas validan esa
  asignación además del módulo y la sede.
- `/clientes` conserva lectura global. El permiso heredado `clientes` aún
  autoriza escritura global; las políticas separan lectura, inserción,
  actualización y eliminación para permitir un futuro rol de solo lectura.
- `/torre-control` ofrece un reporte global de lectura con campos operativos,
  códigos de OT y filtro por responsable. El permiso `torre-control:read` no
  concede escritura ni creación de enlaces de seguimiento.
- El Administrador del Sistema conserva la vista global y puede reasignar.

## Comprobación

Ejecutar `npx supabase db query --linked --file scripts/verify-contract-portfolio.sql`.
La prueba simula dos responsables y un administrador del sistema en una
transacción que termina en `ROLLBACK`. Comprueba cartera propia, bloqueo de OT
ajena, vista, solicitudes, gastos, Torre, creación y reasignación con historial.

Los buckets genéricos `evidence` y `signatures` siguen siendo públicos porque
también son utilizados por flujos de mantenimiento y conductores con enlaces
públicos. No deben utilizarse para nuevos documentos confidenciales de OT. La
privatización de archivos existentes requiere migrar esos flujos a rutas
asociadas a un registro y servirlos mediante URLs firmadas tras validar la OT.
