'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function AdminUsers() {
  const [users, setUsers] = useState([])

  useEffect(() => {
    supabase.from('profiles').select('*').order('created_at', { ascending: false })
      .then(({ data }) => setUsers(data ?? []))
  }, [])

  const updateRole = async (userId, newRole) => {
    // Update JWT metadata via edge function or admin API
    // (client-side: use a Supabase Edge Function — see note below)
    const { error } = await supabase.functions.invoke('update-role', {
      body: { userId, role: newRole }
    })
    if (error) { alert(error.message); return }

    await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
  }

  const setClassroom = async (userId, classroomId) => {
    await supabase.from('profiles')
      .update({ classroom_id: classroomId || null })
      .eq('id', userId)
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, classroom_id: classroomId } : u))
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">User Management</h1>
      <table className="w-full text-sm">
        <thead className="text-left border-b">
          <tr>
            <th className="py-2">Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Classroom ID</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id} className="border-b">
              <td className="py-2">{u.email}</td>
              <td>{u.full_name}</td>
              <td>
                <select value={u.role}
                  onChange={(e) => updateRole(u.id, e.target.value)}
                  className="border rounded px-2 py-1">
                  <option value="student">Student</option>
                  <option value="teacher">Teacher</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td>
                <input
                  defaultValue={u.classroom_id ?? ''}
                  onBlur={(e) => setClassroom(u.id, e.target.value.trim())}
                  placeholder="(none)"
                  className="border rounded px-2 py-1 w-full"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
