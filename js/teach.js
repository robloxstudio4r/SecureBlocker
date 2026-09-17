import { supabase } from './supabase-client.js';
import { requireAuth, signOut } from './auth.js';

const authSession = await requireAuth(['teacher', 'admin']);
if (!authSession) throw new Error('not authorized');

const role = authSession.user.app_metadata?.role;
if (role === 'admin') document.getElementById('adminLink').hidden = false;
document.getElementById('logout').addEventListener('click', signOut);

const sessionsMap = new Map();
const tabsMap = new Map();          // sessionId -> tab[]
const loadedScreenshots = new Map(); // sessionId -> last_screenshot_at

// -----------------------------------------------------------------
// LOAD
// -----------------------------------------------------------------
async function load() {
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*, profiles!sessions_student_id_fkey(email, full_name)')
    .is('ended_at', null)
    .order('started_at', { ascending: false });

  sessionsMap.clear();
  for (const s of sessions ?? []) sessionsMap.set(s.id, s);

  const { data: tabs } = await supabase.from('tab_snapshots').select('*');
  tabsMap.clear();
  for (const t of tabs ?? []) {
    if (!tabsMap.has(t.session_id)) tabsMap.set(t.session_id, []);
    tabsMap.get(t.session_id).push(t);
  }
  render();
}

// -----------------------------------------------------------------
// REALTIME
// -----------------------------------------------------------------
supabase.channel('teacher-stream')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' },
    (p) => {
      if (p.eventType === 'DELETE') sessionsMap.delete(p.old.id);
      else if (p.new.ended_at) sessionsMap.delete(p.new.id);
      else sessionsMap.set(p.new.id, { ...sessionsMap.get(p.new.id), ...p.new });
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
  const host = document.getElementById('roster');
  const sessions = Array.from(sessionsMap.values());

  if (!sessions.length) {
    host.innerHTML = '<p>No active students.</p>';
    return;
  }

  host.innerHTML = sessions.map(s => {
    const tabs = tabsMap.get(s.id) ?? [];
    const current = tabs.find(t => t.active);
    const others = tabs.filter(t => !t.active);
    const name = s.profiles?.full_name || s.profiles?.email || s.student_id;

    const lockBtn = s.status === 'locked'
      ? `<button class="btn-sm btn-green" data-act="unlock" data-id="${s.id}">Unlock</button>`
      : `<button class="btn-sm btn-yellow" data-act="lock" data-id="${s.id}">Lock</button>`;

    const screenHtml = s.last_screenshot_at
      ? `<div class="screen-wrap" data-src-sid="${s.id}">
           <span class="badge">Screen · ${timeAgo(s.last_screenshot_at)}</span>
           <img class="screenshot" data-sid="${s.id}" alt="Screen of ${esc(name)}" />
         </div>`
      : `<div class="screen-empty">No screenshot yet — the extension sends one every 30s</div>`;

    const currentHtml = current ? `
      <div style="margin-bottom:8px;">
        <p style="font-size:11px;color:#666;margin-bottom:4px;">CURRENT TAB</p>
        <div class="tab-row current">
          ${current.favicon_url ? `<img src="${esc(current.favicon_url)}" />` : ''}
          <span class="title">${esc(current.title || current.url)}</span>
          <span class="url">${esc(current.url)}</span>
        </div>
      </div>` : '';

    const othersHtml = others.length ? `
      <p style="font-size:11px;color:#666;margin:8px 0 4px;">OTHER OPEN TABS (${others.length})</p>
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
        </div>`).join('')}
    ` : '';

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
          </div>
        </div>

        <div class="session-body">
          <div>
            ${currentHtml}
            ${othersHtml}
            ${!tabs.length ? '<p style="font-size:12px;color:#999;">No tabs reported yet.</p>' : ''}
          </div>
          <div>
            ${screenHtml}
          </div>
        </div>
      </div>`;
  }).join('');

  host.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const a = btn.dataset.act;
      if (a === 'lock')           await lock(btn.dataset.id);
      if (a === 'unlock')         await unlock(btn.dataset.id);
      if (a === 'close-tab')      await closeTab(btn.dataset.sid, btn.dataset.uid,
                                                 Number(btn.dataset.tid), btn.dataset.url);
      if (a === 'focus-tab')      await focusTab(btn.dataset.sid, btn.dataset.uid,
                                                 Number(btn.dataset.tid));
      if (a === 'close-all')      await closeAll(btn.dataset.sid, btn.dataset.uid);
      if (a === 'screenshot')     await requestScreenshot(btn.dataset.sid, btn.dataset.uid);
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

// Refresh screenshot URLs every 15s in case they expire
setInterval(refreshScreenshots, 15000);

load();
