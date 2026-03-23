// Content script: keeps service worker alive by maintaining an open port
function keepAlive() {
  const port = chrome.runtime.connect({ name: 'keepalive' });
  port.onDisconnect.addListener(() => {
    // Reconnect when port drops
    setTimeout(keepAlive, 1000);
  });
}
keepAlive();
