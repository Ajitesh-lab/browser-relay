let ws = null;

function connect() {
  ws = new WebSocket('ws://127.0.0.1:9999/ws');

  ws.onopen = () => {
    console.log('[offscreen] Connected');
    chrome.runtime.sendMessage({ type: 'ws_status', connected: true });
    ws.send(JSON.stringify({ type: 'hello', version: 'v3-offscreen' }));
  };

  ws.onclose = () => {
    console.log('[offscreen] Disconnected, reconnecting...');
    chrome.runtime.sendMessage({ type: 'ws_status', connected: false });
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = async (event) => {
    const { id, type, params } = JSON.parse(event.data);
    if (type === 'ping') return;
    console.log('[offscreen] command:', type, id);

    let result = null;
    let error = null;

    // Try to handle directly first (some chrome APIs work in offscreen)
    // For ones that don't, forward to background via port
    try {
      if (type === 'version') {
        result = 'v3-offscreen';
      } else if (type === 'new_tab') {
        // Try direct - if fails, falls to catch
        const tab = await chrome.tabs.create({ url: params.url, active: true });
        result = { ok: true, tabId: tab?.id, url: params.url };
      } else {
        // Forward everything else to background via port
        result = await sendToBackground({ id, type, params });
      }
    } catch (e) {
      console.log('[offscreen] direct failed, trying background:', e.message);
      // Fall back to background
      try {
        result = (await sendToBackground({ id, type, params })).result;
      } catch (e2) {
        error = e2.message;
      }
    }

    console.log('[offscreen] sending back result:', result, 'error:', error);
    ws.send(JSON.stringify({ id, result, error }));
  };
}

function sendToBackground(payload) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'cmd' });
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error('Background timeout'));
    }, 10000);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      port.disconnect();
      resolve(msg);
    });
    port.postMessage({ type: 'execute', payload });
  });
}

connect();
