import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import { requireAuth, getProfile } from './auth.js';

let user = null;
let profile = null;
let session = null;       // Supabase session row (public.sessions)
let accessToken = null;

// -----------------------------------------------------------------
// 1) INIT — auth, profile, create session row
// -----------------------------------------------------------------
const authSession = await requireAuth(['student']);
if (!authSession) throw new Error('not signed in');

user = authSession.user;
accessToken = authSession.session?.access_token
           || (await supabase.auth.getSession()).data.session?.access_token;

profile = await getProfile(user.id);
document.getElementById('whoami').textContent =
  `Signed in as ${profile?.full_name || user.email}`;

// End any dangling old sessions
await supabase.from('sessions')
  .update({ ended_at: new Date().toISOString(), status: 'closed' })
  .eq('student_id', user.id)
  .is('ended_at', null);

// Create a fresh session
const { data: sess, error: sessErr } = await supabase
  .from('sessions')
  .insert({ student_id: user.id, classroom_id: profile?.classroom_id, status: 'active' })
  .select()
  .single();

if (sessErr) {
  console.error(sessErr);
  alert('Could not create session: ' + sessErr.message);
  throw sessErr;
}
session = sess;

// -----------------------------------------------------------------
// 2) TOKEN REFRESH — keep accessToken current
// -----------------------------------------------------------------
supabase.auth.onAuthStateChange((_event, s) => {
  if (s?.access_token) {
    accessToken = s.access_token;
    window.postMessage({ type: 'UPDATE_TOKEN', accessToken }, '*');
  }
});

// -----------------------------------------------------------------
// 3) THE "ARE YOU SURE YOU WANT TO LEAVE" DIALOG
// -----------------------------------------------------------------
window.addEventListener('beforeunload', (e) => {
  // Log the attempt (fire-and-forget, survives teardown)
  beaconEvent('close_attempt');

  // Trigger the native confirmation dialog
  e.preventDefault();
  e.returnValue = '';
  return '';
});

// -----------------------------------------------------------------
// 4) END SESSION when tab actually closes
// -----------------------------------------------------------------
window.addEventListener('pagehide', () => {
  if (!session || !accessToken) return;
  fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    keepalive: true,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ ended_at: new Date().toISOString(), status: 'closed' })
  }).catch(() => {});
});

// -----------------------------------------------------------------
// 5) FULLSCREEN ENTRY + ESCAPE DETECTION
// -----------------------------------------------------------------
document.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}, { once: true });

document.addEventListener('fullscreenchange', () => {
  const overlay = document.getElementById('fsOverlay');
  if (!document.fullscreenElement && !document.getElementById('lockOverlay').hidden) return;
  overlay.hidden = !!document.fullscreenElement;
});

document.getElementById('fsReturn').addEventListener('click', () => {
  document.documentElement.requestFullscreen().catch(() => {});
  document.getElementById('fsOverlay').hidden = true;
});

// -----------------------------------------------------------------
// 6) HEARTBEAT every 15s
// -----------------------------------------------------------------
setInterval(() => {
  if (!session) return;
  supabase.from('sessions').update({
    last_seen_at: new Date().toISOString(),
    focus_state: document.visibilityState === 'visible' ? 'focused' : 'hidden'
  }).eq('id', session.id).then(() => {});
}, 15000);

// -----------------------------------------------------------------
// 7) LISTEN for teacher lock / unlock
// -----------------------------------------------------------------
const lockChannel = supabase
  .channel(`session-${session.id}`)
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'sessions',
      filter: `id=eq.${session.id}` },
    (payload) => {
      if (payload.new.status === 'locked') {
        document.getElementById('lockMsg').textContent =
          payload.new.lock_message || 'Return to the lesson.';
        document.getElementById('lockOverlay').hidden = false;
      } else if (payload.new.status === 'active') {
        document.getElementById('lockOverlay').hidden = true;
      }
    })
  .subscribe();

// -----------------------------------------------------------------
// 8) EXTENSION BRIDGE — announce config, poll tabs, push to Supabase
// -----------------------------------------------------------------
function announceConfig() {
  if (!accessToken) return;
  window.postMessage({
    type: 'SET_CONFIG',
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    sessionId: session.id,
    accessToken
  }, '*');
}
announceConfig();
setInterval(announceConfig, 60000);

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'TABS_RESULT') return;

  const tabs = event.data.tabs || [];
  await supabase.from('tab_snapshots').delete().eq('session_id', session.id);
  if (tabs.length) {
    await supabase.from('tab_snapshots').insert(tabs.map(t => ({
      session_id: session.id,
      student_id: user.id,
      tab_id: t.id,
      url: t.url,
      title: t.title,
      favicon_url: t.favicon,
      active: t.active
    })));
  }
  await supabase.from('sessions')
    .update({ extension_connected: true })
    .eq('id', session.id);
});

// Ask the extension for a fresh tab list every 8 seconds
function pollTabs() { window.postMessage({ type: 'GET_TABS' }, '*'); }
pollTabs();
setInterval(pollTabs, 8000);

// -----------------------------------------------------------------
// HELPER: beacon a focus event (survives page unload)
// -----------------------------------------------------------------
function beaconEvent(eventType, meta = {}) {
  if (!accessToken || !session) return;
  fetch(`${SUPABASE_URL}/rest/v1/focus_events`, {
    method: 'POST',
    keepalive: true,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({
      session_id: session.id,
      student_id: user.id,
      event_type: eventType,
      meta
    })
  }).catch(() => {});
}
