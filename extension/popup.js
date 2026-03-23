chrome.action.getBadgeText({}, (text) => {
  const el = document.getElementById('status');
  if (text === 'ON') { el.textContent = '🟢 Connected'; el.className = 'on'; }
  else { el.textContent = '🔴 Disconnected'; el.className = 'off'; }
});
