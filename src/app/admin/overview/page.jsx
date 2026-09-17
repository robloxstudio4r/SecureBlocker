'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function AdminOverview() {
  const [sessions, setSessions] = useState([])
  const [tabs, setTabs] = useState({})
  const [events, setEvents] = useState([])
  const [classrooms, setClassrooms] = useState({})

  // ---------------------------------------------
  // Initial load
  // ---------------------------------------------
  useEffect(() => {
    async function load() {
      const [sRes, tRes, eRes, pRes] = await Promise.all([
        supabase.from('sessions')
          .select('*, profiles!sessions_student_id_fkey(email, full_name, role, classroom_id)')
          .is('ended_at', null)
          .order('started_at', { ascending: false }),
        supabase.from('tab_snapshots').select('*'),
        supabase.from('focus_events')
          .select('*, profiles!focus_events_student_id_fkey(email)')
          .order('occurred_at', { ascending: false })
          .limit(200),
        supabase.from('profiles').select('*')
      ])

      setSessions(sRes.data ?? [])
      setEvents(eRes.data ?? [])

      const map = {}
      for (const t of tRes.data ?? []) {
        ;(map[t.session_id] ||= []).push(t)
      }
      setTabs(map)

      const cls = {}
      for (const p of pRes.data ?? []) {
        if (p.classroom_id) (cls[p.classroom_id] ||= []).push(p)
      }
      setClassrooms(cls)
    }
    load()
  }, [])

  // ---------------------------------------------
  // Realtime subscriptions
  // ---------------------------------------------
  useEffect(() => {
    const ch = supabase
      .channel('admin-stream')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'sessions' },
        (payload) => {
          setSessions(prev => {
            const list = [...prev]
            const i = list.findIndex(s => s.id === payload.new?.id || s.id === payload.old?.id)
            if (payload.eventType === 'DELETE') {
              if (i >= 0) list.splice(i, 1)
              return list
            }
            if (i >= 0) list[i] = { ...list[i], ...payload.new }
            else list.unshift(payload.new)
            return list
          })
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'tab_snapshots' },
        (payload) => {
          setTabs(prev => {
            const sid = payload.new?.session_id || payload.old?.session_id
            const list = [...(prev[sid] ?? [])]
            if (payload.eventType === 'DELETE') {
              return { ...prev, [sid]: list.filter(t => t.tab_id !== payload.old.tab_id) }
            }
            const i = list.findIndex(t => t.tab_id === payload.new.tab_id)
            if (i >= 0) list[i] = payload.new
            else list.push(payload.new)
            return { ...prev, [sid]: list }
          })
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'focus_events' },
        (payload) => {
          setEvents(prev => [payload.new, ...prev].slice(0, 200))
        })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])

  // ---------------------------------------------
  // Actions
  // ---------------------------------------------
  const closeTab = async (sessionId, studentId, tabId, url) => {
    let domain = ''
    try { domain = new URL(url).hostname } catch {}
    await supabase.from('tab_commands').insert({
      target_session_id: sessionId,
      target_student_id: studentId,
      command: 'close',
      tab_id: tabId,
      domain
    })
  }

  const focusTab = async (sessionId, studentId, tabId) => {
    await supabase.from('tab_commands').insert({
      target_session_id: sessionId,
      target_student_id: studentId,
      command: 'focus',
      tab_id: tabId
    })
  }

  const closeAllTabs = async (session) => {
    const list = tabs[session.id] ?? []
    for (const t of list) {
      await closeTab(session.id, session.student_id, t.tab_id, t.url)
    }
  }

  const lockStudent = async (sessionId, message) => {
    await supabase.from('sessions')
      .update({ status: 'locked', lock_message: message })
      .eq('id', sessionId)
  }

  const unlockStudent = async (sessionId) => {
    await supabase.from('sessions')
      .update({ status: 'active', lock_message: null })
      .eq('id', sessionId)
  }

  const endSession = async (sessionId) => {
    await supabase.from('sessions')
      .update({ ended_at: new Date().toISOString(), status: 'closed' })
      .eq('id', sessionId)
  }

  // ---------------------------------------------
  // Derived stats
  // ---------------------------------------------
  const stats = useMemo(() => {
    const total = sessions.length
    const lockedCount = sessions.filter(s => s.status === 'locked').length
    const closedAttempts = events.filter(e => e.event_type === 'close_attempt').length
    const totalTabs = Object.values(tabs).reduce((a, l) => a + l.length, 0)
    return { total, lockedCount, closedAttempts, totalTabs }
  }, [sessions, events, tabs])

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      <h1 className="text-3xl font-bold">Admin Overview</h1>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Stat label="Active sessions" value={stats.total} />
        <Stat label="Locked students" value={stats.lockedCount} />
        <Stat label="Close attempts" value={stats.closedAttempts} />
        <Stat label="Open tabs" value={stats.totalTabs} />
      </div>

      {/* Sessions grid */}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Active Sessions</h2>
        {sessions.map(s => (
          <div key={s.id} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {s.profiles?.full_name || s.profiles?.email || s.student_id}
                </p>
                <p className="text-sm text-gray-500">
                  {s.status} · {s.focus_state} · seen {timeAgo(s.last_seen_at)}
                  {s.extension_connected ? ' · ext ✅' : ' · ext ❌'}
                </p>
              </div>
              <div className="flex gap-2">
                {s.status === 'locked' ? (
                  <button onClick={() => unlockStudent(s.id)}
                    className="px-3 py-1 bg-green-600 text-white text-sm rounded">
                    Unlock
                  </button>
                ) : (
                  <button onClick={() => lockStudent(s.id, 'Focus on the lesson.')}
                    className="px-3 py-1 bg-yellow-600 text-white text-sm rounded">
                    Lock
                  </button>
                )}
                <button onClick={() => closeAllTabs(s)}
                  className="px-3 py-1 bg-red-600 text-white text-sm rounded">
                  Close all tabs
                </button>
                <button onClick={() => endSession(s.id)}
                  className="px-3 py-1 bg-gray-700 text-white text-sm rounded">
                  End session
                </button>
              </div>
            </div>

            {/* Tabs list */}
            <div className="space-y-1">
              {(tabs[s.id] ?? []).map(t => (
                <div key={t.tab_id}
                  className="flex items-center gap-2 text-sm bg-gray-50 rounded p-2">
                  {t.favicon_url && (
                    <img src={t.favicon_url} className="w-4 h-4" alt="" />
                  )}
                  <span className="flex-1 truncate">{t.title || t.url}</span>
                  <span className="text-xs text-gray-400 truncate max-w-[220px]">
                    {t.url}
                  </span>
                  <button
                    onClick={() => focusTab(s.id, s.student_id, t.tab_id)}
                    className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded">
                    Focus
                  </button>
                  <button
                    onClick={() => closeTab(s.id, s.student_id, t.tab_id, t.url)}
                    className="px-2 py-0.5 bg-red-600 text-white text-xs rounded">
                    Close
                  </button>
                </div>
              ))}
              {!(tabs[s.id]?.length) && (
                <p className="text-xs text-gray-400">No tab data yet.</p>
              )}
            </div>
          </div>
        ))}
        {!sessions.length && <p className="text-gray-500">No active sessions.</p>}
      </section>

      {/* Event log */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Recent Events</h2>
        <div className="border rounded-lg divide-y max-h-[400px] overflow-y-auto">
          {events.map(e => (
            <div key={e.id} className="p-3 flex items-center justify-between text-sm">
              <span>
                <span className="font-medium">{e.profiles?.email ?? e.student_id}</span>
                {' · '}
                <span className={
                  e.event_type === 'close_attempt'
                    ? 'text-red-600 font-medium'
                    : 'text-gray-600'
                }>
                  {e.event_type}
                </span>
              </span>
              <span className="text-gray-400">{timeAgo(e.occurred_at)}</span>
            </div>
          ))}
          {!events.length && <p className="p-3 text-gray-400">No events yet.</p>}
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="border rounded-lg p-4">
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  )
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}
