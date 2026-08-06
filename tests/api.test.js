const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 4317;
const base = `http://127.0.0.1:${port}`;
let child;
let tempDir;

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creditflow-test-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT:String(port), CREDITFLOW_DB:path.join(tempDir,'test.db') },
    stdio: ['ignore','pipe','pipe']
  });
  for (let i=0;i<50;i++) {
    try { const response=await fetch(`${base}/api/health`); if(response.ok)return; } catch {}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Test server did not start');
});

test.after(async () => {
  if (child && child.exitCode===null) {
    child.kill();
    await new Promise(resolve=>child.once('exit',resolve));
  }
  if (tempDir) fs.rmSync(tempDir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

test('serves frontend and seeded workspace', async () => {
  const page = await fetch(base);
  assert.equal(page.status,200);
  assert.match(await page.text(),/Credit Insurance/);
  const response = await fetch(`${base}/api/bootstrap`);
  const state = await response.json();
  assert.equal(response.status,200);
  assert.equal(state.requests.length,0);
  assert.ok(state.statuses.some(item=>item.name==='Approved'));
});

test('creates and persists a request', async () => {
  const response = await fetch(`${base}/api/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    buyer:'API Test Buyer LLC',country:'United Arab Emirates',unit:'Distribution',amount:100000,currency:'AED',requester:'Test User',docs:[true,true,false]
  })});
  const created = await response.json();
  assert.equal(response.status,201);
  assert.match(created.id,/^CI-\d{4}-\d{3}$/);
  const state = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.ok(state.requests.some(item=>item.id===created.id));
  const notifications = await (await fetch(`${base}/api/notifications`)).json();
  assert.ok(notifications.some(item=>item.requestId===created.id && item.type==='new_request'));
});

test('updates status and records history', async () => {
  const created = await (await fetch(`${base}/api/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer:'Status Test Buyer',country:'UAE',unit:'Distribution',amount:2000})})).json();
  const id = created.id;
  const response = await fetch(`${base}/api/requests/${id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'Approved'})});
  const changed = await response.json();
  assert.equal(response.status,200);
  assert.equal(changed.status,'Approved');
  assert.match(changed.history[0],/Status changed to Approved/);
  const notifications = await (await fetch(`${base}/api/notifications`)).json();
  const stageNotice = notifications.find(item=>item.requestId===id && item.type==='status_change');
  assert.ok(stageNotice);
  const marked = await fetch(`${base}/api/notifications/${stageNotice.id}/read`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(marked.status,200);
});

test('rejects invalid requests and workflow statuses', async () => {
  const badRequest = await fetch(`${base}/api/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(badRequest.status,400);
  const state=await (await fetch(`${base}/api/bootstrap`)).json();
  const badStatus = await fetch(`${base}/api/requests/${state.requests[0].id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'Invented'})});
  assert.equal(badStatus.status,400);
});
