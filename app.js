import express from 'express';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from './lib/database.js';
import { BUDGET, cleanText, createOrder, currentRound, fail, reportCsv, roundReport } from './lib/orders.js';

const scryptAsync = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || !stored) return false;
  const [salt, hex] = stored.split(':');
  const hash = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export async function createApp({ dbPath = 'data/orders.sqlite', adminUsername = 'admin', adminPassword = 'admin', secureCookies = false } = {}) {
  if (typeof adminUsername !== 'string' || !adminUsername.trim() || adminUsername.length > 100) throw new Error('ADMIN_USERNAME 請設定為 1–100 個字元');
  if (typeof adminPassword !== 'string' || !adminPassword || adminPassword.length > 256) throw new Error('ADMIN_PASSWORD 請設定為 1–256 個字元');
  adminUsername = adminUsername.trim();
  const db = openDatabase(dbPath);
  const storedHash = db.prepare("SELECT value FROM settings WHERE key='admin_hash'").get()?.value;
  const storedUsername = db.prepare("SELECT value FROM settings WHERE key='admin_username'").get()?.value;
  // Environment configuration is authoritative, including on existing databases.
  // Preserve sessions on ordinary restarts; revoke them when credentials change.
  if (storedUsername !== adminUsername || !await verifyPassword(adminPassword, storedHash)) {
    const hash = await passwordHash(adminPassword);
    transaction(db, () => {
      const set = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      set.run('admin_hash', hash);
      set.run('admin_username', adminUsername);
      db.prepare('DELETE FROM sessions').run();
    });
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['x-requested-with'] !== 'inline-sep' || !req.is('application/json')) return res.status(403).json({ error: '請從本站頁面操作' });
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: '不允許跨網站操作' }); }
        catch { return res.status(403).json({ error: '來源網址不正確' }); }
      }
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const limits = new Map();
  const limiter = (prefix, max, windowMs) => (req, res, next) => {
    const now = Date.now();
    // Bounded retention without a background timer that would keep tests alive.
    if (limits.size > 1000) for (const [key, value] of limits) if (value.reset < now) limits.delete(key);
    if (limits.size > 10000) return res.status(429).json({ error: '目前連線繁忙，請稍後重試' });
    const key = `${prefix}:${req.socket.remoteAddress}`;
    let entry = limits.get(key);
    if (!entry || entry.reset < now) { entry = { count: 0, reset: now + windowMs }; limits.set(key, entry); }
    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: '操作過於頻繁，請稍後重試' });
    }
    next();
  };
  const sessionCookie = { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/', maxAge: 8 * 60 * 60 * 1000 };
  const readToken = req => (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('admin_session='))?.slice(14) ?? '';
  const isAuthenticated = req => {
    const token = readToken(req);
    return /^[a-f0-9]{64}$/.test(token) && Boolean(db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token), Date.now()));
  };
  function startSession(res) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').run(digest(token), Date.now()+sessionCookie.maxAge);
    res.cookie('admin_session', token, sessionCookie);
  }
  app.get('/api/menu', (req, res) => res.json({ budget: BUDGET, round: currentRound(db), menu: db.prepare('SELECT * FROM menu WHERE enabled=1 ORDER BY sort_order,id').all() }));
  app.post('/api/orders', limiter('order', 300, 60000), (req, res) => {
    const result = createOrder(db, req.body);
    res.status(result.replay ? 200 : 201).json(result.order);
  });
  app.get('/api/admin/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }));
  app.post('/api/admin/login', limiter('login', 10, 15*60000), async (req, res) => {
    const stored = db.prepare("SELECT value FROM settings WHERE key='admin_hash'").get()?.value;
    const validPassword = await verifyPassword(req.body?.password, stored);
    if (req.body?.username !== adminUsername || !validPassword) fail(401, '帳號或密碼不正確');
    const old = readToken(req);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(old));
    startSession(res);
    res.json({ ok: true });
  });
  app.use('/api/admin', (req, res, next) => isAuthenticated(req) ? next() : res.status(401).json({ error: '請先登入管理後台' }));
  app.post('/api/admin/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(readToken(req)));
    res.clearCookie('admin_session', { ...sessionCookie, maxAge: undefined });
    res.json({ ok: true });
  });
  app.get('/api/admin/rounds', (req, res) => res.json(db.prepare('SELECT * FROM rounds ORDER BY id DESC').all()));
  app.post('/api/admin/rounds', (req, res) => {
    const title = cleanText(req.body?.title, 80, '團購名稱');
    const id = transaction(db, () => {
      db.prepare('UPDATE rounds SET is_open=0').run();
      return Number(db.prepare('INSERT INTO rounds(title) VALUES(?)').run(title).lastInsertRowid);
    });
    res.status(201).json(db.prepare('SELECT * FROM rounds WHERE id=?').get(id));
  });
  app.patch('/api/admin/rounds/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id !== currentRound(db).id) fail(400, '只有目前團購可以開放或截止收單');
    if (typeof req.body?.isOpen !== 'boolean') fail(400, '收單狀態不正確');
    db.prepare('UPDATE rounds SET is_open=? WHERE id=?').run(Number(req.body.isOpen), id);
    res.json(currentRound(db));
  });
  const reportFor = req => {
    const id = req.query.roundId === undefined ? currentRound(db).id : Number(req.query.roundId);
    if (!Number.isSafeInteger(id)) fail(400, '團購編號不正確');
    return roundReport(db, id);
  };
  app.get('/api/admin/report', (req, res) => res.json(reportFor(req)));
  app.get('/api/admin/export.csv', (req, res) => {
    const report = reportFor(req);
    res.set('Content-Disposition', `attachment; filename="orders-${report.round.id}.csv"`).type('text/csv').send(reportCsv(report));
  });
  app.get('/api/admin/notes.txt', (req, res) => {
    const report = reportFor(req);
    res.set('Content-Disposition', `attachment; filename="split-notes-${report.round.id}.txt"`).type('text/plain').send(report.notes);
  });
  app.delete('/api/admin/orders/:id', (req, res) => {
    const result = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status='active'").run(Number(req.params.id));
    if (!result.changes) fail(404, '找不到有效訂單');
    res.json({ ok: true });
  });
  app.get('/api/admin/menu', (req, res) => res.json(db.prepare('SELECT * FROM menu ORDER BY sort_order,id').all()));
  const validMeal = input => {
    const name = cleanText(input?.name, 60, '餐點名稱');
    const category = cleanText(input?.category, 30, '分類');
    if (!Number.isSafeInteger(input.price) || input.price < 1 || input.price > 10000) fail(400, '價格請輸入 1–10000 的整數');
    if (typeof input.enabled !== 'boolean') fail(400, '上架狀態不正確');
    return [name, category, input.price, Number(input.enabled)];
  };
  app.put('/api/admin/menu/:id', (req, res) => {
    const values = validMeal(req.body);
    if (!db.prepare('UPDATE menu SET name=?,category=?,price=?,enabled=? WHERE id=?').run(...values, Number(req.params.id)).changes) fail(404, '餐點不存在');
    res.json({ ok: true });
  });
  app.post('/api/admin/menu', (req, res) => {
    const values = validMeal(req.body);
    const result = db.prepare('INSERT INTO menu(name,category,price,enabled,sort_order) VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM menu))').run(...values);
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '找不到此功能' }));
  const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
  app.get('/admin', (req, res) => res.sendFile(`${publicDir}/admin.html`));
  app.use(express.static(publicDir, { index: 'index.html', dotfiles: 'deny' }));
  app.use((req, res) => res.status(404).type('text/plain').send('找不到此頁面'));
  app.use((error, req, res, next) => {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: status === 500 ? '服務暫時無法處理，請稍後重試' : error.type === 'entity.parse.failed' ? '資料格式不正確' : error.message });
  });
  return { app, db };
}
