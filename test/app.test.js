import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createApp } from '../app.js';

test('Node + SQLite ordering workflow, boundaries, privacy, and persistence', async t => {
  const dir=await mkdtemp(join(tmpdir(),'inline-sep-test-'));
  const dbPath=join(dir,'test.sqlite');
  const password='test-only-password-1234';
  let fixture=await createApp({dbPath,adminPassword:password});
  let server=fixture.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  let base=`http://127.0.0.1:${server.address().port}`;
  let cookie;
  const call=async(path,{method='GET',body,admin=false,headers={}}={})=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Requested-With':'inline-sep',...(admin&&cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text(); let data; try { data=JSON.parse(text); } catch { data=text; }
    return {status:response.status,data,headers:response.headers};
  };
  let roundId, firstOrder;
  const payload=(studentId='B11200001',items=[{id:127962,quantity:2,unitPrice:75}],extra={})=>({studentId,items,note:'小辣、不加蒜',roundId,requestKey:randomUUID(),...extra});
  try {
    await t.test('supplied menu has all 39 meals and the correct prices',async()=>{
      const result=await call('/api/menu'); assert.equal(result.status,200); assert.equal(result.data.menu.length,39); assert.equal(result.data.budget,150);
      assert.equal(result.data.menu.find(m=>m.id===127966).price,99); assert.equal(result.data.menu.find(m=>m.id===127971).price,42);
      roundId=result.data.round.id;
      assert.equal('orders' in result.data,false);
    });
    await t.test('admin details and exports require authentication; cross-site mutations rejected',async()=>{
      for (const path of ['/api/admin/report','/api/admin/export.csv','/api/admin/notes.txt','/api/admin/menu']) assert.equal((await call(path)).status,401);
      assert.equal((await call('/api/admin/login',{method:'POST',body:{password},headers:{Origin:'https://example.invalid'}})).status,403);
      assert.equal((await call('/api/orders',{method:'POST',body:payload(),headers:{'X-Requested-With':''}})).status,403);
      // Node fetch rewrites Host; use raw HTTP to test DNS-rebinding protection.
      const status=await new Promise((resolve,reject)=>{
        const req=request(base+'/api/admin/setup',{method:'POST',headers:{Host:'public.example','Content-Type':'application/json','X-Requested-With':'inline-sep'}},res=>{res.resume();resolve(res.statusCode);});
        req.on('error',reject);req.end(JSON.stringify({password}));
      });
      assert.equal(status,403);
    });
    await t.test('exactly NT$150 is accepted, idempotent retry returns the original order',async()=>{
      const body=payload(); const result=await call('/api/orders',{method:'POST',body}); assert.equal(result.status,201); assert.equal(result.data.total,150);
      firstOrder=result.data;
      const retry=await call('/api/orders',{method:'POST',body}); assert.equal(retry.status,200); assert.equal(retry.data.id,firstOrder.id);
      assert.equal((await call('/api/orders',{method:'POST',body:{...body,note:'不同內容'}})).status,409);
    });
    await t.test('rejects over-budget orders, forged prices, duplicate items, invalid quantities, and duplicate student IDs',async()=>{
      assert.equal((await call('/api/orders',{method:'POST',body:payload('b11200001')})).status,409);
      const over=payload('B11200002',[{id:127966,quantity:1,unitPrice:99},{id:127978,quantity:1,unitPrice:33},{id:127979,quantity:1,unitPrice:20}]);
      assert.equal((await call('/api/orders',{method:'POST',body:over})).status,400);
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200002',[{id:127962,quantity:2,unitPrice:1}])})).status,409);
      for (const quantity of [0,-1,1.5,'2',21]) assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200002',[{id:127962,quantity,unitPrice:75}])})).status,400);
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200002',[{id:127962,quantity:1,unitPrice:75},{id:127962,quantity:1,unitPrice:75}])})).status,400);
      assert.equal((await call('/api/orders',{method:'POST',body:payload('<script>')})).status,400);
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200002',[],{})})).status,400);
    });
    await t.test('simultaneous requests from the same student create just one record',async()=>{
      const responses=await Promise.all(Array.from({length:8},()=>call('/api/orders',{method:'POST',body:payload('B11200002',[{id:127968,quantity:1,unitPrice:45}])})));
      assert.equal(responses.filter(r=>r.status===201).length,1); assert.equal(responses.filter(r=>r.status===409).length,7);
    });
    await t.test('authenticated reports, notes and CSV contain accurate totals and preserve student IDs',async()=>{
      assert.equal((await call('/api/admin/login',{method:'POST',body:{password:'wrong'}})).status,401);
      const login=await call('/api/admin/login',{method:'POST',body:{password}}); assert.equal(login.status,200);
      const setCookie=login.headers.get('set-cookie'); assert.match(setCookie,/HttpOnly/); assert.match(setCookie,/SameSite=Strict/); cookie=setCookie.split(';')[0];
      const result=await call(`/api/admin/report?roundId=${roundId}`,{admin:true}); assert.equal(result.data.count,2); assert.equal(result.data.total,195); assert.equal(result.data.quantity,3);
      assert.match(result.data.notes,/學號 B11200001：鹽酥雞 × 2/); assert.match(result.data.notes,/小辣、不加蒜/); assert.match(result.data.notes,/不同學號請勿混裝/);
      const csv=await call('/api/admin/export.csv',{admin:true}); assert.equal(csv.status,200); assert.match(csv.data,/'B11200001/);
      assert.equal((await call('/api/admin/report?roundId=nope',{admin:true})).status,400);
    });
    await t.test('menu edits preserve historical snapshots and prevent stale-price submissions',async()=>{
      assert.equal((await call('/api/admin/menu/127962',{method:'PUT',admin:true,body:{name:'鹽酥雞（新價格）',category:'鹽酥雞類',price:80,enabled:true}})).status,200);
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200003',[{id:127962,quantity:1,unitPrice:75}])})).status,409);
      const report=await call('/api/admin/report',{admin:true}); assert.equal(report.data.orders[0].items[0].name,'鹽酥雞'); assert.equal(report.data.orders[0].total,150);
      await call('/api/admin/menu/127968',{method:'PUT',admin:true,body:{name:'甜不辣',category:'鹽酥雞類',price:45,enabled:false}});
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200003',[{id:127968,quantity:1,unitPrice:45}])})).status,409);
    });
    await t.test('closing, cancelling, reopening and new rounds preserve history',async()=>{
      await call(`/api/admin/rounds/${roundId}`,{method:'PATCH',admin:true,body:{isOpen:false}});
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200003',[{id:127969,quantity:1,unitPrice:30}])})).status,409);
      await call(`/api/admin/orders/${firstOrder.id}`,{method:'DELETE',admin:true,body:{}});
      assert.equal((await call('/api/admin/report',{admin:true})).data.total,45);
      await call(`/api/admin/rounds/${roundId}`,{method:'PATCH',admin:true,body:{isOpen:true}});
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200001',[{id:127969,quantity:1,unitPrice:30}])})).status,201);
      const next=await call('/api/admin/rounds',{method:'POST',admin:true,body:{title:'第二團'}}); assert.equal(next.status,201);
      assert.equal((await call('/api/admin/report',{admin:true})).data.count,0);
      assert.equal((await call(`/api/admin/report?roundId=${roundId}`,{admin:true})).data.total,75);
      assert.equal((await call('/api/orders',{method:'POST',body:payload('B11200004')})).status,409);
      assert.equal((await call(`/api/admin/rounds/${roundId}`,{method:'PATCH',admin:true,body:{isOpen:true}})).status,400);
    });
    await t.test('SQLite survives process restart with menu changes, orders, password and session intact',async()=>{
      await new Promise(resolve=>server.close(resolve)); fixture.db.close();
      fixture=await createApp({dbPath}); server=fixture.app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); base=`http://127.0.0.1:${server.address().port}`;
      assert.equal((await call('/api/menu')).data.menu.find(m=>m.id===127962).price,80);
      assert.equal((await call(`/api/admin/report?roundId=${roundId}`,{admin:true})).data.total,75);
      await call('/api/admin/logout',{method:'POST',admin:true,body:{}});
      assert.equal((await call('/api/admin/report',{admin:true})).status,401);
    });
  } finally { await new Promise(resolve=>server.close(resolve)); fixture.db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('first-run password setup requires local access and can only happen once',async()=>{
  const {app,db}=await createApp({dbPath:':memory:'}); const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(password,headers={})=>fetch(base+'/api/admin/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'inline-sep',...headers},body:JSON.stringify({password})});
  try {
    assert.equal((await post('short')).status,400);
    assert.equal((await post('long-enough-password',{'X-Forwarded-For':'203.0.113.4'})).status,403);
    assert.equal((await post('long-enough-password')).status,201);
    assert.equal((await post('different-password-long')).status,409);
    const stored=db.prepare("SELECT value FROM settings WHERE key='admin_hash'").get().value; assert.ok(!stored.includes('long-enough-password'));
  } finally { await new Promise(resolve=>server.close(resolve)); db.close(); }
});
