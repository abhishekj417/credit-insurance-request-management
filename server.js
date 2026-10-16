const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.CREDITFLOW_DB || path.join(DATA_DIR, 'creditflow.db');
const PORT = Number(process.env.PORT || 4173);
const AUTH_MODE = process.env.AUTH_MODE || 'entra';
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self'";
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const STATIC_FILES = new Set(['/index.html','/styles.css','/app.js']);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMITS = { read: Number(process.env.RATE_LIMIT_READS || 300), write: Number(process.env.RATE_LIMIT_WRITES || 30) };
const REMINDER_SCAN_INTERVAL_MS = 5 * 60 * 1000;

// Refuse to boot in an unauthenticated configuration outside local development.
if (!['entra','development'].includes(AUTH_MODE)) throw new Error(`Unsupported AUTH_MODE "${AUTH_MODE}". Use "entra" (or "development" for local pilots only).`);
if (AUTH_MODE === 'development' && process.env.NODE_ENV === 'production') throw new Error('AUTH_MODE=development disables authentication and is not allowed when NODE_ENV=production.');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
// Uploaded documents live next to the database (outside the static allowlist) under random file names.
const DOCS_DIR = path.join(path.dirname(DB_PATH), 'documents');
fs.mkdirSync(DOCS_DIR, { recursive: true });
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
  CREATE TABLE IF NOT EXISTS request_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    doc_index INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_request_documents_request ON request_documents(request_id);
