# Réplica del modelo de almacén (fase 4)

Genera `wms-db/supabase/migrations/20261109090000_wms_modelo_apt.sql` desde **producción del TMS** (sus migraciones del
repo no coinciden con producción). Solo lee del TMS.

```bash
# en una carpeta temporal fuera del repo (no son dependencias del proyecto)
npm install pg@8.13.1 pg-copy-streams@6.0.6
node extract.cjs                       # escribe esquema.json
node build.cjs <ruta de la migración>   # arma el SQL
```

`db.cjs` se conecta con el usuario temporal que crea la CLI de Supabase (`supabase db dump --dry-run`), así que no
guarda contraseñas. Requiere la CLI con sesión iniciada en la cuenta dueña de los proyectos.
