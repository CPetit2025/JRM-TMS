# Despliegue automático a producción

Workflow: `.github/workflows/deploy-production.yml`. Cada push a `master` (por ejemplo, al mergear un PR):

1. **Migraciones**: aplica a Supabase las migraciones nuevas de `supabase/migrations` (`supabase db push`).
   - Antes revisa el plan: si la base tiene pendientes migraciones que **no** vienen en ese push, se detiene.
     Esto indica un historial desalineado (migraciones aplicadas a mano) y aplicarlas a ciegas podría romper producción.
2. **Pruebas SQL de caja** (`supabase/tests/caja_*.test.sql`): corren contra la base real. Siempre terminan con
   `ROLLBACK`, así que no dejan datos. Son informativas: el resultado aparece en el resumen del workflow y no
   detienen el despliegue.
3. **Vercel**: dispara el despliegue de producción con un Deploy Hook, solo si las migraciones terminaron bien.

`vercel.json` desactiva el despliegue por Git de `master` (`git.deploymentEnabled.master = false`). Así el
frontend nunca llega a producción antes que el esquema que necesita. Las vistas previas de las ramas y los PR
siguen igual.

## Secretos (GitHub → Settings → Secrets and variables → Actions → New repository secret)

| Secreto | Dónde se obtiene |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens → *Generate new token* |
| `SUPABASE_PROJECT_ID` | Supabase → Project Settings → General → *Reference ID* (también está en la URL del proyecto) |
| `SUPABASE_DB_PASSWORD` | La contraseña de la base; si no la tiene: Project Settings → Database → *Reset database password* |
| `VERCEL_DEPLOY_HOOK_URL` | Vercel → proyecto `jrm-tms` → Settings → Git → Deploy Hooks → nombre `produccion`, rama `master` → copiar la URL |

## Ejecución manual

GitHub → Actions → *Deploy production (Supabase + Vercel)* → *Run workflow*:

- `apply_all_pending`: aplica todas las migraciones pendientes aunque no vengan en el último push.
  Úselo solo después de revisar `supabase migration list`.
- `skip_migrations`: solo redepliega Vercel.

## Si el plan se detiene por historial desalineado

```bash
npx supabase link --project-ref <ID>
npx supabase migration list                               # Local vs Remote
npx supabase migration repair --status applied <versión>  # marca como aplicada una que ya está en la base
```

Luego vuelva a ejecutar el workflow.

## Verificación previa en cada PR

Workflow `.github/workflows/pr-checks.yml` (`Verificación previa (PR)`), obligatorio en verde antes de mergear:

- `npm run check:guards` (`scripts/check-release-guards.cjs`):
  - `capacitor.config.ts` mantiene `server.url = https://jrm-tms.vercel.app` y `appStartPath = /app/login`
    (sin esto el APK no compila o queda sin pantallas).
  - cada pantalla de `src/app/app/(app)` tiene al menos un enlace desde otra parte del app del conductor.
- `npm run typecheck`.

Las reglas completas para evitar diferencias con producción están en `CLAUDE.md` → *Reglas para no repetir incidentes*.
