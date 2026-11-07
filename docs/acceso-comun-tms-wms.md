# Entrada común TMS / WMS

El selector del login abre el sitio correspondiente antes de pedir credenciales.
El sistema local se identifica por su proyecto Supabase, incluso en las Preview
antiguas que no tienen `NEXT_PUBLIC_DEPLOYMENT_SYSTEM`.

- TMS local autentica únicamente en la base TMS.
- WMS local autentica únicamente en su base WMS.
- Cambiar de sistema borra los campos de usuario y contraseña.
- Al elegir el otro sistema se ocultan esos campos y el botón pasa a «Continuar».
  La navegación abre `/login` en TMS o `/almacen/login` en WMS. No envía usuario,
  contraseña, tokens ni cookies del sitio de origen al destino.
- Si falta la dirección de WMS, se muestra un aviso y no se intenta autenticar
  contra TMS. Una dirección que apunta al mismo origen también se rechaza.

## Configuración de despliegue

Agregar en Vercel, por entorno, y volver a compilar:

| Variable pública | Valor |
| --- | --- |
| `NEXT_PUBLIC_TMS_ORIGIN` | Origen HTTPS de TMS; por defecto `https://jrm-tms.vercel.app` |
| `NEXT_PUBLIC_WMS_ORIGIN` | Origen HTTPS del despliegue WMS del entorno correspondiente |

Usar solo el origen, por ejemplo `https://wms.example.com`, sin rutas, parámetros,
fragmentos ni credenciales. Las direcciones son configuración pública, no claves.
No modificar las claves de Supabase de TMS para incorporar el selector.

La entrada principal prevista por el usuario es `https://jrmlogistica.app`.
Este cambio no crea ni configura DNS, dominios ni proyectos Vercel. Primero hay
que confirmar el despliegue WMS de producción y su base, y asignar los dominios
antes de configurar las direcciones públicas de producción.

La dirección actual de desarrollo
`https://jrm-tms-git-feature-warehouse-wms-portal-cpetit2025s-projects.vercel.app`
está configurada para WMS Staging (`rquujukgtturdlkuzgdc`). Puede usarse como
`NEXT_PUBLIC_WMS_ORIGIN` para pruebas, nunca como destino WMS de producción.

## Alcance de la cuenta

Una entrada común no proporciona SSO. Cada proyecto Supabase mantiene sus usuarios,
perfiles y permisos. Las mismas credenciales solo funcionan si la cuenta existe
y está habilitada en ambos proyectos. No se copian cuentas ni datos mediante este
cambio. La sesión de TMS se conserva al salir hacia WMS, y viceversa.

## Verificación

`node --test scripts/test-login-system.cjs` cubre ambos sentidos, Preview sin
indicador de sistema, borrado de credenciales, dirección ausente y destinos
inválidos. La comprobación `scripts/test-wms-isolation.mjs` pertenece a la rama WMS;
este cambio de TMS no incorpora sus rutas ni sus migraciones.
