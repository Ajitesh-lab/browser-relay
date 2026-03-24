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

// Helper: run JS in a specific tab and return the raw string result
async function evalInTab(tabId, code) {
  const raw = await sendCommand('eval', { code, tabId });
  // background.js runInTab returns { ok, value } or { ok, error }
  if (raw?.error) throw new Error(raw.error);
  if (raw?.value !== undefined) return raw.value;
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw);
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
      // Try navigating directly — if the tab was closed, this throws
      await sendCommand('navigate', { url, tabId: pinned.tabId });
      pinnedTabs.set(domainKey, { tabId: pinned.tabId, url });
      console.log(`[pinned] reused tab ${pinned.tabId} for ${domainKey}`);
      return { tabId: pinned.tabId, reused: true };
    } catch {
      pinnedTabs.delete(domainKey);
      console.log(`[pinned] stale tab for ${domainKey} — creating fresh`);
    }
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
// Uses ONLY content/type/click/key commands (no eval — claude.ai CSP blocks it)
app.post('/ask_claude', async (req, res) => {
  const { question } = req.body;
  const maxWait = req.body.timeout || 60000;

  try {
    // 1. Navigate to claude.ai/new — reuses the pinned tab
    const { tabId } = await internalNavigate('https://claude.ai/new');
    await sleep(5000);

    // 2. Check page loaded by reading content
    const page = await sendCommand('content', { tabId });
    const pageUrl = page?.url || '';
    if (pageUrl.includes('/login') || (!pageUrl.includes('claude.ai'))) {
      return res.json({ ok: false, error: 'Claude.ai not logged in or wrong page', url: pageUrl });
    }

    // 3. Record baseline text length (before response)
    const baselineLen = (page?.text || '').length;

    // 4. Type the question into the editor
    const typeResult = await sendCommand('type', {
      selector: '[contenteditable="true"]',
      text: question,
      tabId
    });
    if (typeResult?.error) {
      // Try ProseMirror selector
      await sendCommand('type', { selector: '.ProseMirror', text: question, tabId });
    }
    await sleep(800);

    // 5. Click the send button — try multiple selectors
    const sendSelectors = [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'form button[type="submit"]',
    ];
    let sent = false;
    for (const sel of sendSelectors) {
      try {
        const r = await sendCommand('click', { selector: sel, tabId });
        if (r?.ok) { sent = true; console.log('[ask_claude] clicked:', sel); break; }
      } catch {}
    }
    if (!sent) {
      // Fallback: press Enter in the editor
      await sendCommand('key', { selector: '[contenteditable="true"]', key: 'Enter', tabId });
      console.log('[ask_claude] enter fallback');
    }

    // 6. Poll for response by reading page content until it stabilizes
    //    Look for text AFTER the user's question on the page
    await sleep(6000);
    const startTime = Date.now();
    let bestText = '';
    let stableCount = 0;
    const questionSnippet = question.slice(0, 60); // to locate the question on the page

    while (Date.now() - startTime < maxWait) {
      await sleep(3000);
      try {
        const current = await sendCommand('content', { tabId });
        const fullText = current?.text || '';

        // Find the question in the page text and grab everything after it
        const qIdx = fullText.lastIndexOf(questionSnippet);
        let responseText = '';
        if (qIdx >= 0) {
          // Skip past the question itself + timestamp line
          responseText = fullText.slice(qIdx + question.length).trim();
          // Remove trailing UI chrome (e.g. "Sonnet 4.6\nClaude is AI...")
          const chromeIdx = responseText.lastIndexOf('\nSonnet');
          if (chromeIdx > 0) responseText = responseText.slice(0, chromeIdx).trim();
          const chromeIdx2 = responseText.lastIndexOf('\nClaude is AI');
          if (chromeIdx2 > 0) responseText = responseText.slice(0, chromeIdx2).trim();
          // Remove leading timestamp (e.g. "18:45")
          responseText = responseText.replace(/^\d{1,2}:\d{2}\s*/, '').trim();
        }

        if (responseText.length > 0) {
          if (responseText === bestText) {
            stableCount++;
            if (stableCount >= 2) break;
          } else {
            stableCount = 0;
            bestText = responseText;
          }
        }
      } catch { /* continue polling */ }
    }

    if (bestText.length > 0) {
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
