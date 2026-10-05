# Despliegue automático a producción

Workflow: `.github/workflows/deploy-production.yml`. Cada push a `master` (por ejemplo, al mergear un PR):

1. **Migraciones**: aplica a Supabase las migraciones nuevas de `supabase/migrations` (`supabase db push`).
   - Antes revisa el plan: si la base tiene pendientes migraciones que **no** vienen en ese push, se detiene.
     Esto indica un historial desalineado (migraciones aplicadas a mano) y aplicarlas a ciegas podría romper producción.
2. **Pruebas SQL de caja** (`supabase/tests/caja_*.test.sql`): corren contra la base real. Siempre terminan con
   `ROLLBACK`, así que no dejan datos. El resultado aparece en el resumen del workflow; un fallo o un caso
   sin resultado detiene el despliegue de la web hasta corregirlo.
3. **Vercel**: dispara el despliegue de producción con un Deploy Hook, solo si las migraciones y las pruebas SQL terminaron bien.

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

## APK del conductor (Android)

El APK carga la web en vivo, así que las pantallas se actualizan con cada despliegue de Vercel. Solo hace falta
un APK nuevo cuando cambia la parte nativa (permisos, plugins), como el permiso de micrófono de la versión 1.0.4.

GitHub → Actions → *Build signed Android APK* → *Run workflow* (rama `master`): versión y build (el build siempre
debe subir), `publish` activado y las novedades. El workflow compila, firma y **publica**: sube el APK al bucket de
instaladores y registra la versión en `app_versions`. El login muestra la nueva descarga y el app avisa al conductor.
La clave de servicio se obtiene con `SUPABASE_ACCESS_TOKEN` (ya cargado); no requiere secretos nuevos.

## Evidencias del app en la web

Las fotos, PDF y audios del conductor (bucket privado `driver_evidence`) se ven en: detalle del despacho,
liquidación del viaje (Caja), fallas (Mantenimiento) y ficha de la unidad (pestaña Evidencias). Las exportaciones
Excel incluyen un enlace permanente `/evidencia?ref=…` que pide sesión y firma el archivo al abrirse.
