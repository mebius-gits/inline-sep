export const $ = selector => document.querySelector(selector);
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const money = value => `NT$${Number(value).toLocaleString('zh-TW')}`;
export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'inline-sep', ...options.headers }, signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('連線未完成，請確認網路後重試。重送同筆訂單不會重複登記。'); }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '操作失敗，請重試'), { status: response.status });
  return result;
}
let toastTimer;
export function toast(message) {
  const element = $('#toast');
  element.textContent = message; element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 4500);
}
export function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* LAN/permissions fallback */ }
  }
  const area = document.createElement('textarea');
  area.value = text; area.className = 'clipboard-fallback'; document.body.append(area); area.select();
  const success = document.execCommand('copy'); area.remove();
  if (!success) throw new Error('無法自動複製，請選取備註文字後手動複製');
}
