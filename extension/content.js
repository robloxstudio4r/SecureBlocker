// Tell the page we're alive every time we load
window.postMessage({ type: 'EXTENSION_READY' }, '*');

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const { type } = event.data || {};

  if (type === 'SET_CONFIG') {
    chrome.storage.local.set({
      supabaseUrl: event.data.supabaseUrl,
      anonKey: event.data.anonKey,
      sessionId: event.data.sessionId,
      accessToken: event.data.accessToken
    }, () => {
      window.postMessage({ type: 'EXTENSION_READY' }, '*');
      chrome.runtime.sendMessage({ type: 'START_POLLING' }, () => {
        // Ack back so page knows the pipe is open
        window.postMessage({ type: 'EXTENSION_READY' }, '*');
      });
    });
  }

  if (type === 'UPDATE_TOKEN') {
    chrome.storage.local.set({ accessToken: event.data.accessToken });
  }

  if (type === 'GET_TABS') {
    chrome.runtime.sendMessage({ type: 'GET_TABS' }, (tabs) => {
      // If the worker had to wake up, it can take a tick
      window.postMessage({ type: 'TABS_RESULT', tabs: tabs || [] }, '*');
    });
  }
});
