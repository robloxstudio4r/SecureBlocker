import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import { requireAuth, getProfile } from './auth.js';

let user = null;
let profile = null;
let session = null;
let accessToken = null;

// -----------------------------------------------------------------
// 1) AUTH GUARD
// -----------------------------------------------------------------
const authSession = await requireAuth(['student']);
if (!authSession) throw new Error('not signed in');

user = authSession.user;

// Grab the access token (fresh, in case this page loaded late)
{
  const { data: { session: s } } = await supabase.auth.getSession();
  accessToken = s?.access_token ?? null;
}

// -----------------------------------------------------------------
// 2) PROFILE
// -----------------------------------------------------------------
profile = await getProfile(user.id);
document.getElementById('whoami').textContent =
  `Signed in as ${profile?.full_name || user.email}`;

// -----------------------------------------------------------------
// 3) FIND MY PRIMARY CLASS (first class I'm a member of)
// -----------------------------------------------------------------
const { data: myMemberships } = await supabase
  .from('class_members')
  .select('class_id, added_at')
  .eq('student_id', user.id)
  .order('added_at', { ascending: true })
  .limit(1);

const primaryClassId = myMemberships?.[0]?.class_id ?? null;

// If we don't have a class yet, still continue — teacher may add us later
// (Realtime will pick it up on reload; sessions can exist without a class)

// -----------------------------------------------------------------
// 4) END DANGLING SESSIONS from previous visits
// -----------------------------------------------------------------
await supabase.from('sessions')
  .update({ ended_at: new Date().toISOString(), status: 'closed' })
  .eq('student_id', user.id)
  .is('ended_at', null);

// -----------------------------------------------------------------
// 5) CREATE A FRESH SESSION
// -----------------------------------------------------------------
const { data: sess, error: sessErr } = await supabase
  .from('sessions')
  .insert({
    student_id: user.id,
    classroom_id: primaryClassId,
    status: 'active'
  })
  .select()
  .single();

if (sessErr) {
  console.error(sessErr);
  alert('Could not create session: ' + sessErr.message);
  throw sessErr;
}
session = sess;

// -----------------------------------------------------------------
// 6) TOKEN REFRESH — keep accessToken fresh
// -----------------------------------------------------------------
supabase.auth.onAuthStateChange((_event, s) => {
  if (s?.access_token) {
    accessToken = s.access_token;
    window.postMessage({ type: 'UPDATE_TOKEN', accessToken }, '*');
  }
});

// -----------------------------------------------------------------
// 7) THE "ARE YOU SURE YOU WANT TO LEAVE" DIALOG
// -----------------------------------------------------------------
window.addEventListener('beforeunload', (e) => {
  beaconEvent('close_attempt');
  e.preventDefault();
  e.returnValue = '';   // triggers native confirmation dialog
  return '';
});

// -----------------------------------------------------------------
// 8) END SESSION when tab actually closes
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
    body: JSON.stringify({
      ended_at: new Date().toISOString(),
      status: 'closed'
    })
  }).catch(() => {});
});

// -----------------------------------------------------------------
// 9) FULLSCREEN ENTRY + ESCAPE DETECTION
// -----------------------------------------------------------------
document.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}, { once: true });

document.addEventListener('fullscreenchange', () => {
  const overlay = document.getElementById('fsOverlay');
  const lockOverlay = document.getElementById('lockOverlay');
  // Don't show the FS overlay if the teacher-lock overlay is up
  if (!lockOverlay.hidden) return;
  overlay.hidden = !!document.fullscreenElement;
});

document.getElementById('fsReturn').addEventListener('click', () => {
  document.documentElement.requestFullscreen().catch(() => {});
  document.getElementById('fsOverlay').hidden = true;
});

// -----------------------------------------------------------------
// 10) HEARTBEAT every 15s
// -----------------------------------------------------------------
setInterval(() => {
  if (!session) return;
  supabase.from('sessions').update({
    last_seen_at: new Date().toISOString(),
    focus_state: document.visibilityState === 'visible' ? 'focused' : 'hidden'
  }).eq('id', session.id).then(() => {});
}, 15000);

// -----------------------------------------------------------------
// 11) LISTEN for teacher lock / unlock
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
// 12) EXTENSION BRIDGE — announce config, poll tabs, push to Supabase
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
// 13) OPTIONAL: If a class is assigned later (teacher adds us),
//     keep our session's classroom_id in sync
// -----------------------------------------------------------------
supabase
  .channel(`my-memberships-${user.id}`)
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'class_members',
      filter: `student_id=eq.${user.id}` },
    async (payload) => {
      // Assign this class to our current session if we didn't have one
      if (!session.classroom_id) {
        await supabase.from('sessions')
          .update({ classroom_id: payload.new.class_id })
          .eq('id', session.id);
        session.classroom_id = payload.new.class_id;
      }
    })
  .subscribe();

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
