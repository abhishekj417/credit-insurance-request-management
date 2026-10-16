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
    env:{ ...process.env, AUTH_MODE:'entra', PORT:String(port), CREDITFLOW_DB:path.join(tempDir,'collab.db'), RATE_LIMIT_WRITES:'1000' },
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

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const upload = (id, headers, body, { doc=0, type='application/pdf', name='financials.pdf' }={}) =>
  fetch(`${base}/api/requests/${id}/documents?doc=${doc}`, { method:'POST', headers:{ ...headers, 'Content-Type':type, 'X-File-Name':encodeURIComponent(name) }, body });

test('documents are uploaded, listed and downloadable by people on the request', async () => {
  const created = await newRequest(requesterA,'Document Buyer');
  assert.deepEqual(created.docs,[]);
  const response = await upload(created.id, requesterA, pdf, { doc:1, name:'VAT certificate 2026.pdf' });
  assert.equal(response.status,201);
  const uploaded = await response.json();
  const detail = await (await api(`/api/requests/${created.id}`, reviewer)).json();
  assert.equal(detail.docs[1],true);
  assert.deepEqual(detail.documents.map(d=>[d.docIndex,d.name,d.uploadedBy]),[[1,'VAT certificate 2026.pdf','Requester A']]);
  assert.ok(detail.events.some(e=>e.type==='document' && e.actor==='Requester A'));
  const financeNotices = await (await api('/api/notifications', reviewer)).json();
  assert.ok(financeNotices.some(n=>n.requestId===created.id && n.type==='document'));
  for (const headers of [requesterA, reviewer]) {
    const download = await fetch(`${base}/api/documents/${uploaded.id}`, { headers });
    assert.equal(download.status,200);
    assert.equal(download.headers.get('content-type'),'application/pdf');
    assert.match(download.headers.get('content-disposition'),/^attachment; filename="VAT certificate 2026.pdf"$/);
    assert.match(download.headers.get('content-security-policy'),/sandbox/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf);
  }
  // Finance can add documents too; the requester is notified.
  assert.equal((await upload(created.id, reviewer, pdf, { doc:2 })).status,201);
  const requesterNotices = await (await api('/api/notifications', requesterA)).json();
  assert.ok(requesterNotices.some(n=>n.requestId===created.id && n.type==='document'));
});

test('documents are private to the request', async () => {
  const created = await newRequest(requesterA,'Private Document Buyer');
  const uploaded = await (await upload(created.id, requesterA, pdf)).json();
  assert.equal((await fetch(`${base}/api/documents/${uploaded.id}`, { headers:requesterB })).status,404);
  assert.equal((await fetch(`${base}/api/documents/${uploaded.id}`)).status,401);
  assert.equal((await upload(created.id, requesterB, pdf)).status,404);
  assert.equal((await fetch(`${base}/api/documents/999999`, { headers:reviewer })).status,404);
});

test('rejects unsafe or invalid uploads', async () => {
  const created = await newRequest();
  assert.equal((await upload(created.id, requesterA, Buffer.from('MZ executable'), { type:'application/octet-stream' })).status,415);
  assert.equal((await upload(created.id, requesterA, Buffer.from('<html>not a pdf</html>'))).status,400);
  assert.equal((await upload(created.id, requesterA, Buffer.alloc(10*1024*1024+1, 0x25))).status,413);
  assert.equal((await upload(created.id, requesterA, pdf, { doc:99 })).status,400);
  assert.equal((await upload(created.id, requesterA, pdf, { doc:'abc' })).status,400);
  const detail = await (await api(`/api/requests/${created.id}`, requesterA)).json();
  assert.equal(detail.documents.length,0);
});

test('sanitises uploaded file names', async () => {
  const created = await newRequest();
  const uploaded = await (await upload(created.id, requesterA, pdf, { name:'../../etc/"passwd<script>.exe' })).json();
  assert.doesNotMatch(uploaded.name,/[\/\\"<>]/);
  assert.ok(uploaded.name.endsWith('.pdf'));
  assert.ok(!uploaded.name.startsWith('.'));
});

test('requester answers a documents request and it returns to the stage it came from', async () => {
  const created = await newRequest(requesterA,'Respond Buyer');
  await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Documents Under Review' });
  await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Returned—Documents Required' });
  // Required checklist items (0 and 1) must be uploaded first.
  const blocked = await post(`/api/requests/${created.id}/respond`, requesterA, { comment:'Done' });
  assert.equal(blocked.status,400);
  assert.match((await blocked.json()).error,/Trade \/ commercial licence/);
  await upload(created.id, requesterA, pdf, { doc:0 });
  await upload(created.id, requesterA, pdf, { doc:1 });
  const response = await post(`/api/requests/${created.id}/respond`, requesterA, { comment:'Both documents uploaded.' });
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'Documents Under Review');
  const detail = await (await api(`/api/requests/${created.id}`, reviewer)).json();
  assert.ok(detail.events.some(e=>e.type==='comment' && e.message==='Both documents uploaded.'));
  const notices = await (await api('/api/notifications', reviewer)).json();
  assert.ok(notices.some(n=>n.requestId===created.id && n.type==='requester_response'));
  // It can only be answered once, while it is waiting on the requester.
  assert.equal((await post(`/api/requests/${created.id}/respond`, requesterA, {})).status,409);
});

test('information requests from the COFACE stage return to that stage', async () => {
  const created = await newRequest(requesterA,'COFACE Info Buyer');
  await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Submitted to COFACE' });
  await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Additional Information Required' });
  const response = await post(`/api/requests/${created.id}/respond`, requesterA, { comment:'Buyer has 12 years trading history.' });
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'Submitted to COFACE');
});

