import { $, escapeHtml as e, money, api, toast, requestKey } from './shared.js';
let data, cart = new Map(), seasoning = null, sending = false, key = requestKey(), roundChanged = false;
let saved;
try { saved = JSON.parse(sessionStorage.getItem('order-draft') || 'null'); } catch {}
const total = () => [...cart.values()].reduce((sum, item) => sum + item.price * item.quantity, 0);
const count = () => [...cart.values()].reduce((sum, item) => sum + item.quantity, 0);
const isOpen = () => Boolean(data?.round.is_open) && !roundChanged;
function persist() {
  try { sessionStorage.setItem('order-draft', JSON.stringify({ roundId: data?.round.id, items: [...cart.values()], studentId: $('#student-id').value, seasoning, key })); } catch {}
}
function changed() { key = requestKey(); persist(); $('#submit-error').hidden = true; }
function setQuantity(id, quantity) {
  if (sending || !isOpen()) return;
  const item = data.menu.find(m => m.id === id);
  if (!item) return;
  const existing = cart.get(id)?.quantity || 0;
  if (quantity > 20) return toast('單一餐點最多 20 份');
  if (total() + (quantity - existing) * item.price > data.budget) return toast(`每人上限 ${money(data.budget)}，還可以點 ${money(data.budget-total())}`);
  if (quantity <= 0) cart.delete(id); else cart.set(id, { ...item, quantity });
  changed(); renderCart();
}
function renderMenu() {
  const categories = [...new Set(data.menu.map(m => m.category))];
  $('#category-nav').innerHTML = categories.map((c, i) => `<a href="#category-${i}" class="${i===0?'active':''}">${e(c)}</a>`).join('') + '<a href="#seasoning">調味料勾選</a>';
  $('#menu-sections').innerHTML = categories.map((category, index) => `<section class="menu-category" id="category-${index}"><div class="section-heading"><h2>${e(category)}</h2><span>${data.menu.filter(m=>m.category===category).length} 項餐點</span></div><div class="menu-grid">${data.menu.filter(m=>m.category===category).map(m => `<article class="meal-card" data-id="${m.id}"><div class="meal-info"><h3>${e(m.name)}</h3><span class="meal-price">${money(m.price)}</span></div>${m.image?`<img width="88" height="88" class="meal-image" src="${e(m.image)}" alt="${e(m.name)}" loading="lazy">`:''}<div class="meal-bottom"><span class="selected-label" data-selected="${m.id}"></span><div class="meal-controls"><button class="quantity-button minus" data-minus="${m.id}" aria-label="減少${e(m.name)}" hidden>−</button><button class="quantity-button plus" data-add="${m.id}" aria-label="加入${e(m.name)}">+</button></div></div></article>`).join('')}</div></section>`).join('') + '<section class="menu-category" id="seasoning"><div class="section-heading"><h2>調味料勾選</h2></div><div class="menu-grid"><button class="seasoning-card" id="open-seasoning" type="button" aria-haspopup="dialog"><span class="seasoning-card-title">調味料勾選</span><span class="seasoning-card-selection" id="seasoning-card-selection"></span><span class="seasoning-card-price"><span class="seasoning-card-plus" aria-hidden="true">+</span> TWD 0</span></button></div></section>';
  $('#menu-sections').setAttribute('aria-busy', 'false');
  $('#open-seasoning').addEventListener('click', openSeasoning);
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      document.querySelectorAll('.category-nav a').forEach(a => a.classList.toggle('active', a.hash === `#${entry.target.id}`));
    }
  }, { rootMargin: '-90px 0px -65% 0px', threshold: 0 });
  document.querySelectorAll('.menu-category').forEach(section => observer.observe(section));
}
function renderCart() {
  const amount = total(), quantity = count();
  $('#cart-count').textContent = quantity; $('#mobile-count').textContent = quantity;
  $('#cart-total').textContent = money(amount); $('#mobile-total').textContent = money(amount);
  $('#budget-progress').value = amount;
  $('#budget-remaining').textContent = amount === data.budget ? '剛剛好！已達本次餐點上限' : `還可以點 ${money(data.budget-amount)}`;
  $('#cart-items').innerHTML = cart.size ? [...cart.values()].map(m => `<div class="cart-item"><div><strong>${e(m.name)}</strong><span>${money(m.price)}</span></div><div class="cart-stepper"><button type="button" data-minus="${m.id}" aria-label="購物車減少${e(m.name)}" ${sending?'disabled':''}>−</button><span>${m.quantity}</span><button type="button" data-add="${m.id}" aria-label="購物車加入${e(m.name)}" ${sending || amount+m.price>data.budget?'disabled':''}>+</button></div></div>`).join('') : '<div class="empty-cart"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M15 16v-3a9 9 0 0 1 18 0v3M9 16h30l3 27H6l3-27Z"/><path d="M19 28h10"/></svg><strong>想吃什麼呢？</strong><p>點選餐點旁的 ＋ 加入清單</p></div>';
  $('#submit-order').disabled = sending || !cart.size || !isOpen();
  $('#submit-order').textContent = sending ? '正在送出…' : roundChanged ? '團購已更新，請重新整理' : !isOpen() ? '本團已截止收單' : `確認送出 · ${money(amount)}`;
  $('#open-cart').disabled = sending || !cart.size || !isOpen();
  $('#checkout-label').textContent = roundChanged ? '團購已更新，請重新整理' : !isOpen() ? '本團已截止收單' : '送出餐點';
  $('#student-id').disabled = sending;
  const seasoningText = seasoning ? [seasoning.garlic, seasoning.spice].filter(Boolean).join('、') : '';
  $('#seasoning-card-selection').textContent = seasoning ? seasoningText || '已選・照店家一般做法' : '';
  $('#open-seasoning').classList.toggle('selected', Boolean(seasoning));
  for (const id of ['#open-seasoning', '#save-seasoning']) $(id).disabled = sending || !isOpen();
  document.querySelectorAll('.meal-card').forEach(card => {
    const id = Number(card.dataset.id), item = data.menu.find(m=>m.id===id), n = cart.get(id)?.quantity || 0;
    card.classList.toggle('selected', n>0);
    card.querySelector('[data-selected]').textContent = n ? `已選 ${n} 份` : '';
    card.querySelector('[data-minus]').hidden = !n;
    card.querySelector('[data-minus]').disabled = sending || !isOpen();
    card.querySelector('[data-add]').disabled = sending || !isOpen() || amount+item.price>data.budget;
  });
  $('#round-status').textContent = roundChanged ? '團購已更新' : isOpen() ? '開放登記中' : '已截止收單';
  $('#round-status').classList.toggle('closed', !isOpen());
}
function openCart() {
  if (!sending && cart.size && isOpen() && !$('#cart-dialog').open) $('#cart-dialog').showModal();
}
function openSeasoning() {
  if (sending || !isOpen()) return;
  for (const input of document.querySelectorAll('#seasoning-form input')) input.checked = seasoning?.[input.name] === input.value;
  $('#save-seasoning').textContent = seasoning ? '更新調味料' : '加入購物車';
  $('#seasoning-dialog').showModal();
}
$('#close-seasoning').addEventListener('click', () => $('#seasoning-dialog').close());
$('#seasoning-dialog').addEventListener('click', event => { if (event.target === $('#seasoning-dialog')) $('#seasoning-dialog').close(); });
$('#seasoning-form').addEventListener('change', event => {
  const selected = event.target;
  if (selected.checked) for (const input of document.querySelectorAll('#seasoning-form input')) if (input.name === selected.name && input !== selected) input.checked = false;
});
$('#seasoning-form').addEventListener('submit', event => {
  event.preventDefault();
  if (sending || !isOpen()) return;
  const fields = new FormData(event.currentTarget);
  seasoning = { garlic: fields.get('garlic') || '', spice: fields.get('spice') || '' };
  changed(); renderCart(); $('#seasoning-dialog').close();
});
$('#open-cart').addEventListener('click', openCart);
$('#close-cart').addEventListener('click', () => $('#cart-dialog').close());
$('#cart-dialog').addEventListener('click', event => { if (event.target === $('#cart-dialog')) $('#cart-dialog').close(); });
document.addEventListener('click', event => {
  const add = event.target.closest('[data-add]'), minus = event.target.closest('[data-minus]');
  if (add) { const id=Number(add.dataset.add); setQuantity(id, (cart.get(id)?.quantity||0)+1); }
  if (minus) { const id=Number(minus.dataset.minus); setQuantity(id, (cart.get(id)?.quantity||0)-1); }
});
$('#student-id').addEventListener('input', changed);
$('#close-receipt').addEventListener('click', () => $('#receipt-dialog').close());
$('#order-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || !cart.size || !isOpen()) return;
  const payload = { roundId: data.round.id, studentId: $('#student-id').value.trim(), seasoning, requestKey: key, items: [...cart.values()].map(m => ({ id: m.id, quantity: m.quantity, unitPrice: m.price })) };
  sending = true; renderCart(); $('#submit-error').hidden = true;
  try {
    const order = await api('/api/orders', { method:'POST', body:JSON.stringify(payload) });
    if ($('#cart-dialog').open) $('#cart-dialog').close();
    $('#receipt-content').innerHTML = `<div class="receipt-student"><span>學號</span><strong>${e(order.student_id)}</strong></div>${order.items.map(m=>`<div class="receipt-line"><span>${e(m.name)} × ${m.quantity}</span><span>${money(m.unit_price*m.quantity)}</span></div>`).join('')}<div class="receipt-line receipt-total"><strong>餐點合計</strong><strong>${money(order.total)}</strong></div>${order.note?`<p class="receipt-note">調味料：${e(order.note)}</p>`:''}`;
    $('#receipt-dialog').showModal();
    cart.clear(); seasoning=null; key=requestKey(); $('#order-form').reset();
    try { sessionStorage.removeItem('order-draft'); } catch {}
  } catch(error) { $('#submit-error').textContent=error.message; $('#submit-error').hidden=false; }
  finally { sending=false; renderCart(); }
});
async function init() {
  try {
    data = await api('/api/menu');
    $('#round-title').textContent=data.round.title;
    if (saved?.roundId===data.round.id) {
      $('#student-id').value=typeof saved.studentId==='string'?saved.studentId:'';
      let restored=!saved.note;
      if (saved.seasoning && ['', '加大蒜', '不加大蒜'].includes(saved.seasoning.garlic) && ['', '加辣', '辣包'].includes(saved.seasoning.spice)) seasoning = { garlic: saved.seasoning.garlic, spice: saved.seasoning.spice };
      else if (saved.seasoning) restored=false;
      for (const item of Array.isArray(saved.items)?saved.items:[]) {
        const meal=data.menu.find(m=>m.id===item.id);
        if (meal && meal.price===item.price && Number.isInteger(item.quantity) && item.quantity>0 && item.quantity<=20 && total()+meal.price*item.quantity<=data.budget) cart.set(meal.id,{...meal,quantity:item.quantity}); else restored=false;
      }
      if (restored && typeof saved.key==='string') key=saved.key;
      if (!restored) toast('菜單已更新，部分已選餐點已移除，請重新確認');
    }
    renderMenu(); renderCart();
    setInterval(async () => {
      if (document.hidden || sending) return;
      try { const fresh=await api('/api/menu'); roundChanged=fresh.round.id!==data.round.id; if (!roundChanged) data.round=fresh.round; renderCart(); } catch { /* Submission still performs authoritative checks. */ }
    },30000);
  } catch(error) { $('#load-error').textContent=`${error.message} 請重新整理此頁。`; $('#load-error').hidden=false; $('#menu-sections').textContent='菜單暫時無法載入'; }
}
init();
