const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creditflow-security-'));
test.after(() => fs.rmSync(tempDir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));

function as(name, roles) {
  const principal = Buffer.from(JSON.stringify({ claims:[{ typ:'name', val:name }, ...roles.map(val=>({ typ:'roles', val }))] })).toString('base64');
  return { 'x-ms-client-principal':principal, 'x-ms-client-principal-name':name, 'Content-Type':'application/json' };
}

// Finding 67692507: write endpoints are rate limited per user.
test('rate limits write endpoints per user', async () => {
  const port = 4319;
  const child = spawn(process.execPath, ['server.js'], {
    cwd:projectRoot,
    env:{ ...process.env, AUTH_MODE:'entra', PORT:String(port), CREDITFLOW_DB:path.join(tempDir,'rate.db'), RATE_LIMIT_WRITES:'3', RATE_LIMIT_READS:'5' },
    stdio:['ignore','pipe','pipe']
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i=0;i<50;i++) { try { if((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,50)); }
    const flooder = as('Flood User',['Business Requester']);
    const body = JSON.stringify({ buyer:'Flood Buyer', country:'UAE', unit:'Distribution', amount:100 });
    const statuses = [];
    for (let i=0;i<4;i++) statuses.push((await fetch(`${base}/api/requests`,{ method:'POST', headers:flooder, body })).status);
    assert.deepEqual(statuses,[201,201,201,429]);
    const limited = await fetch(`${base}/api/requests`,{ method:'POST', headers:flooder, body });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    // Limits are per user, so another user is unaffected.
    assert.equal((await fetch(`${base}/api/requests`,{ method:'POST', headers:as('Other User',['Business Requester']), body })).status,201);
    const reads = [];
    for (let i=0;i<6;i++) reads.push((await fetch(`${base}/api/bootstrap`,{ headers:flooder })).status);
    assert.equal(reads.at(-1),429);
  } finally {
    child.kill();
    await new Promise(resolve=>child.once('exit',resolve));
  }
});

test('throttles reminder scans triggered from the notifications endpoint', () => {
  process.env.CREDITFLOW_DB = path.join(tempDir,'reminders.db');
  process.env.AUTH_MODE = 'entra';
  const { maybeProcessPendingReminders, processPendingReminders, db } = require('../server.js');
  try {
    const now = Date.now();
    assert.equal(typeof maybeProcessPendingReminders(now),'number');
    assert.equal(maybeProcessPendingReminders(now + 1000),null);
    assert.equal(maybeProcessPendingReminders(now + 60 * 1000),null);
    assert.equal(typeof maybeProcessPendingReminders(now + 6 * 60 * 1000),'number');

    // Requests past their SLA due date remind whoever holds the next action.
    const insert = db.prepare(`INSERT INTO requests (id,buyer,country,business_unit,amount,currency,payment_terms,status,owner,requester,due_date,submitted_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,date('now','-2 days'),date('now','-5 days'))`);
    insert.run('CI-2026-901','Overdue Finance','UAE','Distribution',1000,'AED','30 days','Documents Under Review','Finance User','Requester A');
    insert.run('CI-2026-902','Overdue Requester','UAE','Distribution',1000,'AED','30 days','Returned—Documents Required','Finance Review Queue','Requester A');
    processPendingReminders();
    const reminders = db.prepare("SELECT request_id AS requestId, recipient_user AS user, recipient_role AS role FROM notifications WHERE event_key LIKE 'overdue:%'").all().map(r=>({...r}));
    assert.deepEqual(reminders.find(r=>r.requestId==='CI-2026-901'),{ requestId:'CI-2026-901', user:'Finance User', role:null });
    assert.deepEqual(reminders.find(r=>r.requestId==='CI-2026-902'),{ requestId:'CI-2026-902', user:'Requester A', role:null });
  } finally { db.close(); }
});

// Finding 63532716: server-sourced values are escaped before being placed in innerHTML.
function loadFrontend() {
  const element = () => ({ innerHTML:'', textContent:'', hidden:false, append(){}, remove(){}, classList:{ add(){}, remove(){}, toggle(){} } });
  const context = vm.createContext({
    document:{ querySelector:element, querySelectorAll:()=>[], addEventListener(){}, createElement:element },
    fetch:()=>Promise.reject(new Error('offline')), setTimeout, Intl, Date, console
  });
  vm.runInContext(fs.readFileSync(path.join(projectRoot,'app.js'),'utf8'), context);
  return context;
}

test('escapes markup in rendered request data', () => {
  const app = loadFrontend();
  assert.equal(app.esc(`<img src=x onerror="alert(1)">&'`),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
  const payload = '<img src=x onerror=alert(1)><b>forged</b>';
  const html = app.requestTable([{ id:'CI-2026-001"><script>', buyer:payload, unit:payload, status:payload, owner:payload,
    amount:1000, currency:'AED', due:'2099-01-01', history:[payload] }]);
  assert.doesNotMatch(html,/<img|<b>|<script>/);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;&lt;b&gt;forged&lt;\/b&gt;/);
  assert.match(html,/data-request="CI-2026-001&quot;&gt;&lt;script&gt;"/);
});

test('does not interpolate raw server values into innerHTML templates', () => {
  const source = fs.readFileSync(path.join(projectRoot,'app.js'),'utf8');
  const raw = source.match(/\$\{(?:r|n|d|s|h|role)\.(?:buyer|note|owner|requester|terms|coface|country|unit|title|message|name|event|status|id)\}/g);
  assert.equal(raw,null,`Unescaped interpolations: ${raw}`);
});
