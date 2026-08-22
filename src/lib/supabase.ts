import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from './env';

/**
 * Server-side Supabase client using the service-role key.
 *
 * SERVER ONLY. This key bypasses Row Level Security — importing this module
 * from a client component would ship database god-mode to the browser.
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const { supabaseUrl, supabaseServiceRoleKey } = serverEnv();
  cached = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
