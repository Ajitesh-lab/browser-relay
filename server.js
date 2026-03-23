const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const extensionSockets = new Map(); // ws -> version string
let pendingCommands = {};

// In-memory pinned tab registry: hostname → { tabId, url }
// Lives only in RAM — cleared on process restart, so tabs only reopen when Gemini calls them
const pinnedTabs = new Map();

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
  // Use explicitly focused socket if available
  if (activeSocket && activeSocket.readyState === activeSocket.OPEN && !exclude.has(activeSocket)) {
    return activeSocket;
  }
  // Otherwise pick most recently connected v10 (last in Map)
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
        // Retry on a different socket if context was invalidated
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

// List all connected tab sockets
app.get('/sockets', (req, res) => {
  const list = [];
  for (const [ws, info] of extensionSockets) {
    if (ws.readyState !== ws.OPEN) continue;
    list.push({ url: info.url, title: info.title, version: info.version, active: ws === activeSocket });
  }
  res.json(list);
});
app.post('/sockets', (req, res) => res.redirect(307, '/sockets'));

// Focus a specific tab by URL substring
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

// Tab management
app.post('/new_tab',     route('new_tab',     b => ({ url: b.url || 'about:blank', pinned: b.pinned || false })));
app.post('/pin_tab',          route('pin_tab',          b => ({ tabId: b.tabId })));
app.post('/new_hidden_window',route('new_hidden_window', b => ({ url: b.url })));
app.post('/close_window',     route('close_window',      b => ({ windowId: b.windowId })));
app.post('/tabs_list',   route('tabs_list'));
app.post('/tabs_switch', route('tabs_switch', b => ({ tabId: b.tabId })));
app.post('/tabs_close',  route('tabs_close',  b => ({ tabId: b.tabId })));

// Navigation — smart pinned-tab routing
app.post('/navigate', async (req, res) => {
  const { url, tabId: explicitTabId } = req.body;

  // Legacy: caller explicitly specified a tabId — direct navigate, no pinning
  if (explicitTabId) {
    try {
      const result = await sendCommand('navigate', { url, tabId: explicitTabId });
      return res.json({ ok: true, result });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // Derive a stable key from the hostname (e.g. "claude.ai", "jsonplaceholder.typicode.com")
  let domainKey;
  try { domainKey = new URL(url).hostname; } catch { domainKey = url; }

  // Check if we already have a pinned tab for this domain
  const pinned = pinnedTabs.get(domainKey);
  if (pinned) {
    try {
      // Verify the tab still exists (user might have closed it)
      const tabs = await sendCommand('tabs_list', {});
      const alive = Array.isArray(tabs) && tabs.find(t => t.id === pinned.tabId);
      if (alive) {
        await sendCommand('navigate', { url, tabId: pinned.tabId });
        pinnedTabs.set(domainKey, { tabId: pinned.tabId, url });
        console.log(`[pinned] reused tab ${pinned.tabId} for ${domainKey}`);
        return res.json({ ok: true, result: { tabId: pinned.tabId, url, pinned: true, reused: true } });
      }
    } catch (e) { /* tab gone or error — fall through to create */ }
    pinnedTabs.delete(domainKey);
    console.log(`[pinned] stale tab for ${domainKey} — creating fresh`);
  }

  // First time for this domain — open a new tab, pin it, register it
  try {
    const newTab = await sendCommand('new_tab', { url, pinned: true });
    const tabId = newTab.tabId;
    pinnedTabs.set(domainKey, { tabId, url });
    console.log(`[pinned] opened and pinned tab ${tabId} for ${domainKey}`);
    return res.json({ ok: true, result: { tabId, url, pinned: true, reused: false } });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// Inspect current pinned tab registry
app.get('/pinned_tabs', (req, res) => {
  const entries = [];
  for (const [domain, info] of pinnedTabs) entries.push({ domain, ...info });
  res.json(entries);
});

// Interaction (all support optional tabId)
app.post('/click',       route('click',       b => ({ selector: b.selector, tabId: b.tabId })));
app.post('/click_coords',route('click_coords',b => ({ x: b.x, y: b.y, tabId: b.tabId })));
app.post('/hover',       route('hover',       b => ({ selector: b.selector, tabId: b.tabId })));
app.post('/type',        route('type',        b => ({ selector: b.selector, text: b.text, tabId: b.tabId })));
app.post('/key',         route('key',         b => ({ selector: b.selector, key: b.key, tabId: b.tabId })));
app.post('/select',      route('select',      b => ({ selector: b.selector, value: b.value, tabId: b.tabId })));
app.post('/scroll',      route('scroll',      b => ({ selector: b.selector, x: b.x, y: b.y, tabId: b.tabId })));
app.post('/wait',        route('wait',        b => ({ selector: b.selector, timeout: b.timeout, tabId: b.tabId })));

// Page info (all support optional tabId)
app.post('/content',     route('content',     b => ({ tabId: b.tabId })));
app.post('/find',        route('find',        b => ({ selector: b.selector, tabId: b.tabId })));
app.post('/screenshot',  route('screenshot',  b => ({ tabId: b.tabId })));
app.post('/eval',        route('eval',        b => ({ code: b.code, tabId: b.tabId })));

server.listen(9999, () => console.log('Browser relay server running on http://localhost:9999'));
