import { supabase } from './supabase-client.js';
import { requireAuth, signOut } from './auth.js';

const authSession = await requireAuth(['admin']);
if (!authSession) throw new Error('not authorized');
document.getElementById('logout').addEventListener('click', signOut);

const sessionsMap = new Map();
const tabsMap = new Map();
const loadedScreenshots = new Map();
const events = [];

// -----------------------------------------------------------------
// LOAD
// -----------------------------------------------------------------
async function load() {
  const [{ data: sessions }, { data: tabs }, { data: evs }] = await Promise.all([
    supabase.from('sessions')
      .select('*, profiles!sessions_student_id_fkey(email, full_name)')
      .is('ended_at', null)
      .order('started_at', { ascending: false }),
    supabase.from('tab_snapshots').select('*'),
    supabase.from('focus_events')
      .select('*, profiles!focus_events_student_id_fkey(email)')
      .order('occurred_at', { ascending: false })
      .limit(200)
  ]);

  sessionsMap.clear();
  (sessions ?? []).forEach(s => sessionsMap.set(s.id, s));

  tabsMap.clear();
  (tabs ?? []).forEach(t => {
    if (!tabsMap.has(t.session_id)) tabsMap.set(t.session_id, []);
    tabsMap.get(t.session_id).push(t);
  });

  events.length = 0;
  events.push(...(evs ?? []));
  render();
}

// -----------------------------------------------------------------
// REALTIME
// -----------------------------------------------------------------
supabase.channel('admin-stream')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' },
    (p) => {
      if (p.eventType === 'DELETE' || p.new?.ended_at) {
        sessionsMap.delete(p.new?.id ?? p.old.id);
      } else {
        sessionsMap.set(p.new.id, { ...sessionsMap.get(p.new.id), ...p.new });
      }
      render();
    })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'tab_snapshots' },
    (p) => {
      if (p.eventType === 'DELETE') {
        const arr = tabsMap.get(p.old.session_id) ?? [];
        tabsMap.set(p.old.session_id, arr.filter(t => t.tab_id !== p.old.tab_id));
      } else {
        const arr = tabsMap.get(p.new.session_id) ?? [];
        const i = arr.findIndex(t => t.tab_id === p.new.tab_id);
        if (i >= 0) arr[i] = p.new; else arr.push(p.new);
        tabsMap.set(p.new.session_id, [...arr]);
      }
      render();
    })
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'focus_events' },
    (p) => {
      events.unshift(p.new);
      if (events.length > 200) events.pop();
      render();
    })
  .subscribe();

// -----------------------------------------------------------------
// ACTIONS
// -----------------------------------------------------------------
async function closeTab(sessionId, studentId, tabId, url) {
  let domain = '';
  try { domain = new URL(url).hostname; } catch {}
  await supabase.from('tab_commands').insert({
    target_session_id: sessionId, target_student_id: studentId,
    command: 'close', tab_id: tabId, domain
  });
}
async function closeAll(sessionId, studentId) {
  const list = tabsMap.get(sessionId) ?? [];
  for (const t of list) await closeTab(sessionId, studentId, t.tab_id, t.url);
}
async function focusTab(sessionId, studentId, tabId) {
  await supabase.from('tab_commands').insert({
    target_session_id: sessionId, target_student_id: studentId,
    command: 'focus', tab_id: tabId
  });
}
async function requestScreenshot(sessionId, studentId) {
  await supabase.from('tab_commands').insert({
    target_session_id: sessionId, target_student_id: studentId,
    command: 'screenshot'
  });
}
async function lock(id) {
  await supabase.from('sessions').update({
    status: 'locked', lock_message: 'Focus on the lesson.'
  }).eq('id', id);
}
async function unlock(id) {
  await supabase.from('sessions').update({ status: 'active' }).eq('id', id);
}
async function endSession(id) {
  await supabase.from('sessions').update({
    ended_at: new Date().toISOString(), status: 'closed'
  }).eq('id', id);
}

// -----------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------
function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
async function refreshScreenshots() {
  const imgs = document.querySelectorAll('.screenshot[data-sid]');
  for (const img of imgs) {
    const sid = img.dataset.sid;
    const session = sessionsMap.get(sid);
    if (!session?.last_screenshot_at) continue;
    if (loadedScreenshots.get(sid) === session.last_screenshot_at) continue;

    const { data, error } = await supabase.storage
      .from('screenshots')
      .createSignedUrl(`${sid}.jpg`, 600);

    if (!error && data?.signedUrl) {
      img.src = data.signedUrl;
      loadedScreenshots.set(sid, session.last_screenshot_at);
    }
  }
}
function openModal(src, alt) {
  const div = document.createElement('div');
  div.className = 'screen-modal';
  div.innerHTML = `<img src="${src}" alt="${esc(alt)}" />`;
  div.addEventListener('click', () => div.remove());
  document.body.appendChild(div);
}

