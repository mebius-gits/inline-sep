import { createHash } from 'node:crypto';
import { transaction } from './database.js';

export const BUDGET = 150;
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export const currentRound = db => db.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').get();
export function cleanText(value, max, label, allowEmpty = false) {
  if (typeof value !== 'string') fail(400, `${label}格式不正確`);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(400, `${label}請填寫 ${allowEmpty ? '0' : '1'}–${max} 個字，且不可換行`);
  return text;
}
export function getOrder(db, id) {
  const order = db.prepare('SELECT id,round_id,student_id,total,note,status,created_at FROM orders WHERE id=?').get(id);
  return order ? { ...order, items: db.prepare('SELECT menu_id,name,unit_price,quantity FROM order_items WHERE order_id=? ORDER BY id').all(id) } : null;
}

export function createOrder(db, input) {
  if (!input || typeof input !== 'object') fail(400, '訂單格式不正確');
  const studentId = cleanText(input.studentId, 20, '學號').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(studentId)) fail(400, '學號請使用 3–20 位英文字母、數字或連字號');
  const note = cleanText(input.note ?? '', 200, '口味備註', true);
  if (!Number.isSafeInteger(input.roundId) || !Array.isArray(input.items) || !input.items.length || input.items.length > 40) fail(400, '請選擇至少一項餐點');
  if (typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9-]{20,80}$/.test(input.requestKey)) fail(400, '送單識別碼無效，請重新整理');
  const ids = new Set();
  const normalized = input.items.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 || !Number.isSafeInteger(item.unitPrice) || ids.has(item.id)) fail(400, '餐點數量或價格格式不正確');
    ids.add(item.id);
    return { id: item.id, quantity: item.quantity, unitPrice: item.unitPrice };
  }).sort((a,b) => a.id - b.id);
  const hash = createHash('sha256').update(JSON.stringify({ studentId, note, items: normalized, roundId: input.roundId })).digest('hex');
  return transaction(db, () => {
    const existing = db.prepare('SELECT id,payload_hash,status FROM orders WHERE request_key=?').get(input.requestKey);
    if (existing) {
      if (existing.payload_hash !== hash) fail(409, '送單內容已變更，請重新整理後再送出');
      if (existing.status !== 'active') fail(409, '這筆訂單已取消，請重新整理後再訂餐');
      return { order: getOrder(db, existing.id), replay: true };
    }
    const round = currentRound(db);
    if (round.id !== input.roundId) fail(409, '團購已切換，請重新整理後再點餐');
    if (!round.is_open) fail(409, '本團已截止收單');
    if (db.prepare("SELECT id FROM orders WHERE round_id=? AND student_id=? AND status='active'").get(round.id, studentId)) fail(409, '這個學號已登記本團，需修改請聯絡主揪');
    const items = normalized.map(item => {
      const meal = db.prepare('SELECT * FROM menu WHERE id=? AND enabled=1').get(item.id);
      if (!meal) fail(409, '有餐點已下架，請重新整理菜單');
      if (meal.price !== item.unitPrice) fail(409, '餐點價格已更新，請重新整理並確認金額');
      return { ...meal, quantity: item.quantity };
    });
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (total > BUDGET) fail(400, `每人餐點上限 NT$${BUDGET}，目前為 NT$${total}`);
    const result = db.prepare('INSERT INTO orders(round_id,student_id,total,note,request_key,payload_hash) VALUES(?,?,?,?,?,?)').run(round.id, studentId, total, note, input.requestKey, hash);
    const id = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT INTO order_items(order_id,menu_id,name,unit_price,quantity) VALUES(?,?,?,?,?)');
    for (const meal of items) insert.run(id, meal.id, meal.name, meal.price, meal.quantity);
    return { order: getOrder(db, id), replay: false };
  });
}

export function roundReport(db, roundId) {
  const round = db.prepare('SELECT * FROM rounds WHERE id=?').get(roundId);
  if (!round) fail(404, '找不到此團購');
  const orders = db.prepare("SELECT id FROM orders WHERE round_id=? AND status='active' ORDER BY id").all(round.id).map(row => getOrder(db, row.id));
  const summary = db.prepare(`SELECT oi.menu_id,oi.name,oi.unit_price,SUM(oi.quantity) AS quantity,SUM(oi.quantity*oi.unit_price) AS subtotal
    FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.round_id=? AND o.status='active'
    GROUP BY oi.menu_id,oi.name,oi.unit_price ORDER BY oi.menu_id`).all(round.id);
  const total = orders.reduce((sum, o) => sum + o.total, 0);
  const count = orders.length;
  const notes = count ? [
    `【${round.title}｜分裝備註】`,
    `共 ${count} 袋，請依下列學號分開裝袋，袋外標示學號；不同學號請勿混裝。`,
    ...orders.map((o, i) => `${i+1}. 學號 ${o.student_id}：${o.items.map(m => `${m.name} × ${m.quantity}`).join('、')}；${o.note ? `備註：${o.note}` : '調味：照店家一般做法'}`),
  ].join('\n') : '尚無訂單，收單後會自動產生分裝備註。';
  return { round, orders, summary, total, count, notes, quantity: summary.reduce((s,m) => s+m.quantity,0) };
}

export function reportCsv(report) {
  const cell = value => {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const rows = [['團購', '學號', '餐點', '單價', '數量', '小計', '個人合計', '口味備註', '登記時間']];
  for (const o of report.orders) for (const m of o.items) rows.push([report.round.title, `'${o.student_id}`, m.name, m.unit_price, m.quantity, m.unit_price*m.quantity, o.total, o.note, o.created_at]);
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}
