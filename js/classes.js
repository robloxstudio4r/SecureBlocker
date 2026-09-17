import { supabase } from './supabase-client.js';
import { requireAuth, signOut } from './auth.js';

const authSession = await requireAuth(['teacher', 'admin']);
if (!authSession) throw new Error('not authorized');

const me = authSession.user;
const myRole = me.app_metadata?.role || 'teacher';

if (myRole === 'admin') document.getElementById('adminLink').hidden = false;
document.getElementById('logout').addEventListener('click', signOut);

let classes = [];
let activeClassId = null;
let members = [];   // { class_id, student_id, email, full_name, pending }
let invites = [];   // { id, class_id, email, resolved }

// -----------------------------------------------------------------
// LOAD
// -----------------------------------------------------------------
async function load() {
  const { data: cls } = await supabase
    .from('classes')
    .select('*, profiles!classes_teacher_id_fkey(email)')
    .order('created_at', { ascending: false });

  classes = cls ?? [];

  const { data: mem } = await supabase
    .from('class_members')
    .select('*, profiles!class_members_student_id_fkey(email, full_name)');

  members = (mem ?? []).map(m => ({
    class_id: m.class_id,
    student_id: m.student_id,
    email: m.profiles?.email,
    full_name: m.profiles?.full_name,
    pending: false
  }));

  const { data: inv } = await supabase
    .from('class_invites')
    .select('*')
    .eq('resolved', false);

  invites = inv ?? [];

  render();
}

// -----------------------------------------------------------------
// REALTIME
// -----------------------------------------------------------------
supabase.channel('classes-stream')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' },
    () => load())
  .on('postgres_changes', { event: '*', schema: 'public', table: 'class_members' },
    () => load())
  .on('postgres_changes', { event: '*', schema: 'public', table: 'class_invites' },
    () => load())
  .subscribe();

// -----------------------------------------------------------------
// ACTIONS
// -----------------------------------------------------------------
async function createClass() {
  const name = prompt('Class name?');
  if (!name || !name.trim()) return;
  const { data, error } = await supabase.from('classes')
    .insert({ name: name.trim(), teacher_id: me.id })
    .select().single();
  if (error) { alert(error.message); return; }
  activeClassId = data.id;
  await load();
}

async function deleteClass(id) {
  if (!confirm('Delete this class and remove all its members?')) return;
  const { error } = await supabase.from('classes').delete().eq('id', id);
  if (error) { alert('Could not delete class: ' + error.message); return; }
  if (activeClassId === id) activeClassId = null;
  await load();
}

async function addByEmail(email) {
  const clean = email.trim().toLowerCase();
  if (!clean) return;
  const errEl = document.getElementById('addErr');
  errEl.hidden = true;

  // Try to find an existing user
  const { data: found } = await supabase
    .from('profiles')
    .select('id, email, role')
    .ilike('email', clean)
    .maybeSingle();

  if (found) {
    if (found.role !== 'student') {
      errEl.textContent = 'That email belongs to a teacher or admin, not a student.';
      errEl.hidden = false;
      return;
    }
    const { error } = await supabase.from('class_members').insert({
      class_id: activeClassId,
      student_id: found.id,
      added_by: me.id
    });
    if (error && !/duplicate/i.test(error.message)) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
  } else {
    const { error } = await supabase.from('class_invites').insert({
      class_id: activeClassId,
      email: clean,
      added_by: me.id
    });
    if (error && !/duplicate/i.test(error.message)) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
  }

  document.getElementById('addEmail').value = '';
  await load();
}

async function removeMember(studentId) {
  if (!confirm('Remove this student from the class?')) return;
  const { error } = await supabase.from('class_members')
    .delete()
    .eq('class_id', activeClassId)
    .eq('student_id', studentId);
  if (error) { alert('Could not remove student: ' + error.message); return; }
  await load();
}

async function removeInvite(id) {
  const { error } = await supabase.from('class_invites').delete().eq('id', id);
  if (error) { alert('Could not cancel invite: ' + error.message); return; }
  await load();
}

// -----------------------------------------------------------------
// RENDER
// -----------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function render() {
  // Left: class list
  const host = document.getElementById('classList');
  if (!classes.length) {
    host.innerHTML = '<p style="font-size:13px;color:#888;padding:8px;">No classes yet.</p>';
  } else {
    host.innerHTML = classes.map(c => {
      const count = members.filter(m => m.class_id === c.id).length
                  + invites.filter(i => i.class_id === c.id).length;
      const isActive = c.id === activeClassId ? 'active' : '';
      return `
        <div class="class-item ${isActive}" data-id="${c.id}">
          <span>${esc(c.name)}</span>
          <span class="count">${count}</span>
        </div>`;
    }).join('');
    host.querySelectorAll('.class-item').forEach(el => {
      el.addEventListener('click', () => {
        activeClassId = el.dataset.id;
        render();
      });
    });
  }

  // Right: class detail
  const empty = document.getElementById('emptyState');
  const detail = document.getElementById('classDetail');

  if (!activeClassId) {
    empty.hidden = false;
    detail.hidden = true;
    return;
  }

  const active = classes.find(c => c.id === activeClassId);
  if (!active) {
    activeClassId = null;
    empty.hidden = false;
    detail.hidden = true;
    return;
  }

  empty.hidden = true;
  detail.hidden = false;
  document.getElementById('className').textContent = active.name;

  const classMembers = members.filter(m => m.class_id === activeClassId);
  const classInvites = invites.filter(i => i.class_id === activeClassId);

  const rows = [];
  for (const m of classMembers) {
    rows.push(`
      <div class="member-row">
        <span class="grow">
          <strong>${esc(m.full_name || m.email)}</strong>
          <span style="color:#999;"> · ${esc(m.email)}</span>
        </span>
        <button class="btn-sm btn-red" data-remove="${m.student_id}">Remove</button>
      </div>`);
  }
  for (const i of classInvites) {
    rows.push(`
      <div class="member-row">
        <span class="grow">
          <strong>${esc(i.email)}</strong>
          <span class="pending"> · pending signup</span>
        </span>
        <button class="btn-sm btn-gray" data-cancel="${i.id}">Cancel</button>
      </div>`);
  }

  const mHost = document.getElementById('members');
  mHost.innerHTML = rows.length ? rows.join('') : '<p style="color:#888;font-size:13px;">No members yet.</p>';

  mHost.querySelectorAll('[data-remove]').forEach(b =>
    b.addEventListener('click', () => removeMember(b.dataset.remove)));
  mHost.querySelectorAll('[data-cancel]').forEach(b =>
    b.addEventListener('click', () => removeInvite(Number(b.dataset.cancel))));
}

// -----------------------------------------------------------------
// WIRE UP
// -----------------------------------------------------------------
document.getElementById('newClassBtn').addEventListener('click', createClass);
document.getElementById('deleteClass').addEventListener('click', () => {
  if (activeClassId) deleteClass(activeClassId);
});
document.getElementById('addBtn').addEventListener('click', () => {
  addByEmail(document.getElementById('addEmail').value);
});
document.getElementById('addEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addByEmail(e.target.value);
});

load();
