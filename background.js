/* Background service worker. Its only job is turning the keyboard shortcut
 * (Alt+Shift+F) into the same fill message the popup sends.
 */
const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.office\.com\/|forms\.microsoft\.com\/|forms\.cloud\.microsoft\.com\/)/;

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-form') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null || !tab.url || !FORM_URL.test(tab.url)) return;
    const report = await requestFill(tab.id);
    if (report && report.filled > 0) await flashBadge(tab.id, report.filled);
  } catch (err) {
    console.warn('[FormFlash] shortcut failed:', err);
  }
});

async function requestFill(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'FORMFLASH_FILL' });
    return res && res.ok ? res.report : null;
  } catch {
    // Content script missing (tab open since before install or reload): inject it.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/matcher.js', 'content.js'],
    });
    const res = await chrome.tabs.sendMessage(tabId, { type: 'FORMFLASH_FILL' });
    return res && res.ok ? res.report : null;
  }
}

async function flashBadge(tabId, count) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#2b6cb0' });
    await chrome.action.setBadgeText({ tabId, text: String(count) });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    }, 4000);
  } catch {}
}
