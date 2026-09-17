'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { useFullscreenLock } from '@/hooks/useFullscreenLock'

export default function StudentPage() {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [locked, setLocked] = useState(false)
  const [lockMessage, setLockMessage] = useState('')

  const { escaped, requestLock } = useFullscreenLock(true)

  // Load user + create session
  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUser(user)

      const { data: profile } = await supabase
        .from('profiles').select('*').eq('id', user.id).single()

      const { data: sess } = await supabase
        .from('sessions')
        .insert({ student_id: user.id, classroom_id: profile?.classroom_id })
        .select().single()

      setSession(sess)

      // Enter fullscreen on first click
      document.addEventListener('click', requestLock, { once: true })
    }
    init()
  }, [])

  // Heartbeat every 15s
  useEffect(() => {
    if (!session) return
    const hb = setInterval(() => {
      supabase.from('sessions')
        .update({ last_seen_at: new Date().toISOString(), focus_state: 'focused' })
        .eq('id', session.id)
    }, 15000)
    return () => clearInterval(hb)
  }, [session])

  // Listen for teacher lock/unlock
  useEffect(() => {
    if (!session) return
    const ch = supabase.channel(`session-${session.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions',
          filter: `id=eq.${session.id}` },
        (payload) => {
          if (payload.new.status === 'locked') {
            setLockMessage(payload.new.lock_message || 'Return to the lesson.')
            setLocked(true)
          } else if (payload.new.status === 'active') {
            setLocked(false)
          }
        })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [session])

  // Register the leave guard
  useLeaveGuard(session?.id, user?.id)

  if (!session) return <div>Loading…</div>

  return (
    <div className="min-h-screen bg-white">
      {/* Your lesson content goes here */}
      <h1>Lesson</h1>

      {/* Fullscreen escape overlay */}
      {escaped && !locked && (
        <div className="fixed inset-0 z-50 bg-black/90 text-white
                        flex flex-col items-center justify-center gap-4">
          <p>You left fullscreen mode.</p>
          <button onClick={requestLock}
            className="px-6 py-3 bg-white text-black rounded-lg">
            Return to fullscreen
          </button>
        </div>
      )}

      {/* Teacher lock overlay */}
      {locked && (
        <div className="fixed inset-0 z-[9999] bg-black text-white
                        flex flex-col items-center justify-center gap-4">
          <h2 className="text-2xl">Focus mode</h2>
          <p>{lockMessage}</p>
        </div>
      )}
    </div>
  )
}