// -----------------------------------------------------------------
// RENDER
// -----------------------------------------------------------------
function render() {
  const sessions = Array.from(sessionsMap.values());
  const tabsTotal = Array.from(tabsMap.values()).reduce((a, l) => a + l.length, 0);

  document.getElementById('statTotal').textContent = sessions.length;
  document.getElementById('statLocked').textContent = sessions.filter(s => s.status === 'locked').length;
  document.getElementById('statCloses').textContent = events.filter(e => e.event_type === 'close_attempt').length;
  document.getElementById('statTabs').textContent = tabsTotal;

  const host = document.getElementById('roster');
  host.innerHTML = sessions.length ? sessions.map(s => {
    const tabs = tabsMap.get(s.id) ?? [];
    const current = tabs.find(t => t.active);
    const others = tabs.filter(t => !t.active);
    const name = s.profiles?.full_name || s.profiles?.email || s.student_id;

    const lockBtn = s.status === 'locked'
      ? `<button class="btn-sm btn-green" data-act="unlock" data-id="${s.id}">Unlock</button>`
      : `<button class="btn-sm btn-yellow" data-act="lock" data-id="${s.id}">Lock</button>`;

    const screenHtml = s.last_screenshot_at
      ? `<div class="screen-wrap">
           <span class="badge">Screen · ${timeAgo(s.last_screenshot_at)}</span>
           <img class="screenshot" data-sid="${s.id}" alt="Screen of ${esc(name)}" />
         </div>`
      : `<div class="screen-empty">No screenshot yet</div>`;

    const currentHtml = current ? `
      <p style="font-size:11px;color:#666;margin-bottom:4px;">CURRENT TAB</p>
      <div class="tab-row current">
        ${current.favicon_url ? `<img src="${esc(current.favicon_url)}" />` : ''}
        <span class="title">${esc(current.title || current.url)}</span>
        <span class="url">${esc(current.url)}</span>
      </div>` : '';

    const othersHtml = others.length ? `
      <p style="font-size:11px;color:#666;margin:10px 0 4px;">OTHER OPEN TABS (${others.length})</p>
      ${others.map(t => `
        <div class="tab-row">
          ${t.favicon_url ? `<img src="${esc(t.favicon_url)}" />` : ''}
          <span class="title">${esc(t.title || t.url)}</span>
          <span class="url">${esc(t.url)}</span>
          <button class="btn-sm btn-blue" data-act="focus-tab"
            data-sid="${s.id}" data-uid="${s.student_id}"
            data-tid="${t.tab_id}">Focus</button>
          <button class="btn-sm btn-red" data-act="close-tab"
            data-sid="${s.id}" data-uid="${s.student_id}"
            data-tid="${t.tab_id}" data-url="${esc(t.url)}">Close</button>
        </div>`).join('')}` : '';

    return `
      <div class="card">
        <div class="row between" style="margin-bottom:12px;">
          <div>
            <strong>${esc(name)}</strong>
            <div style="font-size:12px;color:#666;">
              ${s.status} · ${s.focus_state} · seen ${timeAgo(s.last_seen_at)}
              ${s.extension_connected ? ' · ext ✅' : ' · ext ❌'}
            </div>
          </div>
          <div class="row">
            ${lockBtn}
            <button class="btn-sm btn-blue" data-act="screenshot"
              data-sid="${s.id}" data-uid="${s.student_id}">Capture now</button>
            <button class="btn-sm btn-red" data-act="close-all"
              data-sid="${s.id}" data-uid="${s.student_id}">Close all</button>
            <button class="btn-sm btn-gray" data-act="end"
              data-id="${s.id}">End</button>
          </div>
        </div>
        <div class="session-body">
          <div>
            ${currentHtml}
            ${othersHtml}
            ${!tabs.length ? '<p style="font-size:12px;color:#999;">No tabs reported yet.</p>' : ''}
          </div>
          <div>${screenHtml}</div>
        </div>
      </div>`;
  }).join('') : '<p>No active sessions.</p>';

  document.getElementById('events').innerHTML = events.length ? events.map(e => `
    <div class="event-row">
      <span>
        <strong>${esc(e.profiles?.email ?? e.student_id)}</strong> ·
        <span class="${e.event_type === 'close_attempt' ? 'event-close' : ''}">
          ${esc(e.event_type)}
        </span>
      </span>
      <span style="color:#999;">${timeAgo(e.occurred_at)}</span>
    </div>`).join('') : '<div class="event-row">No events yet.</div>';

  host.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const a = btn.dataset.act;
      if (a === 'lock')       await lock(btn.dataset.id);
      if (a === 'unlock')     await unlock(btn.dataset.id);
      if (a === 'end')        await endSession(btn.dataset.id);
      if (a === 'close-tab')  await closeTab(btn.dataset.sid, btn.dataset.uid,
                                             Number(btn.dataset.tid), btn.dataset.url);
      if (a === 'focus-tab')  await focusTab(btn.dataset.sid, btn.dataset.uid,
                                             Number(btn.dataset.tid));
      if (a === 'close-all')  await closeAll(btn.dataset.sid, btn.dataset.uid);
      if (a === 'screenshot') await requestScreenshot(btn.dataset.sid, btn.dataset.uid);
    });
  });

  host.querySelectorAll('.screen-wrap').forEach(wrap => {
    wrap.addEventListener('click', () => {
      const img = wrap.querySelector('img');
      if (img?.src) openModal(img.src, img.alt);
    });
  });

  refreshScreenshots();
}

setInterval(refreshScreenshots, 15000);

load();
