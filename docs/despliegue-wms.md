# Despliegue de WMS (separado de TMS)

WMS (portal de almacén, rama `feature/warehouse-wms-portal`) usa **sus propias bases de Supabase y sus propios
proyectos Vercel**. TMS no cambia: sigue en `jrm-tms.vercel.app`, con su base y `deploy-production.yml`.

| Sistema | Base de Supabase (referencia) | Proyecto Vercel | Cómo se despliega |
|---|---|---|---|
| TMS | `eojfsbogysifxrlrnjvx` | `jrm-tms` | Push a `master` → `deploy-production.yml` |
| WMS Staging | `rquujukgtturdlkuzgdc` | `jrm-wms-staging` (nuevo) | Actions → *Deploy WMS* → `staging` |
| WMS Producción | la URL nueva que recibió el usuario | `jrm-wms` (nuevo) | Actions → *Deploy WMS* → `production` |

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
| Secreto | `SUPABASE_ACCESS_TOKEN` | ya existe | token de la cuenta Supabase dueña de WMS Producción |
| Secreto | `SUPABASE_DB_PASSWORD` | ya existe | contraseña de la base WMS Producción |
| Secreto | `WMS_VERCEL_TOKEN` | token de Vercel | token de Vercel |
| Variable | `WMS_VERCEL_ORG_ID` | Team ID | Team ID |
| Variable | `WMS_VERCEL_PROJECT_ID` | Project ID de `jrm-wms-staging` | Project ID de `jrm-wms` |

### 4. Primer despliegue

GitHub → Actions → *Deploy WMS (Supabase + Vercel)* → *Run workflow* (rama `master`) → `staging`; cuando
funcione, `production`. La primera ejecución en producción instala el esquema completo
(`supabase db push --include-all`) en la base nueva. Revise el paso *Preview pending migrations* del resumen.

## Notas

- El workflow toma el código de `WMS_BRANCH` (`feature/warehouse-wms-portal`). Cuando WMS llegue a `master`,
  cambie esa variable en `deploy-wms.yml`.
- La guarda dentro de `npm run build` llega a la compilación de Vercel WMS cuando la rama WMS incorpore `master`;
  mientras tanto la cubre el paso *Guard WMS Vercel project* del workflow, que revisa las variables del proyecto.
- `wms-staging-db.yml` (en la rama WMS) sigue aplicando migraciones a Staging en cada push; comparte el grupo de
  concurrencia con este workflow.
- Las vistas previas de la rama WMS en el proyecto `jrm-tms` usan las variables de vista previa de TMS. Para
  probar WMS use `jrm-wms-staging`.
