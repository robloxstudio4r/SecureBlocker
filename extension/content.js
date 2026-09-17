// The web page posts { type: 'GET_TABS' } and the extension replies
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if (event.data.type === 'GET_TABS') {
    chrome.runtime.sendMessage({ type: 'GET_TABS' }, (tabs) => {
      window.postMessage({ type: 'TABS_RESULT', tabs }, '*')
    })
  }
  if (event.data.type === 'CLOSE_TAB') {
    chrome.runtime.sendMessage({ type: 'CLOSE_TAB', tabId: event.data.tabId })
  }
})
