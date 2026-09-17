import { supabase } from './supabase-client.js';
import { requireAuth, signOut } from './auth.js';

const authSession = await requireAuth(['admin']);
if (!authSession) throw new Error('not authorized');
document.getElementById('logout').addEventListener('click', signOut);

const sessionsMap = new Map();
const tabsMap = new Map();
const loadedScreenshots = new Map();
const events = [];
let modalOpen = false;

// =================================================================
// LOAD
// =================================================================
async function load() {
  const [sessRes, tabsRes, evsRes] = await Promise.all([
    supabase.from('sessions')
      .select('*, profiles(email, full_name)')
      .is('ended_at', null)
      .order('started_at', { ascending: false }),
    supabase.from('tab_snapshots').select('*'),
    supabase.from('focus_events')
      .select('*, profiles(email)')
      .order('occurred_at', { ascending: false })
      .limit(200)
  ]);

  if (sessRes.error) {
    console.error('[admin] sessions error:', sessRes.error);
    document.getElementById('roster').innerHTML =
      `<p style="color:#dc2626;">Query error: ${sessRes.error.message}</p>`;
    return;
  }
  if (tabsRes.error) console.error('[admin] tabs error:', tabsRes.error);
  if (evsRes.error) console.error('[admin] events error:', evsRes.error);

  console.log('[admin] got', sessRes.data?.length ?? 0, 'open sessions');

  sessionsMap.clear();
  for (const s of sessRes.data ?? []) {
    const age = Date.now() - new Date(s.last_seen_at).getTime();
    if (age > 180000) continue;
    sessionsMap.set(s.id, s);
  }

  tabsMap.clear();
  for (const t of tabsRes.data ?? []) {
    if (!tabsMap.has(t.session_id)) tabsMap.set(t.session_id, []);
    tabsMap.get(t.session_id).push(t);
  }

  events.length = 0;
  events.push(...(evsRes.data ?? []));
  render();
}

// =================================================================
// REALTIME
// =================================================================
supabase.channel('admin-stream')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' },
    (p) => {
      if (p.eventType === 'DELETE' || p.new?.ended_at) {
        sessionsMap.delete(p.new?.id ?? p.old.id);
        render();
        return;
      }
      const age = Date.now() - new Date(p.new.last_seen_at).getTime();
      if (age > 180000) {
        sessionsMap.delete(p.new.id);
        render();
        return;
      }
      sessionsMap.set(p.new.id, { ...sessionsMap.get(p.new.id), ...p.new });
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

setInterval(() => {
  let changed = false;
  const cutoff = Date.now() - 180000;
  for (const [id, s] of sessionsMap) {
    if (new Date(s.last_seen_at).getTime() < cutoff) {
      sessionsMap.delete(id);
      changed = true;
    }
  }
  if (changed) render();
}, 30000);

// =================================================================
// ACTIONS
// =================================================================
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

// =================================================================
// HELPERS
// =================================================================
function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isLive(iso) {
  if (!iso) return false;
  return (Date.now() - new Date(iso).getTime()) < 10000;
}

// =================================================================
// LIVE SCREENSHOT REFRESH
// =================================================================
async function refreshScreenshots() {
  const imgs = document.querySelectorAll('.screenshot[data-sid]');
  for (const img of imgs) {
    const sid = img.dataset.sid;
    const session = sessionsMap.get(sid);
    if (!session?.last_screenshot_at) continue;

    const ageMs = Date.now() - new Date(session.last_screenshot_at).getTime();
    const live = ageMs < 10000;

    const wrap = img.closest('.screen-wrap');
    if (wrap) {
      const badge = wrap.querySelector('.badge');
      if (badge) {
        badge.textContent = live
          ? '🔴 LIVE'
          : `Screen · ${timeAgo(session.last_screenshot_at)}`;
        badge.style.background = live
          ? 'rgba(220,38,38,.9)'
          : 'rgba(0,0,0,.75)';
      }
    }

    if (ageMs > 120000) continue;
    if (loadedScreenshots.get(sid) === session.last_screenshot_at) continue;

    const { data, error } = await supabase.storage
      .from('screenshots')
      .createSignedUrl(`${sid}.jpg`, 600);

    if (!error && data?.signedUrl) {
      img.src = `${data.signedUrl}&t=${Date.now()}`;
      loadedScreenshots.set(sid, session.last_screenshot_at);
    }
  }
}
setInterval(refreshScreenshots, 4000);

// =================================================================
// MODAL
// =================================================================
function openModal(src, alt) {
  if (modalOpen) return;
  modalOpen = true;
  const div = document.createElement('div');
  div.className = 'screen-modal';
  div.innerHTML = `<img src="${src}" alt="${esc(alt)}" />`;
  const close = () => {
    div.remove(); modalOpen = false;
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  div.addEventListener('click', close);
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(div);
}

// =================================================================
// RENDER
// =================================================================
function render() {
  const sessions = Array.from(sessionsMap.values());
  const tabsTotal = Array.from(tabsMap.values()).reduce((a, l) => a + l.length, 0);

  document.getElementById('statTotal').textContent = sessions.length;
  document.getElementById('statLocked').textContent =
    sessions.filter(s => s.status === 'locked').length;
  document.getElementById('statCloses').textContent =
    events.filter(e => e.event_type === 'close_attempt').length;
  document.getElementById('statTabs').textContent = tabsTotal;

  const scrollY = window.scrollY;

  const host = document.getElementById('roster');
  host.innerHTML = sessions.length ? sessions.map(s => {
    const tabs = tabsMap.get(s.id) ?? [];
    const current = tabs.find(t => t.active);
    const others = tabs.filter(t => !t.active);
    const name = s.profiles?.full_name || s.profiles?.email || s.student_id;

    const lockBtn = s.status === 'locked'
      ? `<button class="btn-sm btn-green" data-act="unlock" data-id="${s.id}">Unlock</button>`
      : `<button class="btn-sm btn-yellow" data-act="lock" data-id="${s.id}">Lock</button>`;

    const live = isLive(s.last_screenshot_at);
    const screenHtml = s.last_screenshot_at
      ? `<div class="screen-wrap">
           <span class="badge" style="background:${live ? 'rgba(220,38,38,.9)' : 'rgba(0,0,0,.75)'}">
             ${live ? '🔴 LIVE' : `Screen · ${timeAgo(s.last_screenshot_at)}`}
           </span>
           <img class="screenshot" data-sid="${s.id}" alt="Screen of ${esc(name)}"
                style="background:#111;" />
         </div>`
      : `<div class="screen-empty">Waiting for screen share…</div>`;

    const currentHtml = current ? `
      <p style="font-size:11px;color:#666;margin:0 0 4px;">CURRENT TAB</p>
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
      <div class="card" data-session="${s.id}">
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
              data-sid="${s.id}" data-uid="${s.student_id}">Refresh now</button>
            <button class="btn-sm btn-red" data-act="close-all"
              data-sid="${s.id}" data-uid="${s.student_id}">Close all</button>
            <button class="btn-sm btn-gray" data-act="end"
              data-id="${s.id}">End session</button>
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
  }).join('') : '<p style="color:#888;">No active sessions.</p>';

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

  window.scrollTo(0, scrollY);
  refreshScreenshots();
}

load();
