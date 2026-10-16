const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.CREDITFLOW_DB || path.join(DATA_DIR, 'creditflow.db');
const PORT = Number(process.env.PORT || 4173);
const AUTH_MODE = process.env.AUTH_MODE || 'entra';
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self'";
const STATIC_FILES = new Set(['/index.html','/styles.css','/app.js']);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { read: Number(process.env.RATE_LIMIT_READS || 300), write: Number(process.env.RATE_LIMIT_WRITES || 30) };
const REMINDER_SCAN_INTERVAL_MS = 5 * 60 * 1000;

// Refuse to boot in an unauthenticated configuration outside local development.
if (!['entra','development'].includes(AUTH_MODE)) throw new Error(`Unsupported AUTH_MODE "${AUTH_MODE}". Use "entra" (or "development" for local pilots only).`);
if (AUTH_MODE === 'development' && process.env.NODE_ENV === 'production') throw new Error('AUTH_MODE=development disables authentication and is not allowed when NODE_ENV=production.');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (
    section TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    buyer TEXT NOT NULL,
    country TEXT NOT NULL,
    business_unit TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    currency TEXT NOT NULL,
    payment_terms TEXT NOT NULL,
    status TEXT NOT NULL,
    owner TEXT NOT NULL,
    requester TEXT NOT NULL,
    due_date TEXT NOT NULL,
    submitted_date TEXT NOT NULL,
    coface_reference TEXT NOT NULL DEFAULT '—',
    approved_amount REAL,
    note TEXT NOT NULL DEFAULT '',
    documents_json TEXT NOT NULL DEFAULT '[]',
    history_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_due_date ON requests(due_date);
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT UNIQUE,
    recipient_user TEXT,
    recipient_role TEXT,
    request_id TEXT,
    notification_type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(recipient_user, read_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_role ON notifications(recipient_role, read_at);
  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor TEXT,
    roles TEXT,
    action TEXT NOT NULL,
    resource_id TEXT,
    outcome TEXT NOT NULL,
    ip TEXT,
    details_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);
  CREATE TABLE IF NOT EXISTS request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id, created_at);
