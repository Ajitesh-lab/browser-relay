let ws = null;

// Keep service worker alive via content script ports
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onDisconnect.addListener(() => {}); // just hold the port open
  }
});

function connect() {
  ws = new WebSocket('ws://127.0.0.1:9999/ws');

  ws.onopen = () => {
    console.log('Connected v6');
    ws.send(JSON.stringify({ type: 'hello', version: 'v6' }));
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
        result = 'v6';

      } else if (type === 'new_tab') {
        const tab = await chrome.tabs.create({ url: params.url, active: true });
        result = { ok: true, tabId: tab.id, url: params.url };

      } else if (type === 'navigate') {
        const win = await chrome.windows.getLastFocused({ populate: true });
        const tab = win.tabs.find(t => t.active);
        if (!tab) throw new Error('No active tab');
        await chrome.tabs.update(tab.id, { url: params.url });
        result = { ok: true, url: params.url };

      } else if (type === 'click') {
        const win = await chrome.windows.getLastFocused({ populate: true });
        const tab = win.tabs.find(t => t.active);
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

      } else if (type === 'type') {
        const win = await chrome.windows.getLastFocused({ populate: true });
        const tab = win.tabs.find(t => t.active);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, text) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: 'Not found: ' + sel };
            el.focus(); el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          },
          args: [params.selector, params.text]
        });
        result = res[0].result;

      } else if (type === 'content') {
        const win = await chrome.windows.getLastFocused({ populate: true });
        const tab = win.tabs.find(t => t.active);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 10000) })
        });
        result = res[0].result;

      } else if (type === 'screenshot') {
        const win = await chrome.windows.getLastFocused({});
        result = await chrome.tabs.captureVisibleTab(win.id, { format: 'jpeg', quality: 70 });

      } else if (type === 'eval') {
        const win = await chrome.windows.getLastFocused({ populate: true });
        const tab = win.tabs.find(t => t.active);
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (code) => {
            try { return { ok: true, value: String(eval(code)) }; }
            catch (e) { return { ok: false, error: e.message }; }
          },
          args: [params.code]
        });
        result = res[0].result;
      }

    } catch (e) {
      error = e.message;
    }

    ws.send(JSON.stringify({ id, result, error }));
  };
}

connect();
