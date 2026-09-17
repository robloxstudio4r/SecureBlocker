'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function TeacherRoster() {
  const [sessions, setSessions] = useState([])
  const [tabs, setTabs] = useState({})

  useEffect(() => {
    // Initial load: active sessions in my classroom
    supabase.from('sessions')
      .select('*, profiles!sessions_student_id_fkey(email, full_name)')
      .is('ended_at', null)
      .then(({ data }) => setSessions(data ?? []))

    // Realtime: new sessions, session updates
    const ch = supabase.channel('teacher-roster')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'sessions' },
        (payload) => {
          setSessions(prev => upsert(prev, payload.new))
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'tab_snapshots' },
        (payload) => {
          setTabs(prev => {
            const list = [...(prev[payload.new.session_id] ?? [])]
            const idx = list.findIndex(t => t.tab_id === payload.new.tab_id)
            if (idx >= 0) list[idx] = payload.new
            else list.push(payload.new)
            return { ...prev, [payload.new.session_id]: list }
          })
        })
      .subscribe()

    return () => supabase.removeChannel(ch)
  }, [])

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

  const lockStudent = async (sessionId, message) => {
    await supabase.from('sessions')
      .update({ status: 'locked', lock_message: message })
      .eq('id', sessionId)
  }

  const unlockStudent = async (sessionId) => {
    await supabase.from('sessions')
      .update({ status: 'active' })
      .eq('id', sessionId)
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Classroom Roster</h1>

      {sessions.map(session => (
        <div key={session.id} className="border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">
                {session.profiles?.full_name || session.profiles?.email}
              </p>
              <p className="text-sm text-gray-500">
                {session.focus_state} · seen {timeAgo(session.last_seen_at)}
              </p>
            </div>
            <div className="flex gap-2">
              {session.status === 'locked' ? (
                <button onClick={() => unlockStudent(session.id)}
                  className="px-3 py-1 bg-green-600 text-white rounded">
                  Unlock
                </button>
              ) : (
                <button onClick={() => lockStudent(session.id, 'Focus on the lesson.')}
                  className="px-3 py-1 bg-yellow-600 text-white rounded">
                  Lock
                </button>
              )}
            </div>
          </div>

          {/* Open tabs */}
          <div className="space-y-1">
            {(tabs[session.id] ?? []).map(tab => (
              <div key={tab.tab_id}
                className="flex items-center gap-2 text-sm bg-gray-50 rounded p-2">
                {tab.favicon_url && <img src={tab.favicon_url} className="w-4 h-4" />}
                <span className="flex-1 truncate">{tab.title || tab.url}</span>
                <span className="text-xs text-gray-400 truncate max-w-[200px]">
                  {tab.url}
                </span>
                <button
                  onClick={() => closeTab(session.id, session.student_id,
                                         tab.tab_id, tab.url)}
                  className="px-2 py-0.5 bg-red-600 text-white text-xs rounded">
                  Close
                </button>
              </div>
            ))}
            {!(tabs[session.id]?.length) && (
              <p className="text-xs text-gray-400">No tab data yet.</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function upsert(list, row) {
  const idx = list.findIndex(s => s.id === row.id)
  if (idx >= 0) { const next = [...list]; next[idx] = row; return next }
  return [...list, row]
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  return `${Math.floor(s/3600)}h ago`
}
