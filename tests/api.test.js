const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const port = 4317;
const base = `http://127.0.0.1:${port}`;
const projectRoot = path.resolve(__dirname, '..');
let child;
let tempDir;
let dbPath;

// Simulates the identity headers that Azure App Service Authentication injects in AUTH_MODE=entra.
function as(name, roles) {
  const principal = Buffer.from(JSON.stringify({ claims:[{ typ:'name', val:name }, ...roles.map(val=>({ typ:'roles', val }))] })).toString('base64');
  return { 'x-ms-client-principal':principal, 'x-ms-client-principal-name':name };
}
const admin = as('Admin User', ['Administrator']);
const reviewer = as('Finance User', ['Finance Reviewer']);
const requesterA = as('Requester A', ['Business Requester']);
const requesterB = as('Requester B', ['Business Requester']);
const json = { 'Content-Type':'application/json' };
const api = (pathname, headers={}, options={}) => fetch(`${base}${pathname}`, { ...options, headers:{ ...json, ...headers } });
const createRequest = (headers, buyer) => api('/api/requests', headers, { method:'POST', body:JSON.stringify({ buyer, country:'UAE', unit:'Distribution', amount:5000 }) });

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creditflow-test-'));
  dbPath = path.join(tempDir,'test.db');
  const env = { ...process.env, PORT:String(port), CREDITFLOW_DB:dbPath };
  delete env.AUTH_MODE; // exercise the secure default
  child = spawn(process.execPath, ['server.js'], { cwd:projectRoot, env, stdio:['ignore','pipe','pipe'] });
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
  const response = await api('/api/bootstrap', admin);
  const state = await response.json();
  assert.equal(response.status,200);
  assert.equal(state.requests.length,0);
  assert.ok(state.statuses.some(item=>item.name==='Approved'));
});

test('creates and persists a request', async () => {
  const response = await api('/api/requests', admin, { method:'POST', body:JSON.stringify({
    buyer:'API Test Buyer LLC',country:'United Arab Emirates',unit:'Distribution',amount:100000,currency:'AED',requester:'Test User',docs:[true,true,false]
  })});
  const created = await response.json();
  assert.equal(response.status,201);
  assert.match(created.id,/^CI-\d{4}-\d{3}$/);
  assert.equal(created.requester,'Admin User');
  const state = await (await api('/api/bootstrap', admin)).json();
  assert.ok(state.requests.some(item=>item.id===created.id));
  const notifications = await (await api('/api/notifications', reviewer)).json();
  assert.ok(notifications.some(item=>item.requestId===created.id && item.type==='new_request'));
});

test('updates status and records history', async () => {
  const created = await (await createRequest(requesterA,'Status Test Buyer')).json();
  const id = created.id;
  const response = await api(`/api/requests/${id}/status`, reviewer, { method:'PATCH', body:JSON.stringify({status:'Approved'}) });
  const changed = await response.json();
  assert.equal(response.status,200);
  assert.equal(changed.status,'Approved');
  assert.match(changed.history[0],/Status changed to Approved/);
  const notifications = await (await api('/api/notifications', requesterA)).json();
  const stageNotice = notifications.find(item=>item.requestId===id && item.type==='status_change');
  assert.ok(stageNotice);
  const marked = await api(`/api/notifications/${stageNotice.id}/read`, requesterA, { method:'PATCH', body:'{}' });
  assert.equal(marked.status,200);
});

test('rejects invalid requests and workflow statuses', async () => {
  const badRequest = await api('/api/requests', admin, { method:'POST', body:'{}' });
  assert.equal(badRequest.status,400);
  const state=await (await api('/api/bootstrap', admin)).json();
  const badStatus = await api(`/api/requests/${state.requests[0].id}/status`, admin, { method:'PATCH', body:JSON.stringify({status:'Invented'}) });
  assert.equal(badStatus.status,400);
});

// Finding 71043386 / 65070240: authentication must be required by default.
test('requires authentication by default', async () => {
  for (const pathname of ['/api/bootstrap','/api/session','/api/notifications']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status,401,pathname);
  }
  const write = await fetch(`${base}/api/config/statuses`,{ method:'PUT', headers:json, body:'[]' });
  assert.equal(write.status,401);
});

