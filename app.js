const DEFAULTS = {
  statuses: [
    { name: "Submitted to Finance", color: "blue", sla: 1 },
    { name: "Documents Under Review", color: "orange", sla: 2 },
    { name: "Returned—Documents Required", color: "red", sla: 3 },
    { name: "Ready for COFACE Submission", color: "teal", sla: 1 },
    { name: "Submitted to COFACE", color: "blue", sla: 5 },
    { name: "Additional Information Required", color: "orange", sla: 3 },
    { name: "Approved", color: "teal", sla: 0 },
    { name: "Rejected", color: "red", sla: 0 },
    { name: "Closed", color: "gray", sla: 0 }
  ],
  documents: [
    { name: "Trade / commercial licence", required: true },
    { name: "VAT certificate", required: true },
    { name: "Buyer financial information", required: false }
  ],
  roles: [
    { name: "Business requester", access: "Create & view own" },
    { name: "Head of Distribution", access: "View business unit" },
    { name: "Credit Insurance POC", access: "Review & manage" },
    { name: "Finance stakeholder", access: "View all" },
    { name: "Administrator", access: "Full access" }
  ],
  reminders: [
    { event: "New request not reviewed", after: 1, recipient: "Credit Insurance POC" },
    { event: "Documents still outstanding", after: 2, recipient: "Business requester" },
    { event: "COFACE response overdue", after: 5, recipient: "Credit Insurance POC" },
    { event: "Approval nearing expiry", after: 30, recipient: "Business requester" }
  ],
  requests: []
};

const clone = value => JSON.parse(JSON.stringify(value));
const HTML_ESCAPES = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
// Every server-sourced value must pass through esc() before it is interpolated into innerHTML.
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]); }
let state = clone(DEFAULTS);
let activeView = "dashboard";
let adminTab = "statuses";
let notifications = [];
let currentUser = { name:"", roles:[] };

async function api(path, options={}) {
  const response = await fetch(path, { headers:{'Content-Type':'application/json',...(options.headers||{})}, ...options });
  const payload = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}
