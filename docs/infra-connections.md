# Infra Connections

## GitHub

Canonical repository: `https://github.com/CPetit2025/JRM-TMS.git`.

Local development must happen on feature branches. Do not commit directly to `master`.

## Supabase

The application uses Supabase through `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

Admin or seed scripts that need elevated permissions must use `SUPABASE_SERVICE_ROLE_KEY` from the local environment only. Never hardcode Supabase URLs or keys in versioned scripts.

Local Supabase CLI configuration lives in `supabase/config.toml`; transient CLI state under `supabase/.temp` is ignored.

## Vercel

The repository includes `vercel.json` with the Next.js build settings used by deployments.

The local `.vercel` folder is intentionally not versioned. To complete account-level linking on a workstation or CI runner, authenticate with Vercel and run `vercel link`; then configure the required Supabase environment variables in Vercel.

Required Vercel environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (JRM IA y OCR con OpenAI; solo servidor)

Los pasos para cargar y comprobar las claves están en [configurar OpenAI en Vercel](configurar-openai-vercel.md).

## Verification

Run these checks before deployment:

```bash
npm run lint
npm run typecheck
npm run build
npm run check:infra
```
