'use client'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function StudentPage() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [session, setSession] = useState(null)
  const [locked, setLocked] = useState(false)
  const [lockMessage, setLockMessage] = useState('')
  const [escaped, setEscaped] = useState(false)

  const tokenRef = useRef(null)
  const sessionRef = useRef(null)
  const userRef = useRef(null)

  // ---------------------------------------------
  // EFFECT 1: Load user + profile + create session
  // ---------------------------------------------
  useEffect(() => {
    let cancelled = false
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      setUser(user); userRef.current = user

      const { data: prof } = await supabase
        .from('profiles').select('*').eq('id', user.id).single()
      setProfile(prof)

      // Close any old dangling session for this user
      await supabase.from('sessions')
        .update({ ended_at: new Date().toISOString(), status: 'closed' })
        .eq('student_id', user.id)
        .is('ended_at', null)

      const { data: sess } = await supabase
        .from('sessions')
        .insert({
          student_id: user.id,
          classroom_id: prof?.classroom_id,
          status: 'active'
        })
        .select().single()

      setSession(sess); sessionRef.current = sess

      const { data: { session: authSession } } = await supabase.auth.getSession()
      tokenRef.current = authSession?.access_token
    }
    init()

    // End session when tab is actually closed
    const endSession = () => {
      const s = sessionRef.current
      if (!s || !tokenRef.current) return
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/sessions?id=eq.${s.id}`, {
        method: 'PATCH',
        keepalive: true,
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${tokenRef.current}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ ended_at: new Date().toISOString(), status: 'closed' })
      }).catch(() => {})
    }
    window.addEventListener('pagehide', endSession)

    return () => { cancelled = true; window.removeEventListener('pagehide', endSession) }
  }, [])

  // ---------------------------------------------
  // EFFECT 2: Refresh cached token on auth change
  // ---------------------------------------------
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      tokenRef.current = s?.access_token
      if (s?.access_token) {
        window.postMessage({ type: 'UPDATE_TOKEN', accessToken: s.access_token }, '*')
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // ---------------------------------------------
  // EFFECT 3: THE "ARE YOU SURE YOU WANT TO LEAVE" DIALOG
  // ---------------------------------------------
  useEffect(() => {
    if (!session) return

    const onBeforeUnload = (event) => {
      // Log the close attempt
      const s = sessionRef.current
      const u = userRef.current
      if (s && u && tokenRef.current) {
        fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/focus_events`, {
          method: 'POST',
          keepalive: true,
          headers: {
            apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${tokenRef.current}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            session_id: s.id, student_id: u.id, event_type: 'close_attempt'
          })
        }).catch(() => {})
      }

      // THIS triggers the native confirmation dialog
      event.preventDefault()
      event.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [session])

  // ---------------------------------------------
  // EFFECT 4: Fullscreen escape detection
  // ---------------------------------------------
  useEffect(() => {
    const onFsChange = () => setEscaped(!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)

    const enterFs = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
    }
    document.addEventListener('click', enterFs, { once: true })

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('click', enterFs)
    }
  }, [])

  // ---------------------------------------------
  // EFFECT 5: Heartbeat every 15s
  // ---------------------------------------------
  useEffect(() => {
    if (!session) return
    const hb = setInterval(() => {
      supabase.from('sessions')
        .update({
          last_seen_at: new Date().toISOString(),
          focus_state: document.visibilityState === 'visible' ? 'focused' : 'hidden'
        })
        .eq('id', session.id)
        .then(() => {})
    }, 15000)
    return () => clearInterval(hb)
  }, [session])

  // ---------------------------------------------
  // EFFECT 6: Listen for teacher lock / unlock
  // ---------------------------------------------
  useEffect(() => {
    if (!session) return
    const ch = supabase
      .channel(`session-${session.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions',
          filter: `id=eq.${session.id}` },
        (payload) => {
          if (payload.new.status === 'locked') {
            setLockMessage(payload.new.lock_message || 'Return to the lesson.')
            setLocked(true)
          } else if (payload.new.status === 'active') {
            setLocked(false); setLockMessage('')
          }
        })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [session])

  // ---------------------------------------------
  // EFFECT 7: Wire up extension + poll tabs into Supabase
  // ---------------------------------------------
  useEffect(() => {
    if (!session || !user) return

    // Hand the extension our config
    const announce = () => {
      if (!tokenRef.current) return
      window.postMessage({
        type: 'SET_CONFIG',
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        sessionId: session.id,
        accessToken: tokenRef.current
      }, '*')
    }
    announce()
    const announceTimer = setInterval(announce, 60000)

    // Handle tab results from content script
    const onMessage = async (event) => {
      if (event.source !== window) return
      if (event.data?.type !== 'TABS_RESULT') return
      const tabs = event.data.tabs || []

      await supabase.from('tab_snapshots').delete().eq('session_id', session.id)
      if (tabs.length) {
        await supabase.from('tab_snapshots').insert(
          tabs.map(t => ({
            session_id: session.id,
            student_id: user.id,
            tab_id: t.id,
            url: t.url,
            title: t.title,
            favicon_url: t.favicon,
            active: t.active
          }))
        )
      }
      await supabase.from('sessions')
        .update({ extension_connected: true })
        .eq('id', session.id)
    }
    window.addEventListener('message', onMessage)

    // Poll for tabs every 8 seconds
    const poll = () => window.postMessage({ type: 'GET_TABS' }, '*')
    poll()
    const tabTimer = setInterval(poll, 8000)

    return () => {
      clearInterval(announceTimer)
      clearInterval(tabTimer)
      window.removeEventListener('message', onMessage)
    }
  }, [session, user])

  // ---------------------------------------------
  // RENDER
  // ---------------------------------------------
  if (!session) return <div className="p-8">Loading…</div>

  return (
    <div className="min-h-screen bg-white p-8">
      <h1 className="text-2xl font-bold">Lesson</h1>
      <p className="text-gray-500 mt-2">
        Signed in as {profile?.full_name || user?.email}
      </p>

      {escaped && !locked && (
        <div className="fixed inset-0 z-50 bg-black/90 text-white
                        flex flex-col items-center justify-center gap-4">
          <p className="text-xl">You left fullscreen mode.</p>
          <button
            onClick={() => document.documentElement.requestFullscreen()}
            className="px-6 py-3 bg-white text-black rounded-lg">
            Return to fullscreen
          </button>
        </div>
      )}

      {locked && (
        <div className="fixed inset-0 z-[9999] bg-black text-white
                        flex flex-col items-center justify-center gap-4">
          <h2 className="text-2xl font-semibold">Focus mode</h2>
          <p className="opacity-80">{lockMessage}</p>
        </div>
      )}
    </div>
  )
}
