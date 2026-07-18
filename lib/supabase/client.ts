import { createBrowserClient } from '@supabase/ssr'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// In the native (Capacitor) app the web bundle is served from capacitor://localhost, where the
// cookie storage that @supabase/ssr uses does NOT persist — so the auth session vanishes right after
// sign-in and the app bounces back to logged-out. There we use supabase-js with its default
// localStorage storage, which WKWebView persists reliably. On the web we keep the cookie-based ssr
// client exactly as before (no re-login for existing web users, works with any server-side reads).
let nativeClient: SupabaseClient | null = null

function isNativeApp(): boolean {
  return typeof window !== 'undefined' && !!(window as { Capacitor?: unknown }).Capacitor
}

export function createClient(): SupabaseClient {
  if (isNativeApp()) {
    if (!nativeClient) {
      nativeClient = createSupabaseClient(URL, KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    }
    return nativeClient
  }
  return createBrowserClient(URL, KEY) as unknown as SupabaseClient
}