test('only the requester can respond', async () => {
  const created = await newRequest(requesterA,'Respond Permissions Buyer');
  await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Additional Information Required' });
  assert.equal((await post(`/api/requests/${created.id}/respond`, requesterB, {})).status,404);
  assert.equal((await post(`/api/requests/${created.id}/respond`, reviewer, {})).status,403);
});

test('approval records the COFACE reference and approved limit', async () => {
  const created = await newRequest(requesterA,'Approval Buyer');
  const noAmount = await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Approved', cofaceReference:'COF-1' });
  assert.equal(noAmount.status,400);
  const noReference = await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Approved', approvedAmount:20000 });
  assert.equal(noReference.status,400);
  // The reference can be captured earlier, when the request is sent to COFACE.
  const submitted = await (await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Submitted to COFACE', cofaceReference:'COF-2026-0099' })).json();
  assert.equal(submitted.coface,'COF-2026-0099');
  const approved = await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Approved', approvedAmount:20000 });
  assert.equal(approved.status,200);
  const body = await approved.json();
  assert.equal(body.approved,20000);
  assert.equal(body.coface,'COF-2026-0099');
  const detail = await (await api(`/api/requests/${created.id}`, requesterA)).json();
  assert.match(detail.events[0].message,/COFACE COF-2026-0099, approved AED 20,000/);
  assert.equal((await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Closed', cofaceReference:'x'.repeat(101) })).status,400);
});

test('finance reviewers take ownership and receive the requester follow-ups', async () => {
  const otherReviewer = as('Second Reviewer', ['Finance Reviewer']);
  const created = await newRequest(requesterA,'Assignment Buyer');
  assert.equal((await post(`/api/requests/${created.id}/assign`, requesterA, {})).status,403);
  const assigned = await post(`/api/requests/${created.id}/assign`, reviewer, {});
  assert.equal(assigned.status,200);
  assert.equal((await assigned.json()).owner,'Finance User');
  assert.equal((await post(`/api/requests/${created.id}/assign`, reviewer, {})).status,409);
  const requesterNotices = await (await api('/api/notifications', requesterA)).json();
  assert.ok(requesterNotices.some(n=>n.requestId===created.id && n.type==='assignment' && /Finance User/.test(n.message)));

  // Follow-ups now go to the assigned reviewer personally, not the whole Finance role.
  await post(`/api/requests/${created.id}/comments`, requesterA, { text:'Question for my reviewer' });
  const mine = await (await api('/api/notifications', reviewer)).json();
  const others = await (await api('/api/notifications', otherReviewer)).json();
  assert.ok(mine.some(n=>n.requestId===created.id && n.type==='comment'));
  assert.ok(!others.some(n=>n.requestId===created.id && n.type==='comment'));

  assert.equal((await post(`/api/requests/${created.id}/assign`, otherReviewer, { release:true })).status,403);
  const released = await post(`/api/requests/${created.id}/assign`, reviewer, { release:true });
  assert.equal((await released.json()).owner,'Finance Review Queue');
  const detail = await (await api(`/api/requests/${created.id}`, admin)).json();
  assert.deepEqual(detail.events.filter(e=>e.type==='assignment').map(e=>e.actor),['Finance User','Finance User']);
});

function expectedDue(days) {
  const date = new Date(); const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  let remaining = days;
  while (remaining > 0) { d.setUTCDate(d.getUTCDate()+1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) remaining--; }
  return d.toISOString().slice(0,10);
}

test('due dates follow the stage SLA in working days', async () => {
  const created = await newRequest(requesterA,'SLA Buyer');
  assert.equal(created.due, expectedDue(1));           // Submitted to Finance: 1 day
  const reviewing = await (await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Documents Under Review' })).json();
  assert.equal(reviewing.due, expectedDue(2));         // 2 days
  const coface = await (await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Submitted to COFACE' })).json();
  assert.equal(coface.due, expectedDue(5));            // 5 days
  const closed = await (await patch(`/api/requests/${created.id}/status`, reviewer, { status:'Closed' })).json();
  assert.equal(closed.due, coface.due);                 // SLA 0 keeps the previous date
  const due = new Date(`${created.due}T00:00:00Z`).getUTCDay();
  assert.ok(due !== 0 && due !== 6);
});
