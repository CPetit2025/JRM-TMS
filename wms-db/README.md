# Base independiente WMS

Estas migraciones se ejecutan solo contra JRM WMS Producción, nunca contra TMS.
El directorio está separado de `supabase/migrations` para evitar que el workflow
de TMS lo aplique a su base. No usar el historial compartido de TMS como instalador WMS.

El baseline contiene las tablas WMS, funciones de recepción/etiquetado y las tablas
de referencia que necesitan sus claves foráneas y consultas. Las tablas de referencia
se crean vacías: no instalan triggers operativos de TMS ni sincronizan solicitudes
o despachos. Las funciones auxiliares internas no están expuestas a clientes; las
mutaciones WMS verifican cuenta activa, permisos y sede. Todas las tablas usan RLS.

La instalación inicial de producción se aplicó a `glecgvomkaqmkfkhtxhi` y se validó
con el rol autenticado del administrador. La carga inicial contiene 189 ingresos
del snapshot `entrada.xlsx` de noviembre de 2026; no se copiaron los paquetes de
pruebas. La importación manual de nuevos libros sigue siendo la fuente de ingresos;
no hay sincronización automática de solicitudes TMS en esta entrega.

La cuenta del propietario se migró con autorización expresa, sin sesiones ni tokens
y sin modificar TMS. Las cuentas siguen siendo independientes: los cambios futuros
de contraseña no se sincronizan automáticamente. No almacenar usuarios, hashes ni
claves en este directorio.

Prueba local sin credenciales: `node scripts/test-wms-bootstrap.cjs`. Cubre una
instalación vacía, importar, consultar, validar, etiquetar, imprimir y consultar el
control de recepción. También verifica bloqueo anónimo y de cuentas inactivas.

Configuración Vercel `jrm-wms`: `NEXT_PUBLIC_DEPLOYMENT_SYSTEM=wms`, `JRM_APP=wms-production`,
URL y clave pública de la base WMS; `NEXT_PUBLIC_TMS_ORIGIN=https://www.jrmlogistica.app`.
El dominio es `wms.jrmlogistica.app`; el portal TMS usa ese origen para Almacén.

Sincronización con el TMS sin navegador (salida liberada por el WMS): `vercel.json` programa un Vercel Cron cada
5 minutos a `GET /api/wms/tms-cron`. Crear en el proyecto Vercel `jrm-wms` la variable `CRON_SECRET` (valor aleatorio
de 32+ caracteres; Vercel la envía como `Authorization: Bearer …` y la ruta responde 401 sin ella) y verificar que
existan `SUPABASE_SERVICE_ROLE_KEY` (base WMS), `TMS_SUPABASE_URL`, `TMS_SUPABASE_ANON_KEY` y `TMS_INTEGRATION_KEY`.
Si el plan de Vercel no permite crons cada 5 minutos, el robot de la PC (`scripts/wms-auto`) puede llamar la misma
ruta con ese encabezado. Sin informes por 15 minutos el TMS bloquea la salida («Sin respuesta del WMS»).
