import { createClient } from '@supabase/supabase-js'
import { PostgrestClient } from '@supabase/postgrest-js'

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_KEY!

// In production the Supabase JS client talks to supabase.co (adds /rest/v1 automatically).
// In dev, PostgREST runs at the root URL — use PostgrestClient directly so no prefix is added.
const isDev = process.env.NODE_ENV !== 'production'

const pgrest = isDev ? new PostgrestClient(url) : null

// Stub for Supabase Storage — photos are not available in local dev
const storageStub = {
  from: (_bucket: string) => ({
    createSignedUploadUrl: async (_path: string) => ({
      data: null as any,
      error: new Error('[dev] Storage not available locally — photo upload skipped'),
    }),
    getPublicUrl: (_path: string) => ({ data: { publicUrl: '' } }),
  }),
}

export const db: any = isDev
  ? Object.assign(pgrest!, { storage: storageStub })
  : createClient(url, key)
