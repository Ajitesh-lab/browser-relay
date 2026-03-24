// Use a version key so re-injection after extension reload always reconnects
const _RELAY_VERSION = 'v12';
if (window.__relayVersion !== _RELAY_VERSION) {
  // Close old WebSocket if lingering from previous version
  if (window.__relayWs) try { window.__relayWs.close(); } catch(_) {}
  window.__relayVersion = _RELAY_VERSION;

  // Keep background service worker alive
  let keepalivePort = null;
  function maintainPort() {
    try {
      keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
      keepalivePort.onDisconnect.addListener(() => {
        try { chrome.runtime.id; } catch(e) { return; }
        setTimeout(maintainPort, 1000);
      });
    } catch(e) {}
  }
  maintainPort();

  // Commands handled directly in content script (no background needed)
  async function handleLocal(msg) {
    const { id, type, params = {} } = msg;
    // If a specific tabId is requested, ALWAYS forward to background
    // (background.js has chrome.tabs/scripting APIs to target any tab)
    if (params.tabId) return null;

    let result = null, error = null;
    try {
      if (type === 'version') {
        result = 'v10';
      } else if (type === 'content') {
        result = {
          url: location.href,
          title: document.title,
          text: document.body.innerText.slice(0, 15000),
          html: document.documentElement.outerHTML.slice(0, 50000)
        };
      } else if (type === 'find') {
        result = Array.from(document.querySelectorAll(params.selector)).slice(0, 20).map((el, i) => ({
          index: i, tag: el.tagName,
          text: el.innerText?.slice(0, 200),
          href: el.href || null, value: el.value || null,
          id: el.id || null, class: el.className?.slice(0, 100) || null
        }));
      } else if (type === 'click') {
        const el = document.querySelector(params.selector);
        if (!el) throw new Error('Not found: ' + params.selector);
        el.scrollIntoView({ block: 'center' });
        el.click();
        result = { ok: true, tag: el.tagName, text: el.innerText?.slice(0, 100) };
      } else if (type === 'click_coords') {
        const el = document.elementFromPoint(params.x, params.y);
        if (!el) throw new Error('No element at coords');
        el.click();
        result = { ok: true, tag: el.tagName };
      } else if (type === 'hover') {
        const el = document.querySelector(params.selector);
        if (!el) throw new Error('Not found: ' + params.selector);
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        result = { ok: true };
      } else if (type === 'type') {
        const el = document.querySelector(params.selector);
        if (!el) throw new Error('Not found: ' + params.selector);
        el.focus();
        if (el.isContentEditable) {
          el.textContent = '';
          document.execCommand('insertText', false, params.text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          result = { ok: true, value: el.textContent };
        } else {
          el.value = '';
          for (const char of params.text) {
            el.value += char;
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          result = { ok: true, value: el.value };
        }
      } else if (type === 'key') {
        const el = params.selector ? document.querySelector(params.selector) : document.activeElement;
        if (!el) throw new Error('No element');
        ['keydown','keypress','keyup'].forEach(t =>
          el.dispatchEvent(new KeyboardEvent(t, { key: params.key, bubbles: true, cancelable: true }))
        );
        if (params.key === 'Enter') { const f = el.closest('form'); if (f) f.submit(); }
        result = { ok: true };
      } else if (type === 'scroll') {
        if (params.selector) {
          const el = document.querySelector(params.selector);
          if (!el) throw new Error('Not found');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.scrollBy({ left: params.x || 0, top: params.y || 500, behavior: 'smooth' });
        }
        result = { ok: true, scrollY: window.scrollY };
      } else if (type === 'wait') {
        result = await new Promise(resolve => {
          const start = Date.now();
          const check = () => {
            const el = document.querySelector(params.selector);
            if (el) return resolve({ ok: true, found: true });
            if (Date.now() - start > (params.timeout || 10000))
              return resolve({ ok: false, error: 'Timeout: ' + params.selector });
            setTimeout(check, 200);
          };
          check();
        });
      } else if (type === 'eval') {
        try { result = { ok: true, value: String(eval(params.code)) }; }
        catch(e) { result = { ok: false, error: e.message }; }
      } else if (type === 'select') {
        const el = document.querySelector(params.selector);
        if (!el) throw new Error('Not found: ' + params.selector);
        el.value = params.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        result = { ok: true, value: el.value };
      } else if (type === 'content' && params.tabId) {
        // tabId-targeted content read → must go to background
        return null;
      } else if (type === 'navigate' && !params.tabId) {
        // No tabId → navigate current tab locally
        location.href = params.url;
        result = { ok: true, url: params.url };
      } else if (type === 'tabs_list') {
        // Always forward to background — it has chrome.tabs API with full tab IDs
        return null;
      } else {
        return null; // Forward to background only if truly needed
      }
    } catch(e) { error = e.message; }
    return { id, result, error };
  }

  // WebSocket connection
  let ws = null;
  function connect() {
    ws = new WebSocket('ws://127.0.0.1:9999/ws');
    window.__relayWs = ws; // expose for cleanup on reload

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', version: 'v10', url: location.href, title: document.title }));
      try { chrome.runtime.sendMessage({ type: 'ws_status', connected: true }).catch(() => {}); } catch(e) {}
    };

    ws.onclose = () => {
      try { chrome.runtime.sendMessage({ type: 'ws_status', connected: false }).catch(() => {}); } catch(e) {}
      try { chrome.runtime.id; } catch(e) { return; }
      setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ping') return;

      try { chrome.runtime.id; } catch(e) { ws.close(); return; }

      // Try to handle locally first
      const local = await handleLocal(msg);
      if (local !== null) {
        ws.send(JSON.stringify(local));
        return;
      }

      // Forward privileged commands to background via keepalive port (already open, reliable)
      if (!keepalivePort) {
        try { ws.send(JSON.stringify({ id: msg.id, result: null, error: 'No background port' })); } catch(_) {}
        return;
      }
      const handler = (response) => {
        if (response.id !== msg.id) return;
        keepalivePort.onMessage.removeListener(handler);
        try { ws.send(JSON.stringify(response)); } catch(_) {}
      };
      keepalivePort.onMessage.addListener(handler);
      keepalivePort.postMessage(msg);
    };
  }

  connect();
}
