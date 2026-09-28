@AGENTS.md

## Despliegue

Regla del dueño del repositorio: cuando un cambio está validado (pruebas SQL, `tsc`, `next build` y lint sin
errores nuevos), se mergea a `master` y se despliega automáticamente, sin pedir confirmación. Al llegar a `master`,
el workflow `deploy-production.yml` aplica las migraciones de Supabase, corre las pruebas de caja y despliega en
Vercel (ver `docs/despliegue-automatico.md`). Después de mergear, revisar el resultado del workflow y corregir si falla.
