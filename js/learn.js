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
let shareWatchTimer = null;
let extensionReady = false;

// =================================================================
// 0) AUTH GUARD
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
// 1) START LESSON (screen share gate)
// =================================================================
document.getElementById('startBtn').addEventListener('click', async () => {
  const btn = document.getElementById('startBtn');
  const err = document.getElementById('gateErr');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Requesting screen access…';

  // --- Request screen share FIRST (must be inside the click handler)
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false
    });
    console.log('[learn] got display stream, tracks:', mediaStream.getVideoTracks().length);
  } catch (e) {
    console.warn('[learn] getDisplayMedia rejected:', e);
    err.textContent = 'Screen sharing was denied. You must share your screen to begin.';
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Start lesson & share screen';
    return;
  }

  // --- Create session row
  const { data: myMemberships } = await supabase
    .from('class_members')
    .select('class_id, added_at')
    .eq('student_id', user.id)
    .order('added_at', { ascending: true })
    .limit(1);
  const primaryClassId = myMemberships?.[0]?.class_id ?? null;

  // Close any prior open sessions for this user
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
    console.error('[learn] session insert failed:', error);
    err.textContent = error.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Start lesson & share screen';
    return;
  }

  session = sess;
  console.log('[learn] session created:', session.id);

  // --- Swap gate → lesson
  document.getElementById('gate').hidden = true;
  document.getElementById('lessonWrap').hidden = false;

  // --- Start engines
  startCapture();
  startHeartbeat();
  startTabPolling();
  watchLock();
  installGuards();
  wireStatusPill();
  wireTokenRefresh();
  wireMembershipWatcher();
  startShareWatcher();
});

// =================================================================
// 2) RESUME screen sharing after a stop
// =================================================================
document.getElementById('shareResume').addEventListener('click', async () => {
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false
    });
    document.getElementById('shareOverlay').hidden = true;
    startCapture();
    startShareWatcher();
  } catch (e) {
    console.warn('[learn] resume denied:', e);
  }
});

// =================================================================
// 3) SCREEN CAPTURE ENGINE
// =================================================================
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const video = document.createElement('video');
video.autoplay = true;
video.muted = true;
video.playsInline = true;
video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
document.body.appendChild(video);

function startCapture() {
  if (!mediaStream) return;
  video.srcObject = mediaStream;
  video.play().catch(() => {});

  if (captureTimer) clearInterval(captureTimer);
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

  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  const w = Math.floor(video.videoWidth * scale);
  const h = Math.floor(video.videoHeight * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.55));
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
      console.warn('[learn] screenshot upload failed', res.status, await res.text());
      return;
    }
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
    console.warn('[learn] capture error', e);
  }
}

// =================================================================
// 4) SHARE WATCHER — listen for the real 'ended' event, with a
// debounced poll as a safety net (some browsers/OS combos can
// transiently misreport readyState for a moment without the
// share having actually stopped, so we require 2 consecutive
// stale reads before trusting the poll).
// =================================================================
let shareWatchedTrack = null;
let staleReads = 0;

function onTrackEnded() {
  console.log('[learn] screen share track ended');
  showShareOverlay();
}

function showShareOverlay() {
  document.getElementById('shareOverlay').hidden = false;
  stopCapture();
  if (shareWatchTimer) { clearInterval(shareWatchTimer); shareWatchTimer = null; }
  if (shareWatchedTrack) {
    shareWatchedTrack.removeEventListener('ended', onTrackEnded);
    shareWatchedTrack = null;
  }
}

function startShareWatcher() {
  if (shareWatchTimer) clearInterval(shareWatchTimer);
  if (shareWatchedTrack) shareWatchedTrack.removeEventListener('ended', onTrackEnded);
  staleReads = 0;

  const track = mediaStream?.getVideoTracks()[0];
  if (!track) return;

  // Primary signal: the real, authoritative 'ended' event.
  shareWatchedTrack = track;
  track.addEventListener('ended', onTrackEnded);

  // Backup poll, debounced so a single flaky read doesn't false-trigger.
  shareWatchTimer = setInterval(() => {
    if (!mediaStream) return;
    const t = mediaStream.getVideoTracks()[0];
    if (!t || t.readyState === 'ended') {
      staleReads++;
      if (staleReads >= 2) showShareOverlay();
    } else {
      staleReads = 0;
    }
  }, 2000);
}

// =================================================================
// 5) TAB POLLING — extension bridge
// =================================================================
function startTabPolling() {
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
    const del = await supabase.from('tab_snapshots').delete().eq('session_id', session.id);
    if (del.error) console.error('[learn] tab_snapshots delete failed:', del.error);

    if (tabs.length) {
      const ins = await supabase.from('tab_snapshots').insert(tabs.map(t => ({
        session_id: session.id,
        student_id: user.id,
        tab_id: t.id,
        url: t.url || '',
        title: t.title || '',
        favicon_url: t.favicon || '',
        active: !!t.active
      })));
      if (ins.error) console.error('[learn] tab_snapshots insert failed:', ins.error);
    }
    const upd = await supabase.from('sessions')
      .update({ extension_connected: true })
      .eq('id', session.id);
    if (upd.error) console.error('[learn] extension_connected update failed:', upd.error);
  } catch (e) {
    console.warn('[learn] tab sync failed', e);
  }
}

// =================================================================
// 6) HEARTBEAT
// =================================================================
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    if (!session) return;
    const { error } = await supabase.from('sessions').update({
      last_seen_at: new Date().toISOString(),
      focus_state: document.visibilityState === 'visible' ? 'focused' : 'hidden'
    }).eq('id', session.id);
    // If this silently fails (e.g. a missing RLS UPDATE policy),
    // last_seen_at freezes forever and the roster shows the
    // student as stale no matter how long they keep sharing.
    if (error) console.error('[learn] heartbeat update failed:', error);
  }, 15000);
}

// =================================================================
// 7) LOCK LISTENER
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
// 8) GUARDS — beforeunload, fullscreen (NO pagehide end)
// =================================================================
function installGuards() {
  window.addEventListener('beforeunload', (e) => {
    beaconEvent('close_attempt');
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // Log but do NOT end the session on pagehide — session goes stale naturally
  window.addEventListener('pagehide', (e) => {
    console.log('[learn] pagehide fired, persisted =', e.persisted);
  });

  document.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, { once: true });

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
// 9) STATUS PILL
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

  setInterval(() => {
    if (pill.classList.contains('off')) return;
    text.textContent = extensionReady ? 'Monitored' : 'Monitored (no extension)';
  }, 5000);
}

// =================================================================
// 10) TOKEN REFRESH
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
// 11) MEMBERSHIP WATCHER
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
// 12) BEACON
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
