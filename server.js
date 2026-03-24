const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();

// CORS — allow Nordic Studio (any localhost origin) to call the relay
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const extensionSockets = new Map(); // ws -> version string
let pendingCommands = {};

// In-memory pinned tab registry: hostname → { tabId, url }
// Lives only in RAM — cleared on process restart, so tabs only reopen when Gemini calls them
const pinnedTabs = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

wss.on('connection', (ws) => {
  extensionSockets.set(ws, 'unknown');
  console.log(`Chrome extension connected (${extensionSockets.size} total)`);

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'ping') return;
    if (msg.type === 'hello') {
      extensionSockets.set(ws, { version: msg.version, url: msg.url, title: msg.title });
      console.log(`[server] hello: ${msg.version} | ${msg.url}`);
      return;
    }
    const { id, result, error } = msg;
    if (pendingCommands[id]) {
      const { resolve, reject } = pendingCommands[id];
      if (error) reject(new Error(error));
      else resolve(result);
    }
  });

  ws.on('close', () => {
    extensionSockets.delete(ws);
    console.log(`Chrome extension disconnected (${extensionSockets.size} remaining)`);
  });
});

let activeSocket = null; // explicitly focused socket

function getSocket(exclude = new Set()) {
  if (activeSocket && activeSocket.readyState === activeSocket.OPEN && !exclude.has(activeSocket)) {
    return activeSocket;
  }
  let best = null;
  for (const [ws, info] of extensionSockets) {
    if (ws.readyState !== ws.OPEN) continue;
    if (exclude.has(ws)) continue;
    if (info.version === 'v10') best = ws;
  }
  if (best) return best;
  for (const [ws] of extensionSockets) {
    if (ws.readyState === ws.OPEN && !exclude.has(ws)) return ws;
  }
  return null;
}

function sendCommand(type, params = {}, exclude = new Set(), attempt = 0) {
  return new Promise((resolve, reject) => {
    const socket = getSocket(exclude);
    if (!socket) return reject(new Error('No browser extension connected'));
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      delete pendingCommands[id];
      reject(new Error('Command timed out after 15s'));
    }, 15000);
    pendingCommands[id] = {
      resolve: (result) => { clearTimeout(timer); delete pendingCommands[id]; resolve(result); },
      reject: (err) => {
        clearTimeout(timer);
        delete pendingCommands[id];
        if (err.message && err.message.includes('context invalidated') && attempt < 5) {
          exclude.add(socket);
          sendCommand(type, params, exclude, attempt + 1).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      },
      timer
    };
    socket.send(JSON.stringify({ id, type, params }));
  });
}

// Helper to wrap all routes
function route(type, paramsFn) {
  return async (req, res) => {
    try {
      const result = await sendCommand(type, paramsFn ? paramsFn(req.body) : {});
      res.json({ ok: true, result });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  };
}

// ── Internal navigate with smart pinned-tab routing ──
async function internalNavigate(url) {
  let domainKey;
  try { domainKey = new URL(url).hostname; } catch { domainKey = url; }

  const pinned = pinnedTabs.get(domainKey);
  if (pinned) {
    try {
      const tabs = await sendCommand('tabs_list', {});
      const alive = Array.isArray(tabs) && tabs.find(t => t.id === pinned.tabId);
      if (alive) {
        await sendCommand('navigate', { url, tabId: pinned.tabId });
        pinnedTabs.set(domainKey, { tabId: pinned.tabId, url });
        console.log(`[pinned] reused tab ${pinned.tabId} for ${domainKey}`);
        return { tabId: pinned.tabId, reused: true };
      }
    } catch {}
    pinnedTabs.delete(domainKey);
    console.log(`[pinned] stale tab for ${domainKey} — creating fresh`);
  }

  const newTab = await sendCommand('new_tab', { url, pinned: true, active: false });
  const tabId = newTab.tabId;
  pinnedTabs.set(domainKey, { tabId, url });
  console.log(`[pinned] opened and pinned tab ${tabId} for ${domainKey}`);
  return { tabId, reused: false };
}

// ── Status ──
async function statusHandler(req, res) {
  if (!getSocket()) return res.json({ connected: false });
  try {
    const result = await sendCommand('version', {});
    res.json({ connected: true, version: result });
  } catch (e) {
    res.json({ connected: true, version: 'unknown' });
  }
}
app.get('/status', statusHandler);
app.post('/status', statusHandler);

app.get('/sockets', (req, res) => {
  const list = [];
  for (const [ws, info] of extensionSockets) {
    if (ws.readyState !== ws.OPEN) continue;
    list.push({ url: info.url, title: info.title, version: info.version, active: ws === activeSocket });
  }
  res.json(list);
});
app.post('/sockets', (req, res) => res.redirect(307, '/sockets'));

app.post('/focus', (req, res) => {
  const { url } = req.body;
  for (const [ws, info] of extensionSockets) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!url || (info.url && info.url.includes(url))) {
      activeSocket = ws;
      return res.json({ ok: true, focused: info.url });
    }
  }
  res.status(404).json({ ok: false, error: 'No socket matching: ' + url });
});

