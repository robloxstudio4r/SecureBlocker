let pollTimer = null;
let screenshotTimer = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TABS') {
    chrome.tabs.query({}).then((tabs) => {
      sendResponse(tabs.map(t => ({
        id: t.id, url: t.url || '', title: t.title || '',
        favicon: t.favIconUrl || '', active: !!t.active
      })));
    });
    return true;
  }
  if (msg.type === 'START_POLLING') {
    startPolling();
    startScreenshots();
    sendResponse({ ok: true });
    return true;
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollCommands, 4000);
  pollCommands();
}

function startScreenshots() {
  if (screenshotTimer) clearInterval(screenshotTimer);
  // Every 30 seconds
  screenshotTimer = setInterval(captureScreenshot, 30000);
  // First capture after 5s
  setTimeout(captureScreenshot, 5000);
}

// -------------------------------------------------
// COMMAND POLLING
// -------------------------------------------------
async function pollCommands() {
  const cfg = await chrome.storage.local.get(
    ['supabaseUrl', 'anonKey', 'sessionId', 'accessToken']
  );
  if (!cfg.supabaseUrl || !cfg.sessionId || !cfg.accessToken) return;

  try {
    const res = await fetch(
      `${cfg.supabaseUrl}/rest/v1/tab_commands` +
      `?target_session_id=eq.${cfg.sessionId}&executed_at=is.null&select=*`,
      { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}` } }
    );
    if (!res.ok) return;
    const commands = await res.json();

    for (const cmd of commands) {
      if (cmd.command === 'close' && cmd.tab_id != null) {
        try { await chrome.tabs.remove(cmd.tab_id); } catch {}
      }
      if (cmd.command === 'block_domain' && cmd.domain) {
        const tabs = await chrome.tabs.query({});
        const toClose = tabs.filter(t => t.url && t.url.includes(cmd.domain)).map(t => t.id);
        if (toClose.length) await chrome.tabs.remove(toClose);
      }
      if (cmd.command === 'focus' && cmd.tab_id != null) {
        try { await chrome.tabs.update(cmd.tab_id, { active: true }); } catch {}
      }
      if (cmd.command === 'screenshot') {
        await captureScreenshot();
      }

      await fetch(`${cfg.supabaseUrl}/rest/v1/tab_commands?id=eq.${cmd.id}`, {
        method: 'PATCH',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ executed_at: new Date().toISOString() })
      }).catch(() => {});
    }
  } catch {}
}

// -------------------------------------------------
// SCREENSHOT CAPTURE
// -------------------------------------------------
async function captureScreenshot() {
  const cfg = await chrome.storage.local.get(
    ['supabaseUrl', 'anonKey', 'sessionId', 'accessToken']
  );
  if (!cfg.supabaseUrl || !cfg.sessionId || !cfg.accessToken) return;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
      format: 'jpeg',
      quality: 55
    });
  } catch (e) {
    // No visible tab / focus issue — try again next tick
    return;
  }

  try {
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${cfg.sessionId}.jpg`;

    await fetch(
      `${cfg.supabaseUrl}/storage/v1/object/screenshots/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true'
        },
        body: blob
      }
    );

    // Stamp freshness on the session row (triggers realtime for teacher)
    await fetch(
      `${cfg.supabaseUrl}/rest/v1/sessions?id=eq.${cfg.sessionId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ last_screenshot_at: new Date().toISOString() })
      }
    );
  } catch (e) {
    console.error('Screenshot upload failed', e);
  }
}

// Keep the service worker alive
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepalive') { pollCommands(); captureScreenshot(); }
});

// Resume on worker boot
chrome.storage.local.get(['sessionId'], (cfg) => {
  if (cfg.sessionId) { startPolling(); startScreenshots(); }
});
