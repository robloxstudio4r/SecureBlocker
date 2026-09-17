import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
import { requireAuth, getProfile } from './auth.js';

let user = null;
let profile = null;
let session = null;
let accessToken = null;
let mediaStream = null;
let captureTimer = null;
let tabTimer = null;
let heartbeatTimer = null;
let extensionReady = false;

// =================================================================
// 0) AUTH GUARD — allow students, teachers, and admins
// =================================================================
const authSession = await requireAuth(['student', 'teacher', 'admin']);
if (!authSession) throw new Error('not signed in');
user = authSession.user;

{
  const { data: { session: s } } = await supabase.auth.getSession();
  accessToken = s?.access_token ?? null;
}

profile = await getProfile(user.id);
document.getElementById('whoami').textContent =
  `Signed in as ${profile?.full_name || user.email}`;

// =================================================================
// 1) GATE — wait for the user to click "Start lesson"
// =================================================================
document.getElementById('startBtn').addEventListener('click', async () => {
  const btn = document.getElementById('startBtn');
  const err = document.getElementById('gateErr');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Requesting screen access…';

  // -------------------------------------------------------------
  // Request screen share FIRST (must be in the click handler)
  // -------------------------------------------------------------
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false
    });
  } catch (e) {
    err.textContent = 'Screen sharing was denied. You must share your screen to begin.';
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Start lesson & share screen';
    return;
  }

  // Student stopped sharing via the browser bar
  mediaStream.getVideoTracks()[0].addEventListener('ended', () => {
    document.getElementById('shareOverlay').hidden = false;
    stopCapture();
  });

  // -------------------------------------------------------------
  // Create session row
  // -------------------------------------------------------------
  const { data: myMemberships } = await supabase
    .from('class_members')
    .select('class_id, added_at')
    .eq('student_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1);
  const primaryClassId = myMemberships?.[0]?.class_id ?? null;

  // Close any dangling old sessions
  await supabase.from('sessions')
    .update({ ended_at: new Date().toISOString(), status: 'closed' })
    .eq('student_id', user.id)
    .is('ended_at', null);

  const { data: sess, error } = await supabase
    .from('sessions')
    .insert({
      student_id: user.id,
      classroom_id: primaryClassId,
      status: 'active'
    })
    .select()
    .single();

  if (error) {
    err.textContent = error.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Start lesson & share screen';
    return;
  }

  session = sess;

  // -------------------------------------------------------------
  // Swap gate -> lesson view
  // -------------------------------------------------------------
  document.getElementById('gate').hidden = true;
  document.getElementById('lessonWrap').hidden = false;

  // -------------------------------------------------------------
  // Start all engines
  // -------------------------------------------------------------
  startCapture();
  startHeartbeat();
  startTabPolling();
  watchLock();
  installGuards();
  wireStatusPill();
  wireTokenRefresh();
  wireMembershipWatcher();
});

// =================================================================
// 2) RESUME SCREEN SHARING
// =================================================================
document.getElementById('shareResume').addEventListener('click', async () => {
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false
    });
    mediaStream.getVideoTracks()[0].addEventListener('ended', () => {
      document.getElementById('shareOverlay').hidden = false;
      stopCapture();
    });
    document.getElementById('shareOverlay').hidden = true;
    startCapture();
  } catch {}
});

// =================================================================
// 3) SCREEN CAPTURE ENGINE
//    getDisplayMedia stream -> canvas -> JPEG -> Supabase Storage
// =================================================================
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const video = document.createElement('video');
video.autoplay = true;
video.muted = true;
video.playsInline = true;
video.style.display = 'none';
document.body.appendChild(video);

function startCapture() {
  if (!mediaStream) return;
  video.srcObject = mediaStream;
  video.play().catch(() => {});

  if (captureTimer) clearInterval(captureTimer);
  // First frame after 1s, then every 3 seconds
  setTimeout(captureFrame, 1000);
  captureTimer = setInterval(captureFrame, 3000);
}

function stopCapture() {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
}

async function captureFrame() {
  if (!session || !accessToken || !mediaStream) return;
  if (video.videoWidth === 0) return;

  // Downscale to max 1280px wide to save bandwidth
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  const w = Math.floor(video.videoWidth * scale);
  const h = Math.floor(video.videoHeight * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);

  const blob = await new Promise(res =>
    canvas.toBlob(res, 'image/jpeg', 0.55)
  );
  if (!blob) return;

  const path = `${session.id}.jpg`;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/screenshots/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true'
        },
        body: blob
      }
    );

    if (!res.ok) {
      console.warn('Screenshot upload failed', res.status, await res.text());
      return;
    }

    // Stamp freshness on the session row
    await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ last_screenshot_at: new Date().toISOString() })
    });
  } catch (e) {
    console.warn('Capture error', e);
  }
}

