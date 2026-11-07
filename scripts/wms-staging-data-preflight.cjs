'use strict'

const { Client } = require('pg')

const PRODUCTION_REF = 'eojfsbogyisfxlrlnjyx'
const EXPECTED_STAGING_REF = 'rquujukgtturdlkuzgdc'
const TABLES = ['clients', 'contracts', 'transport_requests', 'dispatches', 'dispatch_requests', 'dispatch_events', 'wh_tasks', 'wh_packages', 'wh_receipt_validations']

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function sourceConnection() {
  const raw = requireEnv('SUPABASE_PRODUCTION_DB_URL')
  const url = new URL(raw)
  const username = decodeURIComponent(url.username)
  if (!username.startsWith(`staging_export.${PRODUCTION_REF}`)) {
    throw new Error('Source URI must use the read-only staging_export role and the approved production project ref.')
  }
  if (!url.hostname.endsWith('supabase.com') && !url.hostname.endsWith('supabase.co')) {
    throw new Error('Source URI host is not a Supabase database host.')
  }
  return { connectionString: raw, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 }
}

function targetConnection() {
  const ref = requireEnv('SUPABASE_PROJECT_REF')
  if (ref !== EXPECTED_STAGING_REF) throw new Error('Refusing to inspect a target other than the WMS staging project.')
  const password = encodeURIComponent(requireEnv('SUPABASE_DB_PASSWORD'))
  return {
    connectionString: `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  }
}

async function tableMetadata(client, table) {
  const { rows } = await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table],
  )
  return rows
}

async function estimatedRows(client, table) {
  const { rows } = await client.query(
    `SELECT c.reltuples::bigint AS estimate
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1`,
    [table],
  )
  return rows[0]?.estimate ?? null
}

async function foreignKeys(client, table) {
  const { rows } = await client.query(
    `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND tc.table_name=$1
      ORDER BY kcu.ordinal_position`,
    [table],
  )
  return rows
}

async function inspect(label, client) {
  const identity = await client.query('SELECT current_database() AS database, current_user AS role')
  console.log(`${label}: database=${identity.rows[0].database}, role=${identity.rows[0].role}`)
  for (const table of TABLES) {
    const columns = await tableMetadata(client, table)
    if (!columns.length) {
      console.log(`public.${table}: absent`)
      continue
    }
    const [estimate, fks] = await Promise.all([estimatedRows(client, table), foreignKeys(client, table)])
    const compactColumns = columns.filter(c => c.is_nullable === 'NO' && !c.column_default).map(c => c.column_name)
    console.log(JSON.stringify({ table: `public.${table}`, estimatedRows: estimate, requiredColumnsWithoutDefaults: compactColumns, foreignKeys: fks }))
  }
}

async function main() {
  const source = new Client(sourceConnection())
  const target = new Client(targetConnection())
  try {
    await Promise.all([source.connect(), target.connect()])
    console.log('Preflight only: no rows or schema are written.')
    await inspect('Production source', source)
    await inspect('Staging target', target)
  } finally {
    await Promise.allSettled([source.end(), target.end()])
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Preflight failed.')
  process.exitCode = 1
})