`);

const seed = {
  statuses: [
    { name:'Submitted to Finance', color:'blue', sla:1 },
    { name:'Documents Under Review', color:'orange', sla:2 },
    { name:'Returned—Documents Required', color:'red', sla:3 },
    { name:'Ready for COFACE Submission', color:'teal', sla:1 },
    { name:'Submitted to COFACE', color:'blue', sla:5 },
    { name:'Additional Information Required', color:'orange', sla:3 },
    { name:'Approved', color:'teal', sla:0 }, { name:'Rejected', color:'red', sla:0 }, { name:'Closed', color:'gray', sla:0 }
  ],
  documents: [
    { name:'Trade / commercial licence', required:true },
    { name:'VAT certificate', required:true },
    { name:'Buyer financial information', required:false }
  ],
  roles: [
    { name:'Business requester', access:'Create & view own' }, { name:'Head of Distribution', access:'View business unit' },
    { name:'Credit Insurance POC', access:'Review & manage' }, { name:'Finance stakeholder', access:'View all' },
    { name:'Administrator', access:'Full access' }
  ],
  reminders: [
    { event:'New request not reviewed', after:1, recipient:'Credit Insurance POC' },
    { event:'Documents still outstanding', after:2, recipient:'Business requester' },
    { event:'COFACE response overdue', after:5, recipient:'Credit Insurance POC' },
    { event:'Approval nearing expiry', after:30, recipient:'Business requester' }
  ]
};

const settingInsert = db.prepare('INSERT OR IGNORE INTO settings(section, value_json) VALUES (?, ?)');
for (const [section, value] of Object.entries(seed)) settingInsert.run(section, JSON.stringify(value));
// Remove the original demonstration records and neutralise legacy placeholder identities.
db.prepare("DELETE FROM requests WHERE id IN ('CI-2026-037','CI-2026-038','CI-2026-039','CI-2026-040','CI-2026-041')").run();
db.prepare("UPDATE requests SET owner='Finance Review Queue' WHERE owner IN ('Arun Kumar','Maya Shah','Sara Khan','Omar Ali','Credit Insurance POC')").run();
db.prepare("UPDATE requests SET requester='Business Requester' WHERE requester IN ('Arun Kumar','Maya Shah','Sara Khan','Omar Ali','Current user')").run();

function parseJson(value, fallback=[]) { try { return JSON.parse(value); } catch { return fallback; } }
function mapRequest(row) {
  return { id:row.id, buyer:row.buyer, country:row.country, unit:row.business_unit, amount:row.amount,
    currency:row.currency, terms:row.payment_terms, status:row.status, owner:row.owner, requester:row.requester,
    due:row.due_date, submitted:row.submitted_date, coface:row.coface_reference, approved:row.approved_amount,
    note:row.note, docs:parseJson(row.documents_json), history:parseJson(row.history_json) };
}
function canViewAllRequests(user) { return ['Finance Reviewer','Administrator'].some(role=>user.roles.includes(role)); }
function getBootstrap(user) {
  const output = {};
  for (const row of db.prepare('SELECT section, value_json FROM settings').all()) output[row.section] = parseJson(row.value_json);
  // Business Requesters only see their own submissions; reviewers and administrators see everything.
  output.requests = (canViewAllRequests(user)
    ? db.prepare('SELECT * FROM requests ORDER BY submitted_date DESC, id DESC').all()
    : db.prepare('SELECT * FROM requests WHERE requester=? ORDER BY submitted_date DESC, id DESC').all(user.name)).map(mapRequest);
  output.recentActivity = (canViewAllRequests(user)
    ? db.prepare(`SELECT e.id,e.request_id AS requestId,r.buyer,e.created_at AS createdAt,e.actor,e.event_type AS type,e.message
        FROM request_events e JOIN requests r ON r.id=e.request_id ORDER BY e.id DESC LIMIT 8`).all()
    : db.prepare(`SELECT e.id,e.request_id AS requestId,r.buyer,e.created_at AS createdAt,e.actor,e.event_type AS type,e.message
        FROM request_events e JOIN requests r ON r.id=e.request_id WHERE r.requester=? ORDER BY e.id DESC LIMIT 8`).all(user.name));
  return output;
}
function notFound() { return Object.assign(new Error('Request not found'),{status:404}); }
// Returns the request row only if the caller may see it. Hidden requests look identical to missing ones.
function accessibleRequest(user, id) {
  const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if (!row || (!canViewAllRequests(user) && row.requester !== user.name)) throw notFound();
  return row;
}
function addEvent(requestId, actor, type, message) {
  db.prepare('INSERT INTO request_events (request_id,actor,event_type,message) VALUES (?,?,?,?)').run(requestId, actor, type, message);
}
function getEvents(requestId) {
  return db.prepare(`SELECT id,created_at AS createdAt,actor,event_type AS type,message FROM request_events
    WHERE request_id=? ORDER BY id DESC`).all(requestId);
}
function getRequestDetail(user, id) {
  const request = mapRequest(accessibleRequest(user, id));
  return { ...request, events:getEvents(id) };
}
function addComment(user, id, input) {
  const row = accessibleRequest(user, id);
  if (!validText(input.text, 2000)) throw Object.assign(new Error('Comment must be between 1 and 2000 characters'),{status:400});
  const text = input.text.trim();
  addEvent(id, user.name, 'comment', text);
  db.prepare('UPDATE requests SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
  const eventKey = `comment:${id}:${Date.now()}`;
  const preview = text.length > 140 ? `${text.slice(0,137)}...` : text;
  // Requester comments go to Finance (and the assigned reviewer); Finance comments go to the requester.
  if (row.requester === user.name) {
    addNotification({eventKey,role:'Finance Reviewer',requestId:id,type:'comment',title:`New comment from ${user.name}`,message:`${id} - ${row.buyer}: ${preview}`});
  } else {
    addNotification({eventKey,user:row.requester,requestId:id,type:'comment',title:`New comment from ${user.name}`,message:`${id} - ${row.buyer}: ${preview}`});
  }
  return getEvents(id);
}
function addNotification({eventKey=null,user=null,role=null,requestId=null,type,title,message}) {
  db.prepare(`INSERT OR IGNORE INTO notifications
    (event_key,recipient_user,recipient_role,request_id,notification_type,title,message)
    VALUES (?,?,?,?,?,?,?)`).run(eventKey,user,role,requestId,type,title,message);
}
function getNotifications(user) {
  const roles=user.roles.length ? user.roles : ['__none__'];
  const placeholders=roles.map(()=>'?').join(',');
  return db.prepare(`SELECT id,request_id AS requestId,notification_type AS type,title,message,read_at AS readAt,created_at AS createdAt
    FROM notifications WHERE recipient_user=? OR recipient_role IN (${placeholders}) ORDER BY created_at DESC LIMIT 50`).all(user.name,...roles);
}
function processPendingReminders() {
  const pending=db.prepare(`SELECT id,buyer,status,requester FROM requests
    WHERE status NOT IN ('Approved','Rejected','Closed') AND datetime(updated_at) <= datetime('now','-3 days')`).all();
  const period=new Date().toISOString().slice(0,10);
  for (const request of pending) {
    addNotification({eventKey:`pending:${request.id}:${period}`,role:'Finance Reviewer',requestId:request.id,type:'reminder',
      title:'Request pending for more than 3 days',message:`${request.id} - ${request.buyer} is still at ${request.status}. Review the next required action.`});
    if (request.status.includes('Documents Required') || request.status.includes('Information Required')) addNotification({eventKey:`pending-requester:${request.id}:${period}`,user:request.requester,requestId:request.id,type:'reminder',title:'Your action is pending',message:`${request.id} - ${request.buyer} has been awaiting information for more than 3 days.`});
  }
  return pending.length;
}
let lastReminderScan = 0;
function maybeProcessPendingReminders(now=Date.now()) {
  if (now - lastReminderScan < REMINDER_SCAN_INTERVAL_MS) return null;
  lastReminderScan = now;
  return processPendingReminders();
}
function securityHeaders(req) {
  const headers = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin' };
  // TLS is terminated upstream (App Service / reverse proxy); only advertise HSTS on HTTPS requests.
  if (req && (req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https')) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}
function send(res, status, payload, headers={}) {
  const body = payload === null ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'", ...securityHeaders(res.req), ...headers });
  res.end(body);
}
function clientIp(req) { return req.socket?.remoteAddress || null; }
function audit(req, user, action, outcome, { resourceId=null, details={} }={}) {
  const event = { timestamp:new Date().toISOString(), type:'audit', actor:user?.name || null, roles:user?.roles || [], action,
    resourceId, outcome, ip:clientIp(req), method:req.method, path:req.url, details };
  console.log(JSON.stringify(event));
  try {
    db.prepare('INSERT INTO audit_events (actor,roles,action,resource_id,outcome,ip,details_json) VALUES (?,?,?,?,?,?,?)')
      .run(event.actor, JSON.stringify(event.roles), action, resourceId, outcome, event.ip, JSON.stringify(details));
  } catch (error) { console.error(JSON.stringify({ timestamp:event.timestamp, type:'audit_write_failed', message:error.message })); }
}
const rateBuckets = new Map();
function checkRateLimit(key, kind, now=Date.now()) {
  const bucketKey = `${kind}:${key}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) { bucket = { start:now, count:0 }; rateBuckets.set(bucketKey, bucket); }
  bucket.count++;
  if (bucket.count > RATE_LIMITS[kind]) throw Object.assign(new Error('Too many requests. Please wait a minute and try again.'),
    { status:429, retryAfter:Math.ceil((bucket.start + RATE_LIMIT_WINDOW_MS - now) / 1000) });
}
setInterval(() => { const now=Date.now(); for (const [key,bucket] of rateBuckets) if (now - bucket.start >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key); }, RATE_LIMIT_WINDOW_MS).unref();
function getUser(req) {
  if (AUTH_MODE === 'development') return { name:'Authenticated Employee', roles:['Administrator','Finance Reviewer','Business Requester'] };
  const principal = req.headers['x-ms-client-principal'];
  let claims=[];
  try { claims=principal ? JSON.parse(Buffer.from(principal,'base64').toString('utf8')).claims || [] : []; } catch {}
  const name = req.headers['x-ms-client-principal-name'] || claims.find(c=>['name','preferred_username'].includes(c.typ))?.val;
  if (!name) throw Object.assign(new Error('Corporate sign-in is required'),{status:401});
  const roles=claims.filter(c=>['roles','http://schemas.microsoft.com/ws/2008/06/identity/claims/role'].includes(c.typ)).map(c=>c.val);
  return {name:String(name).slice(0,200),roles};
}
function requireRole(user, allowed) {
  if (!allowed.some(role=>user.roles.includes(role))) throw Object.assign(new Error('You do not have permission to perform this action'),{status:403});
}
async function readBody(req) {
  let body='';
  for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw Object.assign(new Error('Request body too large'),{status:413}); }
  try { return body ? JSON.parse(body) : {}; } catch { throw Object.assign(new Error('Invalid JSON body'),{status:400}); }
}
function validText(value, max=200) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function nextId() {
  const year = new Date().getFullYear();
  const rows = db.prepare('SELECT id FROM requests WHERE id LIKE ?').all(`CI-${year}-%`);
  const max = Math.max(0, ...rows.map(r => Number(r.id.split('-').pop()) || 0));
  return `CI-${year}-${String(max+1).padStart(3,'0')}`;
}
function createRequest(input, user) {
  if (!validText(input.buyer) || !validText(input.country) || !validText(input.unit) || !Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) {
    throw Object.assign(new Error('Buyer, country, business unit and a positive amount are required'),{status:400});
  }
  const statuses = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='statuses'").get().value_json);
  const today = new Date(); const due = new Date(today); due.setDate(due.getDate()+1);
  const request = { id:nextId(), buyer:input.buyer.trim(), country:input.country.trim(), unit:input.unit.trim(), amount:Number(input.amount),
    currency:validText(input.currency,3)?input.currency:'AED', terms:validText(input.terms)?input.terms:'Not specified',
    status:statuses[0]?.name || 'Submitted', owner:'Finance Review Queue', requester:user.name,
    due:due.toISOString().slice(0,10), submitted:today.toISOString().slice(0,10), coface:'—', approved:null,
    note:typeof input.note==='string'?input.note.slice(0,2000):'', docs:Array.isArray(input.docs)?input.docs.map(Boolean):[],
    history:[`Request submitted by ${user.name}`] };
  db.prepare(`INSERT INTO requests (id,buyer,country,business_unit,amount,currency,payment_terms,status,owner,requester,due_date,submitted_date,coface_reference,approved_amount,note,documents_json,history_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(request.id,request.buyer,request.country,request.unit,request.amount,request.currency,request.terms,request.status,request.owner,request.requester,request.due,request.submitted,request.coface,request.approved,request.note,JSON.stringify(request.docs),JSON.stringify(request.history));
  addEvent(request.id, user.name, 'created', 'Request submitted for finance review');
  addNotification({eventKey:`created:${request.id}`,role:'Finance Reviewer',requestId:request.id,type:'new_request',title:'New credit insurance request',message:`${request.id} - ${request.buyer} has been submitted for finance review.`});
  return request;
}
function updateStatus(id, status, user) {
  const allowed = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='statuses'").get().value_json).map(s=>s.name);
  if (!allowed.includes(status)) throw Object.assign(new Error('Unknown workflow status'),{status:400});
  const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('Request not found'),{status:404});
  const history = parseJson(row.history_json); history.unshift(`Status changed to ${status}`);
  db.prepare("UPDATE requests SET status=?, history_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,JSON.stringify(history),id);
  addEvent(id, user.name, 'status', `Status changed from ${row.status} to ${status}`);
  const changed=mapRequest(db.prepare('SELECT * FROM requests WHERE id=?').get(id));
  const eventTime=Date.now();
  addNotification({eventKey:`status:${id}:${eventTime}`,user:changed.requester,requestId:id,type:'status_change',title:'Request stage updated',message:`${id} - ${changed.buyer} moved from ${row.status} to ${status}.`});
  if (status.includes('Documents Required') || status.includes('Information Required')) addNotification({eventKey:`action:${id}:${eventTime}`,user:changed.requester,requestId:id,type:'action_required',title:'Action required',message:`${id} - ${changed.buyer} requires additional information or documents.`});
  return changed;
}

async function api(req,res,url) {
  if (req.method==='GET' && url.pathname==='/api/health') return send(res,200,{status:'ok',database:'connected'});
  const user=getUser(req);
  req.user=user;
  const isWrite=!['GET','HEAD'].includes(req.method);
  checkRateLimit(user.name, isWrite ? 'write' : 'read');
  if (req.method==='GET' && url.pathname==='/api/session') return send(res,200,user);
  if (req.method==='GET' && url.pathname==='/api/notifications') { maybeProcessPendingReminders(); return send(res,200,getNotifications(user)); }
  const notificationMatch=url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (req.method==='PATCH' && notificationMatch) {
    const notification=db.prepare('SELECT recipient_user,recipient_role FROM notifications WHERE id=?').get(Number(notificationMatch[1]));
    if (!notification) throw Object.assign(new Error('Notification not found'),{status:404});
    if (notification.recipient_user!==user.name && !user.roles.includes(notification.recipient_role)) throw Object.assign(new Error('You do not have permission to update this notification'),{status:403});
    db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(notificationMatch[1]));
    audit(req,user,'notification.mark_read','success',{resourceId:notificationMatch[1]});
    return send(res,200,{ok:true});
  }
  if (req.method==='GET' && url.pathname==='/api/bootstrap') return send(res,200,getBootstrap(user));
  const detailMatch=url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (req.method==='GET' && detailMatch) return send(res,200,getRequestDetail(user,decodeURIComponent(detailMatch[1])));
  const commentMatch=url.pathname.match(/^\/api\/requests\/([^/]+)\/comments$/);
  if (req.method==='POST' && commentMatch) {
    const id=decodeURIComponent(commentMatch[1]);
    const events=addComment(user,id,await readBody(req));
    audit(req,user,'request.comment','success',{resourceId:id});
    return send(res,201,events);
  }
  if (req.method==='POST' && url.pathname==='/api/requests') {
    requireRole(user,['Business Requester','Administrator']);
    const created=createRequest(await readBody(req),user);
    audit(req,user,'request.create','success',{resourceId:created.id,details:{amount:created.amount,currency:created.currency}});
    return send(res,201,created);
  }
  const statusMatch=url.pathname.match(/^\/api\/requests\/([^/]+)\/status$/);
  if (req.method==='PATCH' && statusMatch) {
    requireRole(user,['Finance Reviewer','Administrator']);
    const id=decodeURIComponent(statusMatch[1]);
    const changed=updateStatus(id,(await readBody(req)).status,user);
    audit(req,user,'request.status_change','success',{resourceId:id,details:{status:changed.status}});
    return send(res,200,changed);
  }
  const configMatch=url.pathname.match(/^\/api\/config\/(statuses|documents|roles|reminders)$/);
  if (req.method==='PUT' && configMatch) {
    requireRole(user,['Administrator']);
    const value=await readBody(req); if(!Array.isArray(value)) throw Object.assign(new Error('Configuration must be an array'),{status:400});
    db.prepare("UPDATE settings SET value_json=?, updated_at=CURRENT_TIMESTAMP WHERE section=?").run(JSON.stringify(value),configMatch[1]);
    audit(req,user,'config.update','success',{resourceId:configMatch[1],details:{items:value.length}});
    return send(res,200,value);
  }
  return send(res,404,{error:'API route not found'});
}
function serveStatic(req,res,url) {
  // Only the browser bundle is public; server source, config and tests are never served.
  const pathname = url.pathname==='/' ? '/index.html' : url.pathname;
  if (!STATIC_FILES.has(pathname)) return send(res,404,{error:'File not found'});
  const filePath = path.join(ROOT, pathname);
  const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(filePath)];
  res.writeHead(200,{'Content-Type':type,...securityHeaders(req),'Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':`default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${FRAME_ANCESTORS}`});
  fs.createReadStream(filePath).pipe(res);
}
const server = http.createServer(async (req,res) => {
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try { if(url.pathname.startsWith('/api/')) await api(req,res,url); else serveStatic(req,res,url); }
  catch(error) {
    if (error.status===401) audit(req,null,'authentication','failure',{details:{reason:error.message}});
    else if (error.status===403) audit(req,req.user,'authorization','denied',{details:{reason:error.message}});
    else if (error.status===429) audit(req,req.user,'rate_limit','blocked');
    else if (!error.status) console.error(JSON.stringify({timestamp:new Date().toISOString(),type:'error',method:req.method,path:req.url,message:error.message,stack:error.stack}));
    if(!res.headersSent) send(res,error.status||500,{error:error.status?error.message:'Unexpected server error'},error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});
  }
});
if (require.main===module) server.listen(PORT,()=>console.log(JSON.stringify({timestamp:new Date().toISOString(),type:'startup',authMode:AUTH_MODE,port:PORT})));
if (require.main===module) setInterval(processPendingReminders,60*60*1000).unref();
module.exports={server,db,getBootstrap,processPendingReminders,maybeProcessPendingReminders,checkRateLimit};
