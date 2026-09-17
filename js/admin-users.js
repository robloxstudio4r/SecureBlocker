import { supabase } from './supabase-client.js';
import { requireAuth } from './auth.js';

const authSession = await requireAuth(['admin']);
if (!authSession) throw new Error('not authorized');

async function load() {
  const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
  render(data ?? []);
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function render(users) {
  const rows = document.getElementById('rows');
  rows.innerHTML = users.map(u => `
    <tr data-id="${u.id}">
      <td>${esc(u.email)}</td>
      <td>${esc(u.full_name)}</td>
      <td>
        <select class="role">
          <option value="student" ${u.role === 'student' ? 'selected' : ''}>Student</option>
          <option value="teacher" ${u.role === 'teacher' ? 'selected' : ''}>Teacher</option>
          <option value="admin"   ${u.role === 'admin'   ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td><input class="classroom" value="${esc(u.classroom_id ?? '')}" placeholder="(none)" /></td>
    </tr>`).join('');

  rows.querySelectorAll('tr').forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector('.role').addEventListener('change', async (e) => {
      const newRole = e.target.value;
      const { error } = await supabase.functions.invoke('update-role', {
        body: { userId: id, role: newRole }
      });
      if (error) { alert(error.message); return; }
      const { error: profErr } = await supabase.from('profiles').update({ role: newRole }).eq('id', id);
      if (profErr) { console.error('[admin-users] profiles.role update failed:', profErr); alert(profErr.message); }
    });
    tr.querySelector('.classroom').addEventListener('blur', async (e) => {
      const v = e.target.value.trim();
      const { error } = await supabase.from('profiles').update({ classroom_id: v || null }).eq('id', id);
      if (error) { console.error('[admin-users] classroom update failed:', error); alert(error.message); }
    });
  });
}

load();
