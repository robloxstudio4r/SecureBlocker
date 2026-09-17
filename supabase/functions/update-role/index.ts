import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

Deno.serve(async (req) => {
  // Browsers send a preflight OPTIONS request before the real POST —
  // without answering it, supabase.functions.invoke() fails with a CORS error.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')!
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user } } = await userClient.auth.getUser()
    if (!user) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders })
    }

    const role = user.app_metadata?.role
    if (role !== 'admin') {
      return new Response('Forbidden', { status: 403, headers: corsHeaders })
    }

    const { userId, role: newRole } = await req.json()
    if (!userId || !newRole) {
      return new Response('userId and role are required', { status: 400, headers: corsHeaders })
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      app_metadata: { role: newRole }
    })
    if (error) {
      return new Response(error.message, { status: 400, headers: corsHeaders })
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'Internal error', {
      status: 500,
      headers: corsHeaders
    })
  }
})
