// Report all tabs to the web page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TABS') {
    chrome.tabs.query({}).then((tabs) => {
      sendResponse(tabs.map(t => ({
        id: t.id, url: t.url, title: t.title,
        favicon: t.favIconUrl, active: t.active
      })))
    })
    return true // async response
  }

  if (msg.type === 'CLOSE_TAB') {
    chrome.tabs.remove(msg.tabId, () => {
      console.log(`Tab ${msg.tabId} closed`)
    })
  }
})

// Poll for commands from Supabase every 5 seconds
// (Service workers can't hold a WebSocket, so polling is the reliable way)
async function pollCommands(supabaseUrl, anonKey, sessionId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/tab_commands?target_session_id=eq.${sessionId}&executed_at=is.null`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
  )
  const commands = await res.json()
  for (const cmd of commands) {
    if (cmd.command === 'close' && cmd.tab_id) {
      chrome.tabs.remove(cmd.tab_id)
    }
    // Mark as executed
    await fetch(`${supabaseUrl}/rest/v1/tab_commands?id=eq.${cmd.id}`, {
      method: 'PATCH',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ executed_at: new Date().toISOString() })
    })
  }
}

// Store config when the student logs in
chrome.storage.local.get(['supabaseUrl', 'anonKey', 'sessionId'], (cfg) => {
  if (cfg.supabaseUrl) {
    setInterval(() => pollCommands(cfg.supabaseUrl, cfg.anonKey, cfg.sessionId), 5000)
  }
})
