import { $, escapeHtml as e, money, api, toast, copyText } from './shared.js';
let session, rounds=[], report, menu=[], selectedRound, pendingAction, currentTab='orders', refreshVersion=0;
const json = value => JSON.stringify(value);
function showError(error) { if (error.status===401) { showLogin(); return; } $('#admin-error').textContent=error.message; $('#admin-error').hidden=false; }
function showLogin() { $('#dashboard').hidden=true; $('#logout').hidden=true; $('#login-section').hidden=false; $('#admin-password').value=''; }
function empty(title, description) { return `<div class="empty-state"><strong>${e(title)}</strong><p>${e(description)}</p></div>`; }
async function boot() {
  try {
    session=await api('/api/admin/session');
    if (session.authenticated) await enterDashboard();
    else {
      showLogin();
      if (session.setupRequired) {
        $('#login-title').textContent='設定你的主揪後台';
        $('#login-description').textContent=session.canSetupLocal?'首次使用，請建立至少 12 個字元的後台密碼。之後使用這組密碼登入。':'請先在伺服器本機開啟 localhost 的後台設定密碼，或由管理者設定 ADMIN_PASSWORD。';
        $('#login-form').hidden=!session.canSetupLocal;
        $('#confirm-password-wrap').hidden=false;
        $('#confirm-password').required=true;
        $('#admin-password').minLength=12;
        $('#admin-password').autocomplete='new-password';
        $('#login-submit').textContent='建立密碼並進入後台';
      }
    }
  } catch(error) { showError(error); }
  finally { $('#admin-loading').hidden=true; }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').hidden=true;
  const password=$('#admin-password').value;
  if (session.setupRequired && password!==$('#confirm-password').value) { $('#login-error').textContent='兩次輸入的密碼不同'; $('#login-error').hidden=false; return; }
  $('#login-submit').disabled=true;
  try {
    await api(`/api/admin/${session.setupRequired?'setup':'login'}`,{ method:'POST',body:json({password}) });
    session.setupRequired=false;
    $('#confirm-password-wrap').hidden=true; $('#confirm-password').required=false; $('#admin-password').minLength=0;
    $('#admin-password').autocomplete='current-password'; $('#login-title').textContent='主揪，歡迎回來。'; $('#login-description').textContent='登入後查看每位同學的餐點，輕鬆彙整分單。'; $('#login-submit').textContent='登入後台';
    await enterDashboard();
  } catch(error) { $('#login-error').textContent=error.message; $('#login-error').hidden=false; }
  finally { $('#login-submit').disabled=false; }
});
async function enterDashboard() {
  $('#login-section').hidden=true; $('#dashboard').hidden=false; $('#logout').hidden=false; $('#admin-error').hidden=true;
  await refresh();
}
async function refresh() {
  const version=++refreshVersion;
  const latestRounds=await api('/api/admin/rounds');
  if (version!==refreshVersion) return;
  rounds=latestRounds;
  if (!rounds.some(r=>r.id===selectedRound)) selectedRound=rounds[0].id;
  const selected=selectedRound;
  const latestReport=await api(`/api/admin/report?roundId=${selected}`);
  if (version!==refreshVersion || selected!==selectedRound) return;
  report=latestReport;
  $('#round-select').innerHTML=rounds.map((r,i)=>`<option value="${r.id}" ${r.id===selectedRound?'selected':''}>${e(r.title)}${i===0?'（目前）':'（歷史）'}</option>`).join('');
  $('#admin-round-status').textContent=report.round.is_open?'開放登記中':'已截止收單';
  $('#admin-round-status').classList.toggle('closed',!report.round.is_open);
  $('#toggle-round').hidden=selectedRound!==rounds[0].id;
  $('#toggle-round').textContent=report.round.is_open?'截止收單':'重新開放';
  $('#stat-count').innerHTML=`${report.count} <small>人</small>`;
  $('#stat-quantity').textContent=report.quantity;
  $('#stat-total').textContent=money(report.total);
  $('#export-csv').href=`/api/admin/export.csv?roundId=${selectedRound}`;
  $('#download-notes').href=`/api/admin/notes.txt?roundId=${selectedRound}`;
  $('#split-notes').value=report.notes;
  $('#copy-notes').disabled=!report.count;
  renderOrders(); renderSummary();
  $('#refresh-label').textContent=`更新於 ${new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Taipei'})}（台北時間）・每 15 秒自動更新`;
}
function renderOrders() {
  const search=$('#order-search').value.trim().toLowerCase();
  const orders=report.orders.filter(o=>o.student_id.toLowerCase().includes(search)||o.items.some(m=>m.name.toLowerCase().includes(search)));
  $('#orders-content').innerHTML=orders.length?`<div class="table-wrap"><table><thead><tr><th>學號</th><th>餐點內容</th><th>口味備註</th><th>金額</th><th>操作</th></tr></thead><tbody>${orders.map(o=>`<tr><td class="student-cell">${e(o.student_id)}</td><td class="order-meals">${o.items.map(m=>`${e(m.name)} <span class="muted">× ${m.quantity}</span>`).join('<br>')}</td><td class="table-note">${e(o.note||'照店家一般做法')}</td><td class="table-price">${money(o.total)}</td><td><button class="cancel-button" data-cancel-order="${o.id}">取消訂單</button></td></tr>`).join('')}</tbody></table></div>`:empty(search?'找不到符合的訂單':'還沒有同學登記','分享點餐連結給同學，送出後就會出現在這裡。');
}
function renderSummary() {
  $('#summary-content').innerHTML=report.summary.length?`<div class="table-wrap"><table><thead><tr><th>餐點</th><th>單價</th><th>總份數</th><th>小計</th></tr></thead><tbody>${report.summary.map(m=>`<tr><td>${e(m.name)}</td><td class="table-price">${money(m.unit_price)}</td><td>${m.quantity}</td><td class="table-price">${money(m.subtotal)}</td></tr>`).join('')}</tbody></table></div><div class="summary-total">${report.quantity} 份餐點・合計 ${money(report.total)}</div>`:empty('餐點統計等待中','有同學登記後，這裡會自動加總每種餐點。');
}
$('#order-search').addEventListener('input',()=>{ if (report) renderOrders(); });
$('#round-select').addEventListener('change',async()=>{ selectedRound=Number($('#round-select').value); try { await refresh(); } catch(error) { showError(error); } });
$('#refresh').addEventListener('click',async()=>{ $('#refresh').disabled=true; try { await refresh(); $('#admin-error').hidden=true; toast('已更新最新訂單'); } catch(error) { showError(error); } finally { $('#refresh').disabled=false; } });
$('#logout').addEventListener('click',async()=>{ try { await api('/api/admin/logout',{method:'POST',body:'{}'}); showLogin(); } catch(error) { showError(error); } });
$('#share-link').addEventListener('click',async()=>{
  try {
    if (['localhost','127.0.0.1','[::1]'].includes(location.hostname)) { toast('目前是本機網址。請先以啟動終端顯示的 Wi-Fi 網址開啟此後台，再複製連結給同學。'); return; }
    await copyText(`${location.origin}/`); toast('已複製點餐連結');
  } catch(error) { toast(error.message); }
});
$('#copy-notes').addEventListener('click',async()=>{ try { await copyText($('#split-notes').value); toast('已複製分裝備註'); } catch(error) { toast(error.message); } });
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',async()=>{
  currentTab=button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(b=>{ b.classList.toggle('active',b===button); b.setAttribute('aria-pressed',String(b===button)); });
  document.querySelectorAll('.tab-panel').forEach(panel=>{ panel.hidden=panel.id!==`tab-${currentTab}`; });
  if (currentTab==='menu') try { await loadMenu(); } catch(error) { showError(error); }
}));
function confirmAction(title,description,label,action) {
  $('#confirm-title').textContent=title; $('#confirm-description').textContent=description; $('#confirm-action').textContent=label;
  $('#confirm-error').hidden=true; $('#confirm-action').disabled=false; $('#confirm-cancel').disabled=false; pendingAction=action; $('#confirm-dialog').showModal();
}
$('#confirm-cancel').addEventListener('click',()=>$('#confirm-dialog').close());
$('#confirm-action').addEventListener('click',async()=>{
  $('#confirm-action').disabled=true; $('#confirm-cancel').disabled=true;
  try { await pendingAction(); $('#confirm-dialog').close(); await refresh(); }
  catch(error) { $('#confirm-error').textContent=error.message; $('#confirm-error').hidden=false; }
  finally { $('#confirm-action').disabled=false; $('#confirm-cancel').disabled=false; }
});
$('#toggle-round').addEventListener('click',()=>{
  const round=report.round;
  confirmAction(round.is_open?'截止這一團？':'重新開放收單？',round.is_open?'同學將無法再送出餐點。已登記的訂單會保留，可以隨時重新開放。':'同學可以繼續登記；已登記的學號仍不能重複送單。',round.is_open?'確認截止':'確認開放',()=>api(`/api/admin/rounds/${round.id}`,{method:'PATCH',body:json({isOpen:!round.is_open})}));
});
$('#orders-content').addEventListener('click',event=>{
  const button=event.target.closest('[data-cancel-order]'); if (!button) return;
  const order=report.orders.find(o=>o.id===Number(button.dataset.cancelOrder));
  confirmAction(`取消 ${order.student_id} 的訂單？`,'此筆餐點將從統計與分裝備註中移除。若本團仍開放，該學號可以重新登記。','確認取消',()=>api(`/api/admin/orders/${order.id}`,{method:'DELETE',body:'{}'}));
});
$('#new-round').addEventListener('click',()=>{ $('#new-round-error').hidden=true; $('#new-round-form').reset(); $('#new-round-dialog').showModal(); });
$('#cancel-new-round').addEventListener('click',()=>$('#new-round-dialog').close());
$('#new-round-form').addEventListener('submit',async event=>{
  event.preventDefault(); const button=event.submitter; button.disabled=true;
  try {
    const round=await api('/api/admin/rounds',{method:'POST',body:json({title:$('#new-round-name').value})});
    selectedRound=round.id; $('#new-round-dialog').close(); await refresh(); toast('新團購已開放，點餐連結維持相同');
  } catch(error) { $('#new-round-error').textContent=error.message; $('#new-round-error').hidden=false; }
  finally { button.disabled=false; }
});
async function loadMenu() {
  menu=await api('/api/admin/menu');
  $('#category-list').innerHTML=[...new Set(menu.map(m=>m.category))].map(c=>`<option value="${e(c)}"></option>`).join('');
  $('#menu-management').innerHTML=`<div class="table-wrap"><table><thead><tr><th>餐點名稱</th><th>分類</th><th>價格</th><th>狀態</th><th>操作</th></tr></thead><tbody>${menu.map(m=>`<tr class="menu-edit-row" data-meal="${m.id}"><td><input data-field="name" aria-label="${e(m.name)}名稱" value="${e(m.name)}" maxlength="60" required></td><td><input data-field="category" aria-label="${e(m.name)}分類" value="${e(m.category)}" list="category-list" maxlength="30" required></td><td><input class="price-input" data-field="price" aria-label="${e(m.name)}價格" type="number" min="1" max="10000" step="1" value="${m.price}" required></td><td><select data-field="enabled" aria-label="${e(m.name)}狀態"><option value="true" ${m.enabled?'selected':''}>上架</option><option value="false" ${!m.enabled?'selected':''}>下架</option></select></td><td><button class="secondary" data-save-meal="${m.id}">儲存</button></td></tr>`).join('')}</tbody></table></div>`;
}
$('#menu-management').addEventListener('click',async event=>{
  const button=event.target.closest('[data-save-meal]'); if (!button) return;
  const row=button.closest('tr'); if ([...row.querySelectorAll('input')].some(input=>!input.reportValidity())) return;
  const fields=Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input=>[input.dataset.field,input.value]));
  button.disabled=true;
  try { await api(`/api/admin/menu/${button.dataset.saveMeal}`,{method:'PUT',body:json({...fields,price:Number(fields.price),enabled:fields.enabled==='true'})}); toast(`${fields.name} 已儲存`); }
  catch(error) { showError(error); }
  finally { button.disabled=false; }
});
$('#new-meal-form').addEventListener('submit',async event=>{
  event.preventDefault(); const button=event.submitter; button.disabled=true;
  try {
    await api('/api/admin/menu',{method:'POST',body:json({name:$('#new-meal-name').value,category:$('#new-meal-category').value,price:Number($('#new-meal-price').value),enabled:true})});
    $('#new-meal-form').reset(); await loadMenu(); toast('已新增餐點');
  } catch(error) { showError(error); }
  finally { button.disabled=false; }
});
setInterval(async()=>{ if (!document.hidden && !$('#dashboard').hidden && !document.querySelector('dialog[open]') && currentTab!=='menu') { try { await refresh(); $('#admin-error').hidden=true; } catch(error) { showError(error); } } },15000);
boot();
