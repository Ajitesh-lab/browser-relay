let ws = null;

// Keep service worker alive via content script ports
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onDisconnect.addListener(() => {});
  }
});

// Self-keepalive: ping every 20s to prevent MV3 service worker from dying
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connect(); // reconnect if dropped
  }
}, 20000);

// Helper: resolve the target tab — use explicit tabId if provided, otherwise active tab
async function getTab(params) {
  if (params?.tabId) {
    try { return await chrome.tabs.get(params.tabId); }
    catch { /* tab was closed — fall through to active tab */ }
  }
  const win = await chrome.windows.getLastFocused({ populate: true });
  const tab = win.tabs.find(t => t.active);
  if (!tab) throw new Error('No active tab');
  return tab;
}

function connect() {
  ws = new WebSocket('ws://127.0.0.1:9999/ws');

  ws.onopen = () => {
    console.log('Connected v10');
    ws.send(JSON.stringify({ type: 'hello', version: 'v10' }));
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  };

  ws.onclose = () => {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = async (event) => {
    const { id, type, params } = JSON.parse(event.data);
    if (type === 'ping') return;

    let result = null;
    let error = null;

    try {
      if (type === 'version') {
        result = 'v10';

      } else if (type === 'new_tab') {
        const tab = await chrome.tabs.create({
          url: params.url || 'about:blank',
          active: params.active !== false,  // default true; pass active:false for background
          pinned: !!params.pinned
        });
        result = { ok: true, tabId: tab.id, url: params.url };

      } else if (type === 'pin_tab') {
        await chrome.tabs.update(params.tabId, { pinned: true });
        result = { ok: true };

      } else if (type === 'tabs_list') {
        const win = await chrome.windows.getLastFocused({ populate: true });
        result = win.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, pinned: t.pinned }));

      } else if (type === 'tabs_switch') {
        await chrome.tabs.update(params.tabId, { active: true });
        result = { ok: true };

      } else if (type === 'tabs_close') {
        await chrome.tabs.remove(params.tabId);
        result = { ok: true };

      } else if (type === 'navigate') {
        const tab = await getTab(params);
        await chrome.tabs.update(tab.id, { url: params.url });
        result = { ok: true, tabId: tab.id, url: params.url };

      } else if (type === 'click') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: 'Not found: ' + sel };
            el.click(); return { ok: true };
          },
          args: [params.selector]
        });
        result = res[0].result;

      } else if (type === 'click_coords') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (x, y) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return { ok: false, error: 'No element at coordinates' };
            el.click(); return { ok: true, tag: el.tagName };
          },
          args: [params.x, params.y]
        });
        result = res[0].result;

      } else if (type === 'hover') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: 'Not found: ' + sel };
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            return { ok: true };
          },
          args: [params.selector]
        });
        result = res[0].result;

      } else if (type === 'type') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, text) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: 'Not found: ' + sel };
            el.focus();
            // For contenteditable (ProseMirror etc)
            if (el.isContentEditable) {
              document.execCommand('insertText', false, text);
            } else {
              el.value = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return { ok: true };
          },
          args: [params.selector, params.text]
        });
        result = res[0].result;

      } else if (type === 'key') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, key) => {
            const el = sel ? document.querySelector(sel) : document.activeElement;
            if (!el) return { ok: false, error: 'Not found' };
            el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
            return { ok: true };
          },
          args: [params.selector || null, params.key]
        });
        result = res[0].result;

      } else if (type === 'select') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, value) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: 'Not found: ' + sel };
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          },
          args: [params.selector, params.value]
        });
        result = res[0].result;

      } else if (type === 'scroll') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, x, y) => {
            const el = sel ? document.querySelector(sel) : window;
            if (!el) return { ok: false, error: 'Not found' };
            (el === window ? window : el).scrollBy(x || 0, y || 0);
            return { ok: true };
          },
          args: [params.selector || null, params.x || 0, params.y || 0]
        });
        result = res[0].result;

      } else if (type === 'wait') {
        const tab = await getTab(params);
        const timeout = params.timeout || 10000;
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, ms) => {
            return new Promise((resolve) => {
              const start = Date.now();
              const check = () => {
                if (document.querySelector(sel)) return resolve({ ok: true });
                if (Date.now() - start > ms) return resolve({ ok: false, error: 'Timeout waiting for ' + sel });
                setTimeout(check, 300);
              };
              check();
            });
          },
          args: [params.selector, timeout]
        });
        result = res[0].result;

      } else if (type === 'content') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 15000) })
        });
        result = res[0].result;

      } else if (type === 'find') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const els = document.querySelectorAll(sel);
            return { count: els.length, texts: Array.from(els).slice(0, 10).map(e => e.innerText?.slice(0, 200)) };
          },
          args: [params.selector]
        });
        result = res[0].result;

      } else if (type === 'screenshot') {
        const tab = await getTab(params);
        // Switch to the target tab briefly for screenshot
        const win = await chrome.windows.get(tab.windowId);
        result = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 70 });

      } else if (type === 'eval') {
        const tab = await getTab(params);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (code) => {
            try { return { ok: true, value: String(eval(code)) }; }
            catch (e) { return { ok: false, error: e.message }; }
          },
          args: [params.code]
        });
        result = res[0].result;

      } else if (type === 'new_hidden_window') {
        const win = await chrome.windows.create({
          url: params.url || 'about:blank',
          type: 'popup',
          width: 800, height: 600,
          left: -9999, top: -9999,
          focused: false
        });
        result = { ok: true, windowId: win.id, tabId: win.tabs[0].id };

      } else if (type === 'close_window') {
        await chrome.windows.remove(params.windowId);
        result = { ok: true };

      } else {
        error = 'Unknown command: ' + type;
      }

    } catch (e) {
      error = e.message;
    }

    ws.send(JSON.stringify({ id, result, error }));
  };
}

connect();
