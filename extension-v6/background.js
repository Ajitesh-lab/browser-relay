// Keep service worker alive AND handle privileged commands via the keepalive port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onDisconnect.addListener(() => {});
    port.onMessage.addListener(async (msg) => {
      if (!msg.id) return; // skip non-command messages
      try {
        const response = await handleCommand(msg);
        port.postMessage(response);
      } catch(e) {
        port.postMessage({ id: msg.id, result: null, error: e.message });
      }
    });
  }
});

// Badge status updates from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ws_status') {
    chrome.action.setBadgeText({ text: msg.connected ? 'ON' : 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: msg.connected ? '#22c55e' : '#ef4444' });
    return;
  }

  // Handle browser commands — return true to keep channel open for async response
  handleCommand(msg).then(sendResponse).catch(e => sendResponse({ id: msg.id, result: null, error: e.message }));
  return true;
});

async function getTab(tabId) {
  if (tabId) return await chrome.tabs.get(tabId);
  const win = await chrome.windows.getLastFocused({ populate: true });
  const tab = win.tabs.find(t => t.active);
  if (!tab) throw new Error('No active tab');
  return tab;
}

async function runInTab(tabId, func, args = []) {
  const tab = await getTab(tabId);
  const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return res[0].result;
}

async function handleCommand({ id, type, params = {} }) {
  let result = null;
  let error = null;

  try {
    if (type === 'version') {
      result = 'v9';

    } else if (type === 'new_tab') {
      const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: true, pinned: params.pinned || false });
      result = { ok: true, tabId: tab.id, url: params.url };

    } else if (type === 'pin_tab') {
      const tab = await getTab(params.tabId);
      await chrome.tabs.update(tab.id, { pinned: true });
      result = { ok: true, tabId: tab.id };

    } else if (type === 'new_hidden_window') {
      // Opens a window far off-screen — invisible to the user
      const win = await chrome.windows.create({
        url: params.url,
        type: 'popup',
        left: -3000,
        top: -3000,
        width: 1280,
        height: 800,
        focused: false
      });
      const tab = win.tabs[0];
      result = { ok: true, tabId: tab.id, windowId: win.id, url: params.url };

    } else if (type === 'close_window') {
      await chrome.windows.remove(params.windowId);
      result = { ok: true };

    } else if (type === 'navigate') {
      const tab = await getTab(params.tabId);
      await chrome.tabs.update(tab.id, { url: params.url });
      result = { ok: true, tabId: tab.id, url: params.url };

    } else if (type === 'tabs_list') {
      const tabs = await chrome.tabs.query({});
      result = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));

    } else if (type === 'tabs_switch') {
      await chrome.tabs.update(params.tabId, { active: true });
      const tab = await chrome.tabs.get(params.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      result = { ok: true };

    } else if (type === 'tabs_close') {
      await chrome.tabs.remove(params.tabId);
      result = { ok: true };

    } else if (type === 'click') {
      result = await runInTab(params.tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'Not found: ' + sel };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, tag: el.tagName, text: el.innerText?.slice(0, 100) };
      }, [params.selector]);

    } else if (type === 'click_coords') {
      result = await runInTab(params.tabId, (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return { ok: false, error: 'No element at coords' };
        el.click();
        return { ok: true, tag: el.tagName };
      }, [params.x, params.y]);

    } else if (type === 'hover') {
      result = await runInTab(params.tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'Not found: ' + sel };
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return { ok: true };
      }, [params.selector]);

    } else if (type === 'type') {
      result = await runInTab(params.tabId, (sel, text) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'Not found: ' + sel };
        el.focus();
        if (el.isContentEditable) {
          el.textContent = '';
          document.execCommand('insertText', false, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true, value: el.textContent };
        } else {
          el.value = '';
          for (const char of text) {
            el.value += char;
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: el.value };
        }
      }, [params.selector, params.text]);

    } else if (type === 'key') {
      result = await runInTab(params.tabId, (sel, key) => {
        const el = sel ? document.querySelector(sel) : document.activeElement;
        if (!el) return { ok: false, error: 'No element' };
        ['keydown', 'keypress', 'keyup'].forEach(t =>
          el.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true, cancelable: true }))
        );
        if (key === 'Enter') { const f = el.closest('form'); if (f) f.submit(); }
        return { ok: true };
      }, [params.selector || null, params.key]);

    } else if (type === 'select') {
      result = await runInTab(params.tabId, (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'Not found: ' + sel };
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      }, [params.selector, params.value]);

    } else if (type === 'scroll') {
      result = await runInTab(params.tabId, (sel, x, y) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: 'Not found' };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.scrollBy({ left: x || 0, top: y || 500, behavior: 'smooth' });
        }
        return { ok: true, scrollY: window.scrollY };
      }, [params.selector || null, params.x || 0, params.y || 500]);

    } else if (type === 'wait') {
      result = await runInTab(params.tabId, (sel, timeout) => {
        return new Promise(resolve => {
          const start = Date.now();
          const check = () => {
            const el = document.querySelector(sel);
            if (el) return resolve({ ok: true, found: true });
            if (Date.now() - start > timeout) return resolve({ ok: false, error: 'Timeout: ' + sel });
            setTimeout(check, 200);
          };
          check();
        });
      }, [params.selector, params.timeout || 10000]);

    } else if (type === 'content') {
      result = await runInTab(params.tabId, () => ({
        url: location.href,
        title: document.title,
        text: document.body.innerText.slice(0, 15000),
        html: document.documentElement.outerHTML.slice(0, 50000)
      }));

    } else if (type === 'find') {
      result = await runInTab(params.tabId, (sel) => {
        return Array.from(document.querySelectorAll(sel)).slice(0, 20).map((el, i) => ({
          index: i, tag: el.tagName,
          text: el.innerText?.slice(0, 200),
          href: el.href || null,
          value: el.value || null,
          id: el.id || null,
          class: el.className?.slice(0, 100) || null
        }));
      }, [params.selector]);

    } else if (type === 'screenshot') {
      const tab = await getTab(params.tabId);
      result = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });

    } else if (type === 'eval') {
      result = await runInTab(params.tabId, (code) => {
        try { return { ok: true, value: String(eval(code)) }; }
        catch (e) { return { ok: false, error: e.message }; }
      }, [params.code]);
    }

  } catch (e) {
    error = e.message;
  }

  return { id, result, error };
}

// On install/startup inject content script into all existing tabs
chrome.runtime.onInstalled.addListener(injectAll);
chrome.runtime.onStartup.addListener(injectAll);

async function injectAll() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['keepalive.js'] });
    } catch (e) { /* skip restricted tabs */ }
  }
}
