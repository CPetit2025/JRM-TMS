# Despliegue de WMS (separado de TMS)

WMS (portal de almacén, rama `feature/warehouse-wms-portal`) usa **sus propias bases de Supabase y sus propios
proyectos Vercel**. TMS no cambia: sigue en `jrm-tms.vercel.app`, con su base y `deploy-production.yml`.

| Sistema | Base de Supabase (referencia) | Proyecto Vercel | Cómo se despliega |
|---|---|---|---|
| TMS | `eojfsbogysifxrlrnjvx` | `jrm-tms` | Push a `master` → `deploy-production.yml` |
| WMS Staging | `rquujukgtturdlkuzgdc` | `jrm-wms-staging` (nuevo) | Actions → *Deploy WMS* → `staging` |
| WMS Producción | `glecgvomkaqmkfkhtxhi` | `jrm-wms` (nuevo) | Actions → *Deploy WMS* → `production` |

El código usa los mismos nombres de variable (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) en los tres sistemas: cada proyecto Vercel tiene **sus propios valores**, así que
WMS nunca lee las claves de TMS. **No cambie las variables del proyecto `jrm-tms`.**

## Guardas

`scripts/check-supabase-target.cjs` (probado en `scripts/test-supabase-target.cjs`, corre en cada PR) falla si:

- una compilación o despliegue de WMS (`JRM_APP=wms-staging` o `wms-production`) apunta a la base de TMS;
- WMS Staging no usa `rquujukgtturdlkuzgdc`, o WMS Producción usa la de Staging;
- TMS en producción (Vercel producción o `deploy-production.yml`) usa una base que no es la suya, p. ej. la de WMS.

Corre en tres lugares: antes de `next build` (`npm run build`, también en Vercel), en `deploy-production.yml`
(paso *Guard TMS target*) y en `deploy-wms.yml` (base de migraciones y variables del proyecto Vercel WMS).

## Pasos administrativos (los hace el usuario; nunca escriba claves en el repositorio)

### 1. Supabase WMS Producción

De la URL recibida (`https://<ref>.supabase.co`) anote la **referencia** `<ref>` y compruebe que **no** sea
`eojfsbogysifxrlrnjvx` (TMS) ni `rquujukgtturdlkuzgdc` (Staging); la guarda lo rechaza de todos modos.
En ese proyecto: Project Settings → API (URL, `anon` y `service_role`) y Database (contraseña).

### 2. Proyectos Vercel (uno por entorno)

Cree dos proyectos **sin conectarlos a Git**, para que ningún push los despliegue antes que sus migraciones
(los despliega el workflow con la CLI de Vercel):

```bash
npx vercel@61.1.0 project add jrm-wms-staging
```

```bash
npx vercel@61.1.0 project add jrm-wms
```

En cada uno, Settings → Build and Deployment → Framework Preset = *Next.js*. En Settings →
Environment Variables, entorno **Production**:

| Variable | `jrm-wms-staging` | `jrm-wms` |
|---|---|---|
| `JRM_APP` | `wms-staging` | `wms-production` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://rquujukgtturdlkuzgdc.supabase.co` | URL de WMS Producción |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` de Staging | `anon` de WMS Producción |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` de Staging | `service_role` de WMS Producción |
| `OPENAI_API_KEY` (y opcionales de `.env.example`) | si WMS usa JRM IA / OCR | ídem |

Anote de cada proyecto el **Project ID** (Settings → General) y el **Team ID** (Team Settings → General).
Cree un token en Vercel → Account Settings → Tokens.

### 3. Entornos de GitHub

GitHub → Settings → Environments. `wms-staging` ya existe (lo usa `wms-staging-db.yml`); cree `wms-production`
y, en lo posible, agréguele *Required reviewers* para que cada despliegue a producción pida aprobación.
Cargue en **cada entorno** (no a nivel de repositorio, para no mezclarse con TMS):

| Tipo | Nombre | `wms-staging` | `wms-production` |
|---|---|---|---|
| Variable | `SUPABASE_PROJECT_REF` | `rquujukgtturdlkuzgdc` (ya existe) | referencia de WMS Producción |
| Secreto | `WMS_SUPABASE_ACCESS_TOKEN` | configurar token con alcance Staging | configurar token con alcance WMS Producción |
| Secreto | `WMS_SUPABASE_DB_PASSWORD` | configurar contraseña de la base Staging | configurar contraseña de la base WMS Producción |
| Secreto | `WMS_VERCEL_TOKEN` | token de Vercel | token de Vercel |
| Variable | `WMS_VERCEL_ORG_ID` | Team ID | Team ID |
| Variable | `WMS_VERCEL_PROJECT_ID` | Project ID de `jrm-wms-staging` | Project ID de `jrm-wms` |

### 4. Primer despliegue

GitHub → Actions → *Deploy WMS (Supabase + Vercel)* → *Run workflow*, seleccionando la rama que contiene esta versión del workflow y el SHA completo revisado en `candidate_sha`, destino `staging`. La candidata de auditoría también dispara Staging por push. Producción requiere una aprobación final expresa posterior a las pruebas, evidencia del mismo SHA y recuperación verificada. La primera ejecución en producción instala el esquema completo
(`supabase db push --include-all`) en la base nueva. Revise el paso *Preview pending migrations* del resumen.

## Notas

- El workflow usa exclusivamente el SHA congelado, no una variable WMS_BRANCH mutable.
- La candidata incorpora la guarda antes de `npm run build` y verifica las variables del proyecto dedicado antes de migrar.
- `wms-staging-db.yml` se conserva sólo como comprobación manual de destino; ya no aplica migraciones.
- Las vistas previas de la rama WMS en el proyecto `jrm-tms` usan las variables de vista previa de TMS. Para
  probar WMS use `jrm-wms-staging`.

## Actualización de la candidata auditada

El workflow de esta rama congela un SHA de 40 caracteres, verifica primero los proyectos/credenciales WMS y ejecuta pruebas antes de migrar. La rama de auditoría sólo puede disparar Staging al hacer push. El destino Producción únicamente se admite con workflow_dispatch, production_approved y el identificador de una ejecución Staging exitosa del mismo SHA. No hay un atajo skip_migrations. La comprobación HTTP de login prueba la identidad del despliegue, no el inicio de sesión de un operador. Consulte docs/wms-auditoria-2026-11-07.md y docs/manual-wms.md para los límites y pruebas pendientes.

Se retira el trigger automático de wms-staging-db.yml para que un cambio SQL no evite las verificaciones previas del pipeline completo. No ejecutar ese workflow legado para esta candidata.

Las migraciones propias están en `supabase/wms/migrations/`; no pertenecen al plan de TMS. El paso `prepare-wms-migrations.cjs` las combina en el runner WMS después de validar el destino y antes de `supabase link`. Se conservan los nombres/versiones ya aplicados en WMS Staging. No copiar esos archivos al directorio de TMS para confirmarlos en Git. La guarda específica rechaza ese cruce y las colisiones de versiones.

Los secretos de GitHub de la candidata son WMS_SUPABASE_ACCESS_TOKEN y WMS_SUPABASE_DB_PASSWORD. No se acepta fallback a SUPABASE_ACCESS_TOKEN/SUPABASE_DB_PASSWORD del repositorio: pueden pertenecer a TMS. Cada token WMS debe tener alcance únicamente a su proyecto. Vercel mantiene sus nombres de cliente habituales dentro de cada proyecto independiente.
