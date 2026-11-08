WMS producción utiliza el proyecto Supabase `glecgvomkaqmkfkhtxhi` y un proyecto Vercel independiente del proyecto TMS.

Variables del proyecto Vercel WMS exclusivamente:

```
NEXT_PUBLIC_DEPLOYMENT_SYSTEM=wms
NEXT_PUBLIC_SUPABASE_URL=https://glecgvomkaqmkfkhtxhi.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<clave pública de WMS producción>
SUPABASE_SERVICE_ROLE_KEY=<clave privada de WMS producción, solo servidor>
```

La comprobación de compilación y el proxy rechazan proyectos Supabase ajenos a WMS. En producción se rechaza también la base staging. Las rutas TMS y sus API no están disponibles en este despliegue; los únicos endpoints API permitidos son GET /api/app-version y POST /api/wms/sincronizar. Las consultas directas de las páginas de almacén y su autenticación utilizan el proyecto configurado para WMS.

No cambiar las variables del proyecto Vercel TMS ni usar su deploy hook para publicar WMS. No suministrar claves privadas de TMS (service role, contraseñas) al despliegue WMS.

## Integración de solicitudes (picking, auditoría y Packing List)

`POST /api/wms/sincronizar` corre con la sesión del usuario del almacén (Tareas y Auditoría lo llaman al abrir y cada
15–20 s; la base WMS lo limita a una vez por minuto con `wh_tms_sync_claim`). Lee del TMS solo con la función
`wms_feed_solicitudes` (despachos con OT en estado preparable y el estado actual de las solicitudes ya conocidas) e
informa los Packing List liberados o reemplazados con `wms_report_packing_list` (tabla TMS `wms_packing_releases`).
Ambas exigen una clave de integración cuyo hash SHA-256 vive en la tabla TMS `integration_keys` (fila `wms`).

Variables adicionales del proyecto Vercel WMS (solo servidor):

```
TMS_SUPABASE_URL=https://eojfsbogysifxrlrnjvx.supabase.co
TMS_SUPABASE_ANON_KEY=<clave pública (anon) de TMS>
TMS_INTEGRATION_KEY=<clave de integración; su hash está en integration_keys>
```

Sin esas variables la ruta responde 503 y el WMS sigue funcionando con los datos ya copiados. Para rotar la clave:
generar una nueva, actualizar `integration_keys.key_hash` en TMS con una migración y la variable en Vercel.

El esquema de producción se instaló y validó con el paquete independiente `wms-db/supabase/migrations`. Incluye las tablas WMS y sus referencias vacías; no usa el historial compartido de migraciones TMS. No ejecutar `deploy-production.yml` ni `supabase db push --include-all` desde la raíz para instalar WMS. Ver `wms-db/README.md`.

Validación local de los bloqueos: `node scripts/test-wms-isolation.mjs`.