// =================================================================
// 4) TAB POLLING — extension bridge
// =================================================================
function startTabPolling() {
  // Announce config repeatedly until extension ACKs
  let announceAttempts = 0;
  const announceLoop = setInterval(() => {
    if (!accessToken) return;
    window.postMessage({
      type: 'SET_CONFIG',
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      sessionId: session.id,
      accessToken
    }, '*');
    announceAttempts++;
    if (extensionReady || announceAttempts > 30) clearInterval(announceLoop);
  }, 1000);

  // Ask for tabs every 6 seconds
  if (tabTimer) clearInterval(tabTimer);
  tabTimer = setInterval(() => {
    window.postMessage({ type: 'GET_TABS' }, '*');
  }, 6000);
  setTimeout(() => window.postMessage({ type: 'GET_TABS' }, '*'), 500);

  window.addEventListener('message', onExtensionMessage);
}

async function onExtensionMessage(event) {
  if (event.source !== window) return;
  const msg = event.data || {};

  if (msg.type === 'EXTENSION_READY') {
    extensionReady = true;
    return;
  }

  if (msg.type !== 'TABS_RESULT') return;
  if (!session) return;

  const tabs = msg.tabs || [];

  try {
    await supabase.from('tab_snapshots').delete().eq('session_id', session.id);
    if (tabs.length) {
      await supabase.from('tab_snapshots').insert(tabs.map(t => ({
        session_id: session.id,
        student_id: user.id,
        tab_id: t.id,
        url: t.url || '',
        title: t.title || '',
        favicon_url: t.favicon || '',
        active: !!t.active
      })));
    }
    await supabase.from('sessions')
      .update({ extension_connected: true })
      .eq('id', session.id);
  } catch (e) {
    console.warn('tab sync failed', e);
  }
}

// =================================================================
// 5) HEARTBEAT
// =================================================================
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!session) return;
    supabase.from('sessions').update({
      last_seen_at: new Date().toISOString(),
      focus_state: document.visibilityState === 'visible' ? 'focused' : 'hidden'
    }).eq('id', session.id).then(() => {});
  }, 15000);
}

// =================================================================
// 6) LOCK LISTENER
// =================================================================
function watchLock() {
  supabase.channel(`session-${session.id}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'sessions',
        filter: `id=eq.${session.id}` },
      (p) => {
        if (p.new.status === 'locked') {
          document.getElementById('lockMsg').textContent =
            p.new.lock_message || 'Return to the lesson.';
          document.getElementById('lockOverlay').hidden = false;
        } else if (p.new.status === 'active') {
          document.getElementById('lockOverlay').hidden = true;
        }
      })
    .subscribe();
}

// =================================================================
// 7) GUARDS — beforeunload, fullscreen, pagehide
// =================================================================
function installGuards() {
  // "Are you sure you want to leave?" dialog
  window.addEventListener('beforeunload', (e) => {
    beaconEvent('close_attempt');
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // Clean up when the page actually unloads
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

  // Enter fullscreen on next click (user gesture required)
  document.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, { once: true });

  // Detect escape from fullscreen
  document.addEventListener('fullscreenchange', () => {
    const lockOverlay = document.getElementById('lockOverlay');
    const fsOverlay = document.getElementById('fsOverlay');
    if (!lockOverlay.hidden) return;
    fsOverlay.hidden = !!document.fullscreenElement;
  });

  document.getElementById('fsReturn').addEventListener('click', () => {
    document.documentElement.requestFullscreen().catch(() => {});
    document.getElementById('fsOverlay').hidden = true;
  });
}

// =================================================================
// 8) STATUS PILL
// =================================================================
function wireStatusPill() {
  const pill = document.getElementById('statusPill');
  const text = document.getElementById('statusText');

  supabase.channel(`status-${session.id}`)
    .subscribe((status) => {
      const ok = status === 'SUBSCRIBED';
      pill.classList.toggle('off', !ok);
      text.textContent = ok
        ? (extensionReady ? 'Monitored' : 'Monitored (no extension)')
        : 'Reconnecting…';
    });

  // Update label periodically as extension connects/disconnects
  setInterval(() => {
    if (pill.classList.contains('off')) return;
    text.textContent = extensionReady ? 'Monitored' : 'Monitored (no extension)';
  }, 5000);
}

// =================================================================
// 9) TOKEN REFRESH
// =================================================================
function wireTokenRefresh() {
  supabase.auth.onAuthStateChange((_e, s) => {
    if (s?.access_token) {
      accessToken = s.access_token;
      window.postMessage({ type: 'UPDATE_TOKEN', accessToken }, '*');
    }
  });
}

// =================================================================
// 10) MEMBERSHIP WATCHER — assign class if teacher adds us mid-session
// =================================================================
function wireMembershipWatcher() {
  supabase.channel(`mem-${user.id}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'class_members',
        filter: `student_id=eq.${user.id}` },
      async (p) => {
        if (!session.classroom_id) {
          await supabase.from('sessions')
            .update({ classroom_id: p.new.class_id })
            .eq('id', session.id);
          session.classroom_id = p.new.class_id;
        }
      })
    .subscribe();
}

// =================================================================
// 11) BEACON — fire-and-forget event logger (survives unload)
// =================================================================
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
