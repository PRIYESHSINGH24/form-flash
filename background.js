/* Background service worker. Turns the keyboard shortcuts into the same
 * messages the popup sends: Alt+Shift+F fills the form, Alt+Shift+P opens or
 * collapses the FormFlash panel on the page.
 */
const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.office\.com\/|forms\.microsoft\.com\/|forms\.cloud\.microsoft\/)/;

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-form' && command !== 'toggle-panel') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null || !tab.url || !FORM_URL.test(tab.url)) return;

    if (command === 'toggle-panel') {
      await sendToTab(tab.id, { type: 'FORMFLASH_PANEL', action: 'toggle' });
      return;
    }
    const res = await sendToTab(tab.id, { type: 'FORMFLASH_FILL' });
    const report = res && res.ok ? res.report : null;
    if (report && report.filled > 0) await flashBadge(tab.id, report.filled);
  } catch (err) {
    console.warn('[FormFlash] shortcut failed:', err);
  }
});

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Content script missing (tab open since before install or reload): inject it.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/matcher.js', 'content.js'],
    });
    return await chrome.tabs.sendMessage(tabId, msg);
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
