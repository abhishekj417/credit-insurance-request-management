const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = 4320;
const base = `http://127.0.0.1:${port}`;
const projectRoot = path.resolve(__dirname, '..');
let child;
let tempDir;

function as(name, roles) {
  const principal = Buffer.from(JSON.stringify({ claims:[{ typ:'name', val:name }, ...roles.map(val=>({ typ:'roles', val }))] })).toString('base64');
  return { 'x-ms-client-principal':principal, 'x-ms-client-principal-name':name };
}
const reviewer = as('Finance User', ['Finance Reviewer']);
const admin = as('Admin User', ['Administrator']);
const requesterA = as('Requester A', ['Business Requester']);
const requesterB = as('Requester B', ['Business Requester']);
const json = { 'Content-Type':'application/json' };
const api = (pathname, headers={}, options={}) => fetch(`${base}${pathname}`, { ...options, headers:{ ...json, ...headers, ...(options.headers||{}) } });
const post = (pathname, headers, body) => api(pathname, headers, { method:'POST', body:JSON.stringify(body) });
const patch = (pathname, headers, body) => api(pathname, headers, { method:'PATCH', body:JSON.stringify(body) });
async function newRequest(headers=requesterA, buyer='Collaboration Buyer') {
  const response = await post('/api/requests', headers, { buyer, country:'UAE', unit:'Distribution', amount:25000 });
  assert.equal(response.status,201);
  return response.json();
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creditflow-collab-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd:projectRoot,
    env:{ ...process.env, AUTH_MODE:'entra', PORT:String(port), CREDITFLOW_DB:path.join(tempDir,'collab.db') },
    stdio:['ignore','pipe','pipe']
  });
  for (let i=0;i<50;i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Test server did not start');
});

test.after(async () => {
  if (child && child.exitCode===null) { child.kill(); await new Promise(resolve=>child.once('exit',resolve)); }
  if (tempDir) fs.rmSync(tempDir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});

test('records who did what and when on every request', async () => {
  const created = await newRequest();
  await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Documents Under Review' });
  const detail = await (await api(`/api/requests/${created.id}`, requesterA)).json();
  const [statusEvent, createdEvent] = detail.events;
  assert.equal(createdEvent.type,'created');
  assert.equal(createdEvent.actor,'Requester A');
  assert.equal(statusEvent.type,'status');
  assert.equal(statusEvent.actor,'Finance User');
  assert.match(statusEvent.message,/to Documents Under Review/);
  assert.match(statusEvent.createdAt,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('requester and finance can hold a conversation on a request', async () => {
  const created = await newRequest(requesterA,'Conversation Buyer');
  const question = await post(`/api/requests/${created.id}/comments`, reviewer, { text:'Please share the latest audited financials.' });
  assert.equal(question.status,201);
  const requesterNotices = await (await api('/api/notifications', requesterA)).json();
  assert.ok(requesterNotices.some(n=>n.requestId===created.id && n.type==='comment' && /audited financials/.test(n.message)));

  const answer = await post(`/api/requests/${created.id}/comments`, requesterA, { text:'Uploaded FY2025 accounts.' });
  assert.equal(answer.status,201);
  const financeNotices = await (await api('/api/notifications', reviewer)).json();
  assert.ok(financeNotices.some(n=>n.requestId===created.id && n.type==='comment' && /FY2025/.test(n.message)));

  const detail = await (await api(`/api/requests/${created.id}`, requesterA)).json();
  const comments = detail.events.filter(e=>e.type==='comment');
  assert.deepEqual(comments.map(c=>c.actor),['Requester A','Finance User']);
});

test('other requesters cannot read or comment on a request', async () => {
  const created = await newRequest(requesterA,'Private Buyer');
  assert.equal((await api(`/api/requests/${created.id}`, requesterB)).status,404);
  assert.equal((await post(`/api/requests/${created.id}/comments`, requesterB, { text:'hello' })).status,404);
  assert.equal((await api(`/api/requests/${created.id}`, admin)).status,200);
  const stateB = await (await api('/api/bootstrap', requesterB)).json();
  assert.ok(!stateB.recentActivity.some(e=>e.requestId===created.id));
});

test('validates comments', async () => {
  const created = await newRequest();
  assert.equal((await post(`/api/requests/${created.id}/comments`, requesterA, { text:'' })).status,400);
  assert.equal((await post(`/api/requests/${created.id}/comments`, requesterA, { text:'x'.repeat(2001) })).status,400);
  assert.equal((await post('/api/requests/CI-0000-999/comments', reviewer, { text:'hi' })).status,404);
});

test('dashboard activity shows real events', async () => {
  const created = await newRequest(requesterA,'Activity Buyer');
  const state = await (await api('/api/bootstrap', reviewer)).json();
  const event = state.recentActivity.find(e=>e.requestId===created.id);
  assert.equal(event.actor,'Requester A');
  assert.equal(event.buyer,'Activity Buyer');
});
