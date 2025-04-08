import { createClient } from '@supabase/supabase-js'

// Ensure environment variables are set
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

if (!supabaseUrl) {
  throw new Error("Missing environment variable NEXT_PUBLIC_SUPABASE_URL")
}
if (!supabaseAnonKey) {
  throw new Error("Missing environment variable SUPABASE_ANON_KEY")
}

// Create and export the Supabase client instance
export const supabase = createClient(supabaseUrl, supabaseAnonKey) 