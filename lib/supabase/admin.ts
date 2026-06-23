import { createClient } from '@supabase/supabase-js'

/**
 * Service-role Supabase client for server-side use.
 * Bypasses RLS — all queries must be explicitly scoped to the relevant userId.
 * Never import this in client components.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}
