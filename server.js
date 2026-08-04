const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.CREDITFLOW_DB || path.join(DATA_DIR, 'creditflow.db');
const PORT = Number(process.env.PORT || 4173);
const AUTH_MODE = process.env.AUTH_MODE || 'development';
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self'";

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
function getBootstrap() {
  const output = {};
  for (const row of db.prepare('SELECT section, value_json FROM settings').all()) output[row.section] = parseJson(row.value_json);
  output.requests = db.prepare('SELECT * FROM requests ORDER BY submitted_date DESC, id DESC').all().map(mapRequest);
  return output;
}
function send(res, status, payload, headers={}) {
  const body = payload === null ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers });
  res.end(body);
}
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
  return request;
}
function updateStatus(id, status) {
  const allowed = parseJson(db.prepare("SELECT value_json FROM settings WHERE section='statuses'").get().value_json).map(s=>s.name);
  if (!allowed.includes(status)) throw Object.assign(new Error('Unknown workflow status'),{status:400});
  const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('Request not found'),{status:404});
  const history = parseJson(row.history_json); history.unshift(`Status changed to ${status}`);
  db.prepare("UPDATE requests SET status=?, history_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,JSON.stringify(history),id);
  return mapRequest(db.prepare('SELECT * FROM requests WHERE id=?').get(id));
}

async function api(req,res,url) {
  if (req.method==='GET' && url.pathname==='/api/health') return send(res,200,{status:'ok',database:'connected'});
  const user=getUser(req);
  if (req.method==='GET' && url.pathname==='/api/session') return send(res,200,user);
  if (req.method==='GET' && url.pathname==='/api/bootstrap') return send(res,200,getBootstrap());
  if (req.method==='POST' && url.pathname==='/api/requests') { requireRole(user,['Business Requester','Administrator']); return send(res,201,createRequest(await readBody(req),user)); }
  const statusMatch=url.pathname.match(/^\/api\/requests\/([^/]+)\/status$/);
  if (req.method==='PATCH' && statusMatch) { requireRole(user,['Finance Reviewer','Administrator']); return send(res,200,updateStatus(decodeURIComponent(statusMatch[1]),(await readBody(req)).status)); }
  const configMatch=url.pathname.match(/^\/api\/config\/(statuses|documents|roles|reminders)$/);
  if (req.method==='PUT' && configMatch) {
    requireRole(user,['Administrator']);
    const value=await readBody(req); if(!Array.isArray(value)) throw Object.assign(new Error('Configuration must be an array'),{status:400});
    db.prepare("UPDATE settings SET value_json=?, updated_at=CURRENT_TIMESTAMP WHERE section=?").run(JSON.stringify(value),configMatch[1]);
    return send(res,200,value);
  }
  return send(res,404,{error:'API route not found'});
}
function serveStatic(req,res,url) {
  const pathname = url.pathname==='/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(ROOT, '.' + decodeURIComponent(pathname));
  if (!filePath.startsWith(ROOT + path.sep)) return send(res,403,{error:'Forbidden'});
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res,404,{error:'File not found'});
  const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'}[path.extname(filePath)] || 'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':`default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${FRAME_ANCESTORS}`});
  fs.createReadStream(filePath).pipe(res);
}
const server = http.createServer(async (req,res) => {
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try { if(url.pathname.startsWith('/api/')) await api(req,res,url); else serveStatic(req,res,url); }
  catch(error) { console.error(error); if(!res.headersSent) send(res,error.status||500,{error:error.status?error.message:'Unexpected server error'}); }
});
if (require.main===module) server.listen(PORT,()=>console.log(`Credit insurance request application running at http://localhost:${PORT}`));
module.exports={server,db,getBootstrap};
