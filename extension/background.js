let pollTimer = null

// Handle messages from the content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TABS') {
    chrome.tabs.query({}).then((tabs) => {
      sendResponse(tabs.map(t => ({
        id: t.id, url: t.url || '', title: t.title || '',
        favicon: t.favIconUrl || '', active: !!t.active
      })))
    })
    return true
  }

  if (msg.type === 'START_POLLING') {
    startPolling()
    sendResponse({ ok: true })
    return true
  }
})

async function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(pollCommands, 4000)
  pollCommands()
}

async function pollCommands() {
  const cfg = await chrome.storage.local.get(
    ['supabaseUrl', 'anonKey', 'sessionId', 'accessToken']
  )
  if (!cfg.supabaseUrl || !cfg.sessionId || !cfg.accessToken) return

  try {
    const res = await fetch(
      `${cfg.supabaseUrl}/rest/v1/tab_commands` +
      `?target_session_id=eq.${cfg.sessionId}&executed_at=is.null&select=*`,
      {
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.accessToken}`
        }
      }
    )
    if (!res.ok) return
    const commands = await res.json()

    for (const cmd of commands) {
      if (cmd.command === 'close' && cmd.tab_id != null) {
        try { await chrome.tabs.remove(cmd.tab_id) } catch {}
      }
      if (cmd.command === 'block_domain' && cmd.domain) {
        const tabs = await chrome.tabs.query({})
        const toClose = tabs
          .filter(t => t.url && t.url.includes(cmd.domain))
          .map(t => t.id)
        if (toClose.length) await chrome.tabs.remove(toClose)
      }
      if (cmd.command === 'focus') {
        const tabs = await chrome.tabs.query({})
        const match = tabs.find(t => t.id === cmd.tab_id)
        if (match) await chrome.tabs.update(match.id, { active: true })
      }

      // Mark executed
      await fetch(`${cfg.supabaseUrl}/rest/v1/tab_commands?id=eq.${cmd.id}`, {
        method: 'PATCH',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ executed_at: new Date().toISOString() })
      }).catch(() => {})
    }
  } catch {}
}

// Keep the worker alive across MV3 sleep
chrome.alarms.create('keepalive', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepalive') pollCommands()
})

// Restart polling when the worker boots
chrome.storage.local.get(['sessionId'], (cfg) => {
  if (cfg.sessionId) startPolling()
})