test('refuses to start in development auth mode when NODE_ENV=production', async () => {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd:projectRoot,
    env:{ ...process.env, AUTH_MODE:'development', NODE_ENV:'production', PORT:'4318', CREDITFLOW_DB:path.join(tempDir,'prod-guard.db') },
    stdio:['ignore','pipe','pipe']
  });
  let stderr=''; proc.stderr.on('data',chunk=>{ stderr+=chunk; });
  const code = await new Promise(resolve=>proc.once('exit',resolve));
  assert.notEqual(code,0);
  assert.match(stderr,/not allowed when NODE_ENV=production/);
});

test('compose and env example do not ship development auth', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(projectRoot,'compose.yaml'),'utf8'),/AUTH_MODE:\s*development/);
  assert.match(fs.readFileSync(path.join(projectRoot,'.env.example'),'utf8'),/^AUTH_MODE=entra$/m);
});

// Finding 31283876: Business Requesters only see their own requests.
test('limits business requesters to their own requests', async () => {
  const mine = await (await createRequest(requesterA,'Requester A Buyer')).json();
  const theirs = await (await createRequest(requesterB,'Requester B Buyer')).json();
  const stateA = await (await api('/api/bootstrap', requesterA)).json();
  assert.ok(stateA.requests.some(item=>item.id===mine.id));
  assert.ok(!stateA.requests.some(item=>item.id===theirs.id));
  assert.ok(stateA.requests.every(item=>item.requester==='Requester A'));
  const stateReviewer = await (await api('/api/bootstrap', reviewer)).json();
  assert.ok(stateReviewer.requests.some(item=>item.id===mine.id));
  assert.ok(stateReviewer.requests.some(item=>item.id===theirs.id));
});

test('enforces role permissions on write endpoints', async () => {
  const state = await (await api('/api/bootstrap', requesterA)).json();
  const status = await api(`/api/requests/${state.requests[0].id}/status`, requesterA, { method:'PATCH', body:JSON.stringify({status:'Approved'}) });
  assert.equal(status.status,403);
  const config = await api('/api/config/statuses', reviewer, { method:'PUT', body:'[]' });
  assert.equal(config.status,403);
});

// Finding 61940090: only the browser bundle is served.
test('static server only serves allowlisted files', async () => {
  for (const pathname of ['/','/index.html','/app.js','/styles.css']) {
    assert.equal((await fetch(`${base}${pathname}`)).status,200,pathname);
  }
  for (const pathname of ['/server.js','/package.json','/.env.example','/compose.yaml','/tests/api.test.js','/Dockerfile','/DEPLOYMENT.md','/data/test.db','/hosted/package.json','/%2e%2e/server.js','/..%2fserver.js']) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status,404,pathname);
    assert.doesNotMatch(await response.text(),/require\(|"scripts"|AUTH_MODE/,pathname);
  }
});

// Finding 70517471: API responses carry security headers.
test('api responses include security headers', async () => {
  for (const response of [await api('/api/bootstrap', admin), await fetch(`${base}/api/bootstrap`)]) {
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }
  const https = await api('/api/bootstrap', { ...admin, 'x-forwarded-proto':'https' });
  assert.match(https.headers.get('strict-transport-security'),/max-age=\d+/);
});

// Finding 73141625: security events and writes are audited.
test('records audit events for writes and denied actions', async () => {
  const created = await (await createRequest(requesterA,'Audit Trail Buyer')).json();
  await api(`/api/requests/${created.id}/status`, requesterA, { method:'PATCH', body:JSON.stringify({status:'Approved'}) });
  await fetch(`${base}/api/bootstrap`);
  const db = new DatabaseSync(dbPath, { readOnly:true });
  try {
    const events = db.prepare('SELECT actor,action,resource_id AS resourceId,outcome FROM audit_events').all();
    assert.ok(events.some(e=>e.action==='request.create' && e.resourceId===created.id && e.actor==='Requester A' && e.outcome==='success'));
    assert.ok(events.some(e=>e.action==='authorization' && e.actor==='Requester A' && e.outcome==='denied'));
    assert.ok(events.some(e=>e.action==='authentication' && e.outcome==='failure'));
    assert.ok(events.some(e=>e.action==='request.status_change' && e.actor==='Finance User'));
  } finally { db.close(); }
});
