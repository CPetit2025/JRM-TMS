# Manual de Solicitud de Transporte (PDF)

Genera `public/manuales/manual-solicitud-transporte.pdf` con capturas reales de `/solicitudes`, usando datos de
demostración (sin conectarse a producción).

1. Build con Supabase simulado: `NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=x SUPABASE_SERVICE_ROLE_KEY=x npx next build`
2. `node scripts/manual-solicitudes/fake-supabase.cjs &` (Supabase simulado en el puerto 54321)
3. `NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=x npx next start -p 3000 &`
4. `OUT=/tmp/manual-img node scripts/manual-solicitudes/shoot.cjs` (Playwright: capturas paso a paso)
5. `IMG=/tmp/manual-img node scripts/manual-solicitudes/build-manual.cjs public/manuales/manual-solicitud-transporte.pdf`
