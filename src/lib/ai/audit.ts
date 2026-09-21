import { createClient } from '@supabase/supabase-js'

type AuditEntry = {
  user_id: string
  scope: 'copilot' | 'ocr'
  model: string
  tool_names?: string[]
  context_refs?: Record<string, unknown>
  input_tokens?: number
  output_tokens?: number
  status: 'completed' | 'failed'
}

export async function writeAiAudit(entry: AuditEntry) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para auditoría IA')
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await supabase.from('ai_query_audit').insert(entry)
  if (error) throw error
}