function money(value, currency="AED") { return new Intl.NumberFormat("en-AE", { style:"currency", currency, maximumFractionDigits:0 }).format(value); }
function dateLabel(value) { return new Date(value + "T12:00:00").toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" }); }
function isFinance() { return currentUser.roles.some(role => ["Finance Reviewer","Administrator"].includes(role)); }
function timeLabel(value) { return value ? new Date(value.replace(" ","T")+"Z").toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : ""; }
function statusColor(status) { return esc(state.statuses.find(s => s.name === status)?.color || "gray"); }
function isOverdue(request) { return new Date(request.due + "T23:59:00") < new Date() && !["Approved","Rejected","Closed"].includes(request.status); }
function toast(message) { const el=document.createElement("div"); el.className="toast"; el.textContent=message; document.querySelector("#toastRoot").append(el); setTimeout(()=>el.remove(),2600); }
function renderNotificationBadge(){ const count=notifications.filter(n=>!n.readAt).length; const badge=document.querySelector('#notificationBadge'); badge.textContent=count; badge.hidden=count===0; }
async function loadNotifications(){ try { notifications=await api('/api/notifications'); renderNotificationBadge(); } catch {} }

function render() {
  document.querySelector("#requestCount").textContent = state.requests.filter(r => !["Closed","Approved","Rejected"].includes(r.status)).length;
  renderDashboard(); renderRequests(); renderAdmin();
}

function renderDashboard() {
  const open=state.requests.filter(r=>!["Approved","Rejected","Closed"].includes(r.status));
  const overdue=open.filter(isOverdue);
  const missing=open.filter(r=>r.status.includes("Documents Required"));
  const waiting=open.filter(r=>r.status.includes("COFACE") || r.status.includes("Information"));
  document.querySelector("#dashboardView").innerHTML = `
    <div class="metrics">
      ${metric("Open requests",open.length,"↗",`${open.length} active across the business`)}
      ${metric("Needs attention",overdue.length,"!",`<strong>${overdue.length} overdue</strong> action${overdue.length===1?"":"s"}`)}
      ${metric("Awaiting COFACE",waiting.length,"⌛","External response pending")}
      ${metric("Documents missing",missing.length,"▱","Waiting on business")}
    </div>
    <div class="dashboard-grid">
      <div class="panel">
        <div class="panel-header"><div><h2>Priority requests</h2><p>Items needing your attention or approaching their due date</p></div><button class="ghost-button" data-go="requests">View all →</button></div>
        ${requestTable([...state.requests].sort((a,b)=>isOverdue(b)-isOverdue(a)).slice(0,5))}
      </div>
      <div class="panel">
        <div class="panel-header"><div><h2>Recent activity</h2><p>Latest request updates</p></div></div>
        <div class="action-list">
          ${(state.recentActivity||[]).length?state.recentActivity.map(ev=>`<div class="action-item clickable" data-request="${esc(ev.requestId)}"><span class="action-symbol">${ev.type==='comment'?"✎":"↗"}</span><div><strong>${esc(ev.type==='comment'?`${ev.actor} commented`:ev.message)}</strong><p>${esc(ev.buyer)} · ${esc(ev.requestId)}</p><time>${esc(ev.actor)} · ${esc(timeLabel(ev.createdAt))}</time></div></div>`).join(""):'<div class="empty-state">No activity yet.</div>'}
        </div>
      </div>
    </div>`;
}
function metric(label,value,icon,note) { return `<div class="metric-card"><div class="metric-label">${label}<span class="metric-icon">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`; }
function requestTable(requests) {
  if (!requests.length) return `<div class="empty-state">No requests match this view.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Request / Buyer</th><th>Status</th><th>Requested limit</th><th>Owner</th><th>Due date</th></tr></thead><tbody>${requests.map(r=>`<tr class="clickable" data-request="${esc(r.id)}"><td class="company-cell"><strong>${esc(r.buyer)}</strong><small>${esc(r.id)} · ${esc(r.unit)}</small></td><td><span class="status status-${statusColor(r.status)}">${esc(r.status)}</span></td><td>${esc(money(r.amount,r.currency))}</td><td>${esc(r.owner)}</td><td class="${isOverdue(r)?"due-over":""}">${esc(dateLabel(r.due))}${isOverdue(r)?" · Overdue":""}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderRequests() {
  document.querySelector("#requestsView").innerHTML = `<div class="section-toolbar"><div class="search"><span>⌕</span><input id="requestSearch" placeholder="Search buyer, ID, owner or business unit"></div><select id="statusFilter" class="filter-select"><option value="">All statuses</option>${state.statuses.map(s=>`<option>${esc(s.name)}</option>`).join("")}</select></div><div class="panel" id="requestTablePanel">${requestTable(state.requests)}</div>`;
}

function renderAdmin() {
  const tabs=[['statuses','Workflow statuses'],['documents','Document checklist'],['roles','Roles & access'],['reminders','Reminders & escalation']];
  document.querySelector("#adminView").innerHTML=`<div class="admin-layout"><div class="panel admin-tabs">${tabs.map(t=>`<button class="admin-tab ${adminTab===t[0]?"active":""}" data-admin-tab="${t[0]}">${t[1]}</button>`).join("")}</div><div class="panel admin-content" id="adminContent">${adminPanel()}</div></div>`;
}
function adminPanel() {
  if(adminTab==='statuses') return `<h2>Workflow statuses</h2><p>Define the stages, colour and expected turnaround time for every request.</p><div class="config-list">${state.statuses.map((s,i)=>`<div class="config-row"><span class="drag">⋮⋮</span><input type="text" value="${esc(s.name)}" data-field="name" data-index="${i}"><select data-field="color" data-index="${i}">${['teal','blue','orange','red','gray'].map(c=>`<option ${c===s.color?'selected':''}>${c}</option>`).join('')}</select><label>SLA <input type="number" min="0" value="${esc(s.sla)}" data-field="sla" data-index="${i}" style="width:55px"> days</label><button class="delete-row" data-delete="statuses" data-index="${i}">×</button></div>`).join('')}</div><button class="secondary-button add-row" data-add="statuses">＋ Add status</button>${saveBar()}`;
  if(adminTab==='documents') return `<h2>Document checklist</h2><p>Choose which documents are mandatory before a request can be submitted.</p><div class="config-list">${state.documents.map((d,i)=>`<div class="config-row"><span class="drag">⋮⋮</span><input type="text" value="${esc(d.name)}" data-field="name" data-index="${i}"><label><input type="checkbox" ${d.required?'checked':''} data-field="required" data-index="${i}"> Required</label><button class="delete-row" data-delete="documents" data-index="${i}">×</button></div>`).join('')}</div><button class="secondary-button add-row" data-add="documents">＋ Add document</button>${saveBar()}`;
  if(adminTab==='roles') return `<h2>Roles & access</h2><p>Configure who can create, review and oversee requests.</p><div class="config-list">${state.roles.map((r,i)=>`<div class="config-row"><input type="text" value="${esc(r.name)}" data-field="name" data-index="${i}"><select data-field="access" data-index="${i}">${['Create & view own','View business unit','Review & manage','View all','Full access'].map(a=>`<option ${a===r.access?'selected':''}>${a}</option>`).join('')}</select><button class="delete-row" data-delete="roles" data-index="${i}">×</button></div>`).join('')}</div><button class="secondary-button add-row" data-add="roles">＋ Add role</button>${saveBar()}`;
  return `<h2>Reminders & escalation</h2><p>Set automatic follow-ups so that no request is forgotten in an inbox.</p><div class="config-list">${state.reminders.map((r,i)=>`<div class="config-row"><input type="text" value="${esc(r.event)}" data-field="event" data-index="${i}"><label>After <input type="number" min="1" value="${esc(r.after)}" data-field="after" data-index="${i}" style="width:55px"> days</label><select data-field="recipient" data-index="${i}">${state.roles.map(role=>`<option ${role.name===r.recipient?'selected':''}>${esc(role.name)}</option>`).join('')}</select><button class="delete-row" data-delete="reminders" data-index="${i}">×</button></div>`).join('')}</div><button class="secondary-button add-row" data-add="reminders">＋ Add reminder</button>${saveBar()}`;
}
function saveBar(){ return `<div class="save-bar"><button class="primary-button" id="saveConfig">Save configuration</button></div>`; }

function showNewRequest() {
  const docFields=state.documents.map((d,i)=>`<div class="form-group ${i>1?'full':''}"><label>${esc(d.name)}${d.required?' <span class="required">*</span>':''}</label><div class="upload-box">Choose a PDF from your device (max 10 MB)<input type="file" accept=".pdf,application/pdf" data-doc="${i}" ${d.required?'required':''}></div></div>`).join('');
  modal(`<div class="modal"><form id="newRequestForm"><div class="modal-head"><div><h2>New credit insurance request</h2><p>Submit buyer details for finance review</p></div><button type="button" class="close-modal">×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group full"><label>Buyer legal name <span class="required">*</span></label><input name="buyer" required></div><div class="form-group"><label>Country <span class="required">*</span></label><input name="country" required></div><div class="form-group"><label>Business unit <span class="required">*</span></label><input name="unit" required></div><div class="form-group"><label>Requested credit limit <span class="required">*</span></label><input name="amount" type="number" min="1" required></div><div class="form-group"><label>Currency</label><select name="currency"><option>AED</option><option>USD</option><option>EUR</option><option>SAR</option></select></div><div class="form-group"><label>Payment terms</label><input name="terms"></div><div class="form-group"><label>Requester</label><input value="Provided by corporate sign-in" disabled></div><div class="form-group full"><label>Business justification</label><textarea name="note"></textarea></div>${docFields}</div></div><div class="modal-foot"><button type="button" class="secondary-button close-modal">Cancel</button><button type="submit" class="primary-button">Submit request</button></div></form></div>`);
}
async function showRequest(id) {
  let r;
  try { r=await api(`/api/requests/${encodeURIComponent(id)}`); } catch(error){ toast(error.message); return; }
  const timeline=r.events.length
    ? r.events.map(ev=>`<div class="timeline-item ${ev.type==='comment'?'comment':''}"><strong>${esc(ev.type==='comment'?`${ev.actor} commented`:ev.message)}</strong>${ev.type==='comment'?`<p class="comment-text">${esc(ev.message)}</p>`:''}<span>${esc(ev.actor)} · ${esc(timeLabel(ev.createdAt))}</span></div>`).join('')
    : r.history.map(h=>`<div class="timeline-item"><strong>${esc(h)}</strong></div>`).join('');
  const awaitingMe=r.requester===currentUser.name && (r.status.includes('Documents Required') || r.status.includes('Information Required'));
  const requesterAction=awaitingMe?`<div class="detail-section action-needed"><h3>Your action is needed</h3><p>Finance has asked for more ${r.status.includes('Documents')?'documents':'information'}. Upload any documents below, add a note, then send the request back.</p><textarea id="respondComment" maxlength="2000" placeholder="Optional note for Finance"></textarea><button class="primary-button" data-respond-request="${esc(r.id)}" style="width:100%;margin-top:9px">Send back to Finance</button></div>`:'';
  const financeActions=isFinance()?`<div class="detail-section"><h3>Move request</h3><select id="detailStatus" style="width:100%;padding:10px">${state.statuses.map(s=>`<option ${s.name===r.status?'selected':''}>${esc(s.name)}</option>`).join('')}</select><div class="outcome-fields"><label>COFACE reference<input id="detailCoface" maxlength="100" value="${r.coface&&r.coface!=='—'?esc(r.coface):''}" placeholder="Required to approve"></label><label>Approved limit (${esc(r.currency)})<input id="detailApproved" type="number" min="1" value="${r.approved?esc(r.approved):''}" placeholder="Required to approve"></label></div><button class="primary-button" data-update-request="${esc(r.id)}" style="width:100%;margin-top:9px">Update status</button></div>`:'';
  modal(`<div class="modal wide"><div class="modal-head"><div><span class="eyebrow">${esc(r.id)}</span><h2>${esc(r.buyer)}</h2><p>${esc(r.country)} · ${esc(r.unit)}</p></div><button class="close-modal">×</button></div><div class="modal-body"><div class="detail-summary"><div class="detail-stat"><small>Current status</small><strong><span class="status status-${statusColor(r.status)}">${esc(r.status)}</span></strong></div><div class="detail-stat"><small>Requested limit</small><strong>${esc(money(r.amount,r.currency))}</strong></div><div class="detail-stat"><small>Current owner</small><strong>${esc(r.owner)}</strong></div></div><div class="detail-grid"><div><div class="detail-section"><h3>Request details</h3><div class="info-grid"><div class="info-item"><small>Submitted by</small><strong>${esc(r.requester)}</strong></div><div class="info-item"><small>Submitted on</small><strong>${esc(dateLabel(r.submitted))}</strong></div><div class="info-item"><small>Payment terms</small><strong>${esc(r.terms)}</strong></div><div class="info-item"><small>COFACE reference</small><strong>${esc(r.coface)}</strong></div><div class="info-item"><small>Approved limit</small><strong>${r.approved?esc(money(r.approved,r.currency)):'—'}</strong></div></div></div><div class="detail-section"><h3>Business justification</h3><p style="color:var(--muted);font-size:11px;line-height:1.6">${esc(r.note)}</p></div><div class="detail-section"><h3>Conversation & activity</h3><form id="commentForm" data-comment-request="${esc(r.id)}" class="comment-form"><textarea name="text" maxlength="2000" required placeholder="Ask a question or reply to Finance / the business. Everyone on this request is notified."></textarea><button type="submit" class="secondary-button">Add comment</button></form><div class="timeline">${timeline}</div></div></div><aside>${requesterAction}<div class="detail-section"><h3>Documents</h3>${state.documents.map((d,i)=>{ const files=r.documents.filter(doc=>doc.docIndex===i); return `<div class="document-block"><div class="document-item"><span>${esc(d.name)}${d.required?' <span class="required">*</span>':''}</span><span class="document-state ${files.length?'':'missing'}">${files.length?'✓ Received':'— Missing'}</span></div>${files.map(doc=>`<a class="document-file" href="/api/documents/${esc(doc.id)}">${esc(doc.name)}</a><small class="document-meta">${esc(fileSize(doc.size))} · ${esc(doc.uploadedBy)} · ${esc(timeLabel(doc.uploadedAt))}</small>`).join('')}<label class="document-upload">${files.length?'Upload a newer version':'Upload PDF'}<input type="file" accept=".pdf,application/pdf" data-upload-request="${esc(r.id)}" data-upload-doc="${i}"></label></div>`; }).join('')}</div>${financeActions}</aside></div></div></div>`);
}
async function uploadDocument(requestId, docIndex, file) {
  if (file.size > 10*1024*1024) throw new Error('Documents must be 10 MB or smaller');
  const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/documents?doc=${docIndex}`, { method:'POST', headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(file.name)}, body:file });
  const payload = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(payload.error || `Upload failed (${response.status})`);
  return payload;
}
function fileSize(bytes) { return bytes >= 1048576 ? `${(bytes/1048576).toFixed(1)} MB` : `${Math.max(1,Math.round(bytes/1024))} KB`; }
function modal(html){ document.querySelector('#modalRoot').innerHTML=`<div class="modal-backdrop">${html}</div>`; }
function notificationTime(value){ return new Date(value.replace(' ','T')+'Z').toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); }
function showNotifications(){
  modal(`<div class="modal"><div class="modal-head"><div><h2>Notifications</h2><p>Request updates and pending-action reminders</p></div><button class="close-modal">×</button></div><div class="modal-body"><div class="notification-list">${notifications.length?notifications.map(n=>`<div class="notification-item ${n.type==='reminder'?'reminder':''} ${n.readAt?'':'unread'}"><span class="notification-type"></span><div class="notification-copy"><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><time>${esc(notificationTime(n.createdAt))}</time></div>${n.readAt?'':`<button class="mark-read" data-read-notification="${esc(n.id)}">Mark read</button>`}</div>`).join(''):'<div class="empty-state">No notifications.</div>'}</div></div></div>`);
}
function closeModal(){ document.querySelector('#modalRoot').innerHTML=''; }

document.addEventListener('click', async e => {
  const nav=e.target.closest('[data-view]'); if(nav) switchView(nav.dataset.view);
  if(e.target.closest('#newRequestButton')) showNewRequest();
  if(e.target.closest('.close-modal') || e.target.classList.contains('modal-backdrop')) closeModal();
  const row=e.target.closest('[data-request]'); if(row) showRequest(row.dataset.request);
  const go=e.target.closest('[data-go]'); if(go) switchView(go.dataset.go);
  const tab=e.target.closest('[data-admin-tab]'); if(tab){ adminTab=tab.dataset.adminTab; renderAdmin(); }
  const del=e.target.closest('[data-delete]'); if(del){ state[del.dataset.delete].splice(Number(del.dataset.index),1); renderAdmin(); }
  const add=e.target.closest('[data-add]'); if(add){ const key=add.dataset.add; const templates={statuses:{name:'New status',color:'gray',sla:1},documents:{name:'New document',required:false},roles:{name:'New role',access:'View all'},reminders:{event:'New reminder',after:1,recipient:state.roles[0]?.name||'Administrator'}}; state[key].push(templates[key]); renderAdmin(); }
  if(e.target.closest('#saveConfig')){ captureConfig(); try { state[adminTab]=await api(`/api/config/${adminTab}`,{method:'PUT',body:JSON.stringify(state[adminTab])}); render(); toast('Configuration saved'); } catch(error){ toast(error.message); } }
  const update=e.target.closest('[data-update-request]'); if(update){ try { const changed=await api(`/api/requests/${encodeURIComponent(update.dataset.updateRequest)}/status`,{method:'PATCH',body:JSON.stringify({status:document.querySelector('#detailStatus').value,cofaceReference:document.querySelector('#detailCoface')?.value||undefined,approvedAmount:document.querySelector('#detailApproved')?.value||undefined})}); const index=state.requests.findIndex(x=>x.id===changed.id); state.requests[index]=changed; closeModal(); render(); toast('Request status updated'); } catch(error){ toast(error.message); } }
  const respond=e.target.closest('[data-respond-request]'); if(respond){ const id=respond.dataset.respondRequest; try { await api(`/api/requests/${encodeURIComponent(id)}/respond`,{method:'POST',body:JSON.stringify({comment:document.querySelector('#respondComment')?.value||''})}); await refreshState(); closeModal(); toast('Sent back to Finance'); } catch(error){ toast(error.message); } }
  if(e.target.closest('#mobileMenu')) document.querySelector('.sidebar').classList.toggle('open');
  if(e.target.closest('#notificationButton')){ await loadNotifications(); showNotifications(); }
  const readNotification=e.target.closest('[data-read-notification]'); if(readNotification){ try { await api(`/api/notifications/${readNotification.dataset.readNotification}/read`,{method:'PATCH',body:'{}'}); await loadNotifications(); showNotifications(); } catch(error){ toast(error.message); } }
});
document.addEventListener('submit', async e => {
  if(e.target.id==='commentForm'){ e.preventDefault(); const id=e.target.dataset.commentRequest; try { await api(`/api/requests/${encodeURIComponent(id)}/comments`,{method:'POST',body:JSON.stringify({text:new FormData(e.target).get('text')})}); await refreshState(); await showRequest(id); toast('Comment added'); } catch(error){ toast(error.message); } return; }
  if(e.target.id!=='newRequestForm')return; e.preventDefault(); const form=new FormData(e.target); const today=new Date(); const due=new Date(); due.setDate(today.getDate()+1); const next=String(Math.max(...state.requests.map(r=>Number(r.id.split('-').pop())))+1).padStart(3,'0');
  const payload={buyer:form.get('buyer'),country:form.get('country'),unit:form.get('unit'),amount:Number(form.get('amount')),currency:form.get('currency'),terms:form.get('terms'),requester:form.get('requester'),note:form.get('note'),docs:state.documents.map((_,i)=>Boolean(e.target.querySelector(`[data-doc="${i}"]`)?.files.length))};
  let created;
  try { created=await api('/api/requests',{method:'POST',body:JSON.stringify(payload)}); } catch(error){ toast(error.message); return; }
  const failed=[];
  for (const [i] of state.documents.entries()) { const file=e.target.querySelector(`[data-doc="${i}"]`)?.files[0]; if(file){ try { await uploadDocument(created.id,i,file); } catch(error){ failed.push(`${file.name}: ${error.message}`); } } }
  await refreshState(); await loadNotifications(); closeModal(); switchView('requests');
  toast(failed.length?`Request submitted. Some documents failed to upload - open the request to retry. ${failed.join('; ')}`:'Request submitted and finance notified');
});
document.addEventListener('input',e=>{ if(e.target.id==='requestSearch') filterRequests(); });
document.addEventListener('change',async e=>{
  if(e.target.id==='statusFilter') filterRequests();
  if(e.target.dataset.uploadRequest && e.target.files[0]){ const id=e.target.dataset.uploadRequest; try { await uploadDocument(id,Number(e.target.dataset.uploadDoc),e.target.files[0]); await refreshState(); await showRequest(id); toast('Document uploaded'); } catch(error){ toast(error.message); e.target.value=''; } }
});
function filterRequests(){ const q=(document.querySelector('#requestSearch')?.value||'').toLowerCase(); const status=document.querySelector('#statusFilter')?.value||''; const list=state.requests.filter(r=>(!status||r.status===status)&&[r.id,r.buyer,r.owner,r.unit].join(' ').toLowerCase().includes(q)); document.querySelector('#requestTablePanel').innerHTML=requestTable(list); }
function captureConfig(){ document.querySelectorAll('#adminContent [data-field]').forEach(el=>{ const value=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value; state[adminTab][Number(el.dataset.index)][el.dataset.field]=value; }); }
function switchView(view){ activeView=view; document.querySelectorAll('.view').forEach(v=>v.classList.remove('active')); document.querySelector(`#${view}View`).classList.add('active'); document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===view)); const copy={dashboard:['CREDIT INSURANCE','Request overview'],requests:['REQUEST MANAGEMENT','All credit requests'],admin:['APPLICATION CONTROL','Administration']}; document.querySelector('#pageEyebrow').textContent=copy[view][0]; document.querySelector('#pageTitle').textContent=copy[view][1]; document.querySelector('.sidebar').classList.remove('open'); }
async function refreshState(){ state=await api('/api/bootstrap'); render(); }
async function init(){
  try { currentUser=await api('/api/session'); state=await api('/api/bootstrap'); await loadNotifications(); render(); }
  catch(error){ render(); toast('Application service unavailable. Contact your administrator.'); }
}
init();
