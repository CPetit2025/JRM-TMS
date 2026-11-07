WMS producción utiliza el proyecto Supabase `glecgvomkaqmkfkhtxhi` y un proyecto Vercel independiente del proyecto TMS.

Variables del proyecto Vercel WMS exclusivamente:

```
NEXT_PUBLIC_DEPLOYMENT_SYSTEM=wms
NEXT_PUBLIC_SUPABASE_URL=https://glecgvomkaqmkfkhtxhi.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<clave pública de WMS producción>
SUPABASE_SERVICE_ROLE_KEY=<clave privada de WMS producción, solo servidor>
```

La comprobación de compilación y el proxy rechazan proyectos Supabase ajenos a WMS. En producción se rechaza también la base staging. Las rutas TMS y sus API no están disponibles en este despliegue; el único endpoint API permitido es GET /api/app-version. Las consultas directas de las páginas de almacén y su autenticación utilizan el proyecto configurado para WMS.

No cambiar las variables del proyecto Vercel TMS ni usar su deploy hook para publicar WMS. No suministrar claves de TMS al despliegue WMS. La integración de solicitudes/contratos necesita un proceso de lectura independiente antes de tener datos actualizados de TMS; este cambio no lo implementa.

El esquema de la nueva base todavía debe instalarse y validarse. El historial compartido de migraciones no constituye un paquete de instalación independiente de WMS. No ejecutar el workflow deploy-production.yml de TMS para instalar WMS.

Validación local de los bloqueos: `node scripts/test-wms-isolation.mjs`.
