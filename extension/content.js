window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const { type } = event.data || {};
  if (type === 'SET_CONFIG') {
    chrome.storage.local.set({
      supabaseUrl: event.data.supabaseUrl,
      anonKey: event.data.anonKey,
      sessionId: event.data.sessionId,
      accessToken: event.data.accessToken
    });
    chrome.runtime.sendMessage({ type: 'START_POLLING' });
  }
  if (type === 'UPDATE_TOKEN') {
    chrome.storage.local.set({ accessToken: event.data.accessToken });
  }
  if (type === 'GET_TABS') {
    chrome.runtime.sendMessage({ type: 'GET_TABS' }, (tabs) => {
      window.postMessage({ type: 'TABS_RESULT', tabs: tabs || [] }, '*');
    });
  }
});