`);
// Additive column migrations for databases created by earlier versions.
function addColumnIfMissing(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('requests','return_status','TEXT');

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
function getDocuments(requestId) {
  return db.prepare(`SELECT id,doc_index AS docIndex,original_name AS name,size,uploaded_by AS uploadedBy,uploaded_at AS uploadedAt
    FROM request_documents WHERE request_id=? ORDER BY id`).all(requestId);
}
function getRequestDetail(user, id) {
  const request = mapRequest(accessibleRequest(user, id));
  return { ...request, events:getEvents(id), documents:getDocuments(id) };
}
function cleanFilename(name) {
  let decoded = '';
  try { decoded = decodeURIComponent(String(name || '')); } catch { decoded = ''; }
  const cleaned = decoded.normalize('NFKC').replace(/[^a-zA-Z0-9._ ()-]/g,'_').replace(/^\.+/,'').slice(0,120);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned || 'document'}.pdf`;
}
async function readRaw(req, max) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('Documents must be 10 MB or smaller'),{status:413}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function uploadDocument(req, user, id, docIndexParam) {
  const row = accessibleRequest(user, id);
  const checklist = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='documents'").get().value_json);
  const docIndex = Number(docIndexParam);
  if (!Number.isInteger(docIndex) || docIndex < 0 || docIndex >= checklist.length) throw Object.assign(new Error('Unknown document type'),{status:400});
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/pdf') throw Object.assign(new Error('Only PDF documents are accepted'),{status:415});
  const body = await readRaw(req, MAX_DOCUMENT_BYTES);
  if (body.length < 5 || body.subarray(0,5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('The file is not a valid PDF document'),{status:400});
  const originalName = cleanFilename(req.headers['x-file-name']);
  const storedName = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(DOCS_DIR, storedName), body, { flag:'wx' });
  const result = db.prepare('INSERT INTO request_documents (request_id,doc_index,original_name,stored_name,size,uploaded_by) VALUES (?,?,?,?,?,?)')
    .run(id, docIndex, originalName, storedName, body.length, user.name);
  const docs = parseJson(row.documents_json); docs[docIndex] = true;
  for (let i=0;i<docs.length;i++) docs[i] = Boolean(docs[i]);
  db.prepare('UPDATE requests SET documents_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(docs), id);
  const docName = checklist[docIndex]?.name || 'Document';
  addEvent(id, user.name, 'document', `Uploaded ${originalName} (${docName})`);
  const notice = { eventKey:`document:${id}:${result.lastInsertRowid}`, requestId:id, type:'document', title:'Document uploaded', message:`${id} - ${row.buyer}: ${user.name} uploaded ${docName}.` };
  if (row.requester === user.name) notifyFinance(row, notice);
  else addNotification({ ...notice, user:row.requester });
  return { id:Number(result.lastInsertRowid), docIndex, name:originalName, size:body.length, uploadedBy:user.name };
}
function documentForDownload(user, documentId) {
  const doc = db.prepare('SELECT * FROM request_documents WHERE id=?').get(documentId);
  if (!doc) throw Object.assign(new Error('Document not found'),{status:404});
  try { accessibleRequest(user, doc.request_id); } catch { throw Object.assign(new Error('Document not found'),{status:404}); }
  return doc;
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
    notifyFinance(row,{eventKey,requestId:id,type:'comment',title:`New comment from ${user.name}`,message:`${id} - ${row.buyer}: ${preview}`});
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
// Working days only (Monday-Friday), matching the UAE working week.
function addBusinessDays(from, days) {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) { date.setUTCDate(date.getUTCDate()+1); const day = date.getUTCDay(); if (day !== 0 && day !== 6) remaining--; }
  return date;
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
  // Past the SLA due date of the current stage: remind whoever holds the next action.
  const overdue=db.prepare(`SELECT id,buyer,status,requester,owner,due_date FROM requests
    WHERE status NOT IN ('Approved','Rejected','Closed') AND due_date < date('now')`).all();
  for (const request of overdue) {
    const notice={eventKey:`overdue:${request.id}:${period}`,requestId:request.id,type:'reminder',title:'Request past its due date',message:`${request.id} - ${request.buyer} at ${request.status} was due on ${request.due_date}.`};
    if (needsRequesterAction(request.status)) addNotification({...notice,user:request.requester}); else notifyFinance(request,notice);
  }
  return pending.length + overdue.length;
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
  const today = new Date(); const due = addBusinessDays(today, Math.max(1, Number(statuses[0]?.sla) || 1));
  const request = { id:nextId(), buyer:input.buyer.trim(), country:input.country.trim(), unit:input.unit.trim(), amount:Number(input.amount),
    currency:validText(input.currency,3)?input.currency:'AED', terms:validText(input.terms)?input.terms:'Not specified',
    status:statuses[0]?.name || 'Submitted', owner:'Finance Review Queue', requester:user.name,
    due:due.toISOString().slice(0,10), submitted:today.toISOString().slice(0,10), coface:'—', approved:null,
    note:typeof input.note==='string'?input.note.slice(0,2000):'', docs:[],
    history:[`Request submitted by ${user.name}`] };
  db.prepare(`INSERT INTO requests (id,buyer,country,business_unit,amount,currency,payment_terms,status,owner,requester,due_date,submitted_date,coface_reference,approved_amount,note,documents_json,history_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(request.id,request.buyer,request.country,request.unit,request.amount,request.currency,request.terms,request.status,request.owner,request.requester,request.due,request.submitted,request.coface,request.approved,request.note,JSON.stringify(request.docs),JSON.stringify(request.history));
  addEvent(request.id, user.name, 'created', 'Request submitted for finance review');
  addNotification({eventKey:`created:${request.id}`,role:'Finance Reviewer',requestId:request.id,type:'new_request',title:'New credit insurance request',message:`${request.id} - ${request.buyer} has been submitted for finance review.`});
  return request;
}
function needsRequesterAction(status) { return status.includes('Documents Required') || status.includes('Information Required'); }
function notifyFinance(row, notice) {
  if (row.owner && row.owner !== QUEUE_OWNER) addNotification({ ...notice, user:row.owner });
  else addNotification({ ...notice, role:'Finance Reviewer' });
}
const QUEUE_OWNER = 'Finance Review Queue';
function assignRequest(user, id, input) {
  const row = accessibleRequest(user, id);
  const release = input.release === true;
  if (release) {
    if (row.owner !== user.name && !user.roles.includes('Administrator')) throw Object.assign(new Error('Only the assigned reviewer or an administrator can release this request'),{status:403});
    if (row.owner === QUEUE_OWNER) throw Object.assign(new Error('This request is not assigned'),{status:409});
  } else if (row.owner === user.name) throw Object.assign(new Error('This request is already assigned to you'),{status:409});
  const owner = release ? QUEUE_OWNER : user.name;
  db.prepare('UPDATE requests SET owner=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(owner, id);
  addEvent(id, user.name, 'assignment', release ? `Released ${row.owner === user.name ? 'their assignment' : `from ${row.owner}`} back to the Finance queue` : row.owner === QUEUE_OWNER ? 'Took ownership of the request' : `Took ownership from ${row.owner}`);
  if (!release) addNotification({ eventKey:`assign:${id}:${Date.now()}`, user:row.requester, requestId:id, type:'assignment', title:'Reviewer assigned', message:`${id} - ${row.buyer} is being handled by ${user.name}.` });
  return mapRequest(db.prepare('SELECT * FROM requests WHERE id=?').get(id));
}
function respondToRequest(user, id, input) {
  const row = accessibleRequest(user, id);
  if (row.requester !== user.name) throw Object.assign(new Error('Only the requester can respond to this request'),{status:403});
  if (!needsRequesterAction(row.status)) throw Object.assign(new Error('This request is not waiting for your response'),{status:409});
  const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
  if (comment.length > 2000) throw Object.assign(new Error('Comment must be 2000 characters or fewer'),{status:400});
  if (row.status.includes('Documents Required')) {
    const checklist = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='documents'").get().value_json);
    const received = new Set(getDocuments(id).map(doc=>doc.docIndex));
    const missing = checklist.map((doc,i)=>({...doc,i})).filter(doc=>doc.required && !received.has(doc.i)).map(doc=>doc.name);
    if (missing.length) throw Object.assign(new Error(`Upload the required documents first: ${missing.join(', ')}`),{status:400});
  }
  const statusConfig = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='statuses'").get().value_json);
  const statuses = statusConfig.map(s=>s.name);
  const target = row.return_status && statuses.includes(row.return_status) ? row.return_status : statuses[0];
  const sla = Math.max(1, Number(statusConfig.find(s=>s.name===target)?.sla) || 1);
  if (comment) addEvent(id, user.name, 'comment', comment);
  const history = parseJson(row.history_json); history.unshift(`Requester responded; status changed to ${target}`);
  db.prepare('UPDATE requests SET status=?, history_json=?, return_status=NULL, due_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(target,JSON.stringify(history),addBusinessDays(new Date(), sla).toISOString().slice(0,10),id);
  addEvent(id, user.name, 'status', `Responded and returned to Finance (${row.status} to ${target})`);
  notifyFinance(row, { eventKey:`respond:${id}:${Date.now()}`, requestId:id, type:'requester_response', title:'Requester responded',
    message:`${id} - ${row.buyer} is back with Finance at ${target}.${comment ? ` "${comment.length>100?comment.slice(0,97)+'...':comment}"` : ''}` });
  return mapRequest(db.prepare('SELECT * FROM requests WHERE id=?').get(id));
}
function updateStatus(id, status, user, outcome={}) {
  const statusConfig = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='statuses'").get().value_json);
  const allowed = statusConfig.map(s=>s.name);
  if (!allowed.includes(status)) throw Object.assign(new Error('Unknown workflow status'),{status:400});
  const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('Request not found'),{status:404});
  const hasReference = outcome.cofaceReference !== undefined && outcome.cofaceReference !== null && outcome.cofaceReference !== '';
  if (hasReference && !validText(outcome.cofaceReference, 100)) throw Object.assign(new Error('COFACE reference must be 100 characters or fewer'),{status:400});
  const cofaceReference = hasReference ? outcome.cofaceReference.trim() : row.coface_reference;
  let approvedAmount = row.approved_amount;
  if (status === 'Approved') {
    // A COFACE approval must carry its reference and the amount actually granted.
    approvedAmount = Number(outcome.approvedAmount);
    if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) throw Object.assign(new Error('Enter the approved credit limit to approve this request'),{status:400});
    if (!cofaceReference || cofaceReference === '—') throw Object.assign(new Error('Enter the COFACE reference to approve this request'),{status:400});
  }
  const history = parseJson(row.history_json); history.unshift(`Status changed to ${status}`);
  // Remember where the request came from so the requester's response can return it there.
  const returnStatus = needsRequesterAction(status) && !needsRequesterAction(row.status) ? row.status : row.return_status;
  // Each stage's SLA (working days) sets the new due date; stages with SLA 0 keep the existing date.
  const sla = Number(statusConfig.find(s=>s.name===status)?.sla) || 0;
  const dueDate = sla > 0 ? addBusinessDays(new Date(), sla).toISOString().slice(0,10) : row.due_date;
  db.prepare("UPDATE requests SET status=?, history_json=?, return_status=?, coface_reference=?, approved_amount=?, due_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,JSON.stringify(history),returnStatus,cofaceReference,approvedAmount,dueDate,id);
  const outcomeNote = status === 'Approved' ? ` (COFACE ${cofaceReference}, approved ${row.currency} ${approvedAmount.toLocaleString('en-US')})` : hasReference ? ` (COFACE reference ${cofaceReference})` : '';
  addEvent(id, user.name, 'status', `Status changed from ${row.status} to ${status}${outcomeNote}`);
  const changed=mapRequest(db.prepare('SELECT * FROM requests WHERE id=?').get(id));
  const eventTime=Date.now();
  addNotification({eventKey:`status:${id}:${eventTime}`,user:changed.requester,requestId:id,type:'status_change',title:'Request stage updated',message:`${id} - ${changed.buyer} moved from ${row.status} to ${status}.`});
  if (needsRequesterAction(status)) addNotification({eventKey:`action:${id}:${eventTime}`,user:changed.requester,requestId:id,type:'action_required',title:'Action required',message:`${id} - ${changed.buyer} requires additional information or documents.`});
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
  const uploadMatch=url.pathname.match(/^\/api\/requests\/([^/]+)\/documents$/);
  if (req.method==='POST' && uploadMatch) {
    const id=decodeURIComponent(uploadMatch[1]);
    const uploaded=await uploadDocument(req,user,id,url.searchParams.get('doc'));
    audit(req,user,'document.upload','success',{resourceId:id,details:{documentId:uploaded.id,docIndex:uploaded.docIndex,size:uploaded.size}});
    return send(res,201,uploaded);
  }
  const assignMatch=url.pathname.match(/^\/api\/requests\/([^/]+)\/assign$/);
  if (req.method==='POST' && assignMatch) {
    requireRole(user,['Finance Reviewer','Administrator']);
    const id=decodeURIComponent(assignMatch[1]);
    const changed=assignRequest(user,id,await readBody(req));
    audit(req,user,'request.assign','success',{resourceId:id,details:{owner:changed.owner}});
    return send(res,200,changed);
  }
  const respondMatch=url.pathname.match(/^\/api\/requests\/([^/]+)\/respond$/);
  if (req.method==='POST' && respondMatch) {
    const id=decodeURIComponent(respondMatch[1]);
    const changed=respondToRequest(user,id,await readBody(req));
    audit(req,user,'request.respond','success',{resourceId:id,details:{status:changed.status}});
    return send(res,200,changed);
  }
  const downloadMatch=url.pathname.match(/^\/api\/documents\/(\d+)$/);
  if (req.method==='GET' && downloadMatch) {
    const doc=documentForDownload(user,Number(downloadMatch[1]));
    audit(req,user,'document.download','success',{resourceId:doc.request_id,details:{documentId:doc.id}});
    res.writeHead(200,{ 'Content-Type':'application/pdf', 'Content-Length':String(doc.size), 'Cache-Control':'no-store',
      'Content-Disposition':`attachment; filename="${doc.original_name.replace(/"/g,'')}"`,
      'Content-Security-Policy':"default-src 'none'; sandbox", ...securityHeaders(req) });
    return fs.createReadStream(path.join(DOCS_DIR, doc.stored_name)).pipe(res);
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
    const body=await readBody(req);
    const changed=updateStatus(id,body.status,user,{cofaceReference:body.cofaceReference,approvedAmount:body.approvedAmount});
    audit(req,user,'request.status_change','success',{resourceId:id,details:{status:changed.status,cofaceReference:changed.coface,approvedAmount:changed.approved}});
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
