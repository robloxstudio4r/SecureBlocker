import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'

export function useLeaveGuard(sessionId, studentId) {
  const tokenRef = useRef(null)

  // Cache auth token so the beacon can fire synchronously
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      tokenRef.current = data.session?.access_token
    })
  }, [])

  useEffect(() => {
    if (!sessionId) return

    // THIS is the "are you sure you want to leave" dialog
    const onBeforeUnload = (event) => {
      // Log the attempt to Supabase (fire-and-forget, survives unload)
      beacon('close_attempt')

      // Trigger the native confirmation dialog
      event.preventDefault()
      event.returnValue = ''   // Chrome, Edge, Firefox all show the dialog
      return ''
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [sessionId])

  const beacon = (eventType, meta = {}) => {
    if (!tokenRef.current) return
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/focus_events`, {
      method: 'POST',
      keepalive: true,   // critical: survives page teardown
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${tokenRef.current}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        session_id: sessionId,
        student_id: studentId,
        event_type: eventType,
        meta
      })
    }).catch(() => {})
  }
}
