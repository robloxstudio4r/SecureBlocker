let pollTimer = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TABS') {
    chrome.tabs.query({}).then((tabs) => {
      sendResponse(tabs.map(t => ({
        id: t.id,
        url: t.url || '',
        title: t.title || '',
        favicon: t.favIconUrl || '',
        active: !!t.active
      })));
    }).catch(() => sendResponse([]));
    return true;
  }
  if (msg.type === 'START_POLLING') {
    startPolling();
    sendResponse({ ok: true });
    return true;
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Chrome will throttle timers in sleeping workers, but alarms wake them
  pollTimer = setInterval(pollCommands, 4000);
  pollCommands();
}

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
      try {
        if (cmd.command === 'close' && cmd.tab_id != null) {
          await chrome.tabs.remove(cmd.tab_id);
        } else if (cmd.command === 'focus' && cmd.tab_id != null) {
          await chrome.tabs.update(cmd.tab_id, { active: true });
        } else if (cmd.command === 'block_domain' && cmd.domain) {
          const tabs = await chrome.tabs.query({});
          const ids = tabs.filter(t => t.url && t.url.includes(cmd.domain)).map(t => t.id);
          if (ids.length) await chrome.tabs.remove(ids);
        }
      } catch {}

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

// Aggressive wake-ups: minimum alarm period is 1 minute in MV3
chrome.alarms.create('wake', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'wake') pollCommands();
});

// Restart on worker boot
chrome.storage.local.get(['sessionId'], (cfg) => {
  if (cfg.sessionId) startPolling();
});