// ── Tab management ──
app.post('/new_tab',          route('new_tab',          b => ({ url: b.url || 'about:blank', pinned: b.pinned || false, active: b.active !== false })));
app.post('/pin_tab',          route('pin_tab',          b => ({ tabId: b.tabId })));
app.post('/new_hidden_window',route('new_hidden_window', b => ({ url: b.url })));
app.post('/close_window',     route('close_window',      b => ({ windowId: b.windowId })));
app.post('/tabs_list',        route('tabs_list'));
app.post('/tabs_switch',      route('tabs_switch', b => ({ tabId: b.tabId })));
app.post('/tabs_close',       route('tabs_close',  b => ({ tabId: b.tabId })));

// ── Navigation — smart pinned-tab routing (HTTP route) ──
app.post('/navigate', async (req, res) => {
  const { url, tabId: explicitTabId } = req.body;

  if (explicitTabId) {
    try {
      const result = await sendCommand('navigate', { url, tabId: explicitTabId });
      return res.json({ ok: true, result });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  try {
    const nav = await internalNavigate(url);
    res.json({ ok: true, result: { tabId: nav.tabId, url, pinned: true, reused: nav.reused } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/pinned_tabs', (req, res) => {
  const entries = [];
  for (const [domain, info] of pinnedTabs) entries.push({ domain, ...info });
  res.json(entries);
});

// ── Interaction (all support optional tabId) ──
app.post('/click',       route('click',       b => ({ selector: b.selector, tabId: b.tabId })));
app.post('/click_coords',route('click_coords',b => ({ x: b.x, y: b.y, tabId: b.tabId })));
app.post('/hover',       route('hover',       b => ({ selector: b.selector, tabId: b.tabId })));
app.post('/type',        route('type',        b => ({ selector: b.selector, text: b.text, tabId: b.tabId })));
app.post('/key',         route('key',         b => ({ selector: b.selector, key: b.key, tabId: b.tabId })));
app.post('/select',      route('select',      b => ({ selector: b.selector, value: b.value, tabId: b.tabId })));
app.post('/scroll',      route('scroll',      b => ({ selector: b.selector, x: b.x, y: b.y, tabId: b.tabId })));
app.post('/wait',        route('wait',        b => ({ selector: b.selector, timeout: b.timeout, tabId: b.tabId })));

// ── Page info (all support optional tabId) ──
app.post('/content',     route('content',     b => ({ tabId: b.tabId })));
app.post('/find',        route('find',        b => ({ selector: b.selector, tabId: b.tabId })));
app.post('/screenshot',  route('screenshot',  b => ({ tabId: b.tabId })));
app.post('/eval',        route('eval',        b => ({ code: b.code, tabId: b.tabId })));

// ── Fetch content from any URL via pinned tab ──
app.post('/fetch_page', async (req, res) => {
  const { url } = req.body;
  try {
    const { tabId } = await internalNavigate(url);
    await sleep(4000); // let page load
    const content = await sendCommand('content', { tabId });
    res.json({ ok: true, tabId, content });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Ask claude.ai a question via the user's logged-in browser ──
app.post('/ask_claude', async (req, res) => {
  const { question } = req.body;
  const maxWait = req.body.timeout || 60000;

  try {
    // 1. Navigate to claude.ai/new in a pinned tab
    const { tabId } = await internalNavigate('https://claude.ai/new');
    await sleep(4000);

    // 2. Check if we're on claude.ai and the editor exists
    const checkResult = await sendCommand('eval', {
      code: `(function(){
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('.ProseMirror');
        return JSON.stringify({ hasEditor: !!editor, url: location.href, loggedIn: !location.href.includes('/login') });
      })()`,
      tabId
    });

    const check = JSON.parse(checkResult?.value || checkResult || '{}');
    if (!check.hasEditor) {
      return res.json({ ok: false, error: 'Claude.ai editor not found — may need login', url: check.url });
    }

    // 3. Clear editor and type the question
    await sendCommand('eval', {
      code: `(function(){
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('.ProseMirror');
        editor.focus();
        // Select all existing text and delete
        document.execCommand('selectAll');
        document.execCommand('delete');
        // Type the question
        document.execCommand('insertText', false, ${JSON.stringify(question)});
        return 'typed';
      })()`,
      tabId
    });

    await sleep(800);

    // 4. Click the send button
    await sendCommand('eval', {
      code: `(function(){
        // Try aria-label variants
        let btn = document.querySelector('button[aria-label="Send Message"]') ||
                  document.querySelector('button[aria-label="Send message"]') ||
                  document.querySelector('button[aria-label="Send"]');
        // Try finding button with SVG arrow icon near the editor
        if (!btn) {
          const buttons = Array.from(document.querySelectorAll('button'));
          btn = buttons.find(b => {
            const rect = b.getBoundingClientRect();
            return rect.bottom > window.innerHeight - 200 && b.querySelector('svg');
          });
        }
        // Try submit button
        if (!btn) btn = document.querySelector('form button[type="submit"]');
        if (btn) { btn.click(); return 'clicked: ' + (btn.ariaLabel || btn.className); }
        // Last resort: Enter key
        const editor = document.querySelector('[contenteditable="true"]');
        if (editor) {
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          return 'enter-fallback';
        }
        return 'no-send-button';
      })()`,
      tabId
    });

    // 5. Poll for the response to complete
    await sleep(5000); // initial wait for streaming to start

    const startTime = Date.now();
    let bestText = '';
    let stableCount = 0;

    while (Date.now() - startTime < maxWait) {
      await sleep(3000);

      try {
        const pollResult = await sendCommand('eval', {
          code: `(function(){
            // Detect streaming state
            const stopBtn = document.querySelector('button[aria-label="Stop Response"]') ||
                           document.querySelector('button[aria-label="Stop response"]') ||
                           document.querySelector('[data-state="streaming"]');
            const isStreaming = !!stopBtn;

            // Try to get the last assistant message
            // Claude.ai uses various selectors depending on version
            const msgContainers = document.querySelectorAll('[data-is-streaming], [class*="response"], [class*="message"]');
            let responseText = '';

            // Strategy 1: find the last large text block that appeared after the input
            const allBlocks = document.querySelectorAll('div[class], article, section');
            for (const block of allBlocks) {
              const text = block.innerText || '';
              if (text.length > responseText.length && text.length > 100) {
                // Exclude navigation/header elements
                const tag = block.tagName.toLowerCase();
                if (!block.querySelector('nav') && !block.querySelector('header')) {
                  responseText = text;
                }
              }
            }

            // Strategy 2: just get page text and extract the likely answer
            const fullText = document.body.innerText;

            return JSON.stringify({
              streaming: isStreaming,
              responseText: responseText.slice(0, 8000),
              fullTextLen: fullText.length,
              fullTextEnd: fullText.slice(-5000)
            });
          })()`,
          tabId
        });

        const parsed = JSON.parse(pollResult?.value || pollResult || '{}');
        const currentText = parsed.responseText || parsed.fullTextEnd || '';

        if (currentText.length > 100) {
          if (currentText === bestText) {
            stableCount++;
            if (stableCount >= 2 && !parsed.streaming) break;
          } else {
            stableCount = 0;
            bestText = currentText;
          }
          if (!parsed.streaming && currentText.length > 100) {
            bestText = currentText;
            break;
          }
        }
      } catch { /* continue polling */ }
    }

    if (bestText.length > 50) {
      res.json({ ok: true, response: bestText.slice(0, 8000) });
    } else {
      res.json({ ok: false, error: 'Could not read response from claude.ai', partial: bestText });
    }

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Search DuckDuckGo Lite for quick web results ──
app.post('/search_ddg', async (req, res) => {
  const { query } = req.body;
  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const { tabId } = await internalNavigate(url);
    await sleep(4000);

    const content = await sendCommand('content', { tabId });
    const text = typeof content === 'string' ? content : (content?.text || JSON.stringify(content));

    res.json({ ok: true, content: text.slice(0, 6000) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

server.listen(9999, () => console.log('Browser relay server running on http://localhost:9999'));
