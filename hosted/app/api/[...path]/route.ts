import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export const runtime = "edge";
const BUCKET = "credit-insurance-documents";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ROLES = ["Business Requester","Finance Reviewer","Administrator"] as const;
type AppRole = typeof ROLES[number];
type Profile = { id:string; email:string; full_name:string; app_role:AppRole; approved:boolean };
type Context = { supabase:SupabaseClient; user:User; profile:Profile };

function response(payload:unknown,status=200) { return Response.json(payload,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"same-origin"}}); }
function safeMessage(error:unknown) { return error instanceof Error ? error.message : "Unexpected application error"; }
function fail(message:string,status=400):never { throw Object.assign(new Error(message),{status}); }
function value(input:unknown,max:number) { return typeof input === "string" ? input.trim().slice(0,max) : ""; }
function formText(input:FormDataEntryValue|null,max:number) { return typeof input === "string" ? input.trim().slice(0,max) : ""; }
function bearer(request:Request) { const header=request.headers.get("authorization")??""; return header.startsWith("Bearer ")?header.slice(7):""; }
function clientFor(request:Request) {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL; const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key) fail("Supabase configuration is unavailable",503);
  const token=bearer(request); if(!token) fail("Sign in is required",401);
  return {token,supabase:createClient(url,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}})};
}
async function context(request:Request):Promise<Context> {
  const {token,supabase}=clientFor(request);
  const {data:{user},error:userError}=await supabase.auth.getUser(token);
  if(userError||!user) fail("Your session is invalid or has expired",401);
  const {data:profile,error}=await supabase.from("profiles").select("id,email,full_name,app_role,approved").eq("id",user.id).single();
  if(error||!profile) fail("Your application profile is unavailable",403);
  if(!profile.approved) fail("Your account is suspended. Contact an administrator.",403);
  return {supabase,user,profile:profile as Profile};
}
function requireRole(profile:Profile,roles:AppRole[]) { if(!roles.includes(profile.app_role)) fail("You do not have permission to perform this action",403); }
function cleanFilename(filename:string) { return filename.normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,120)||"document.pdf"; }
function isPdf(file:File) { return file.type==="application/pdf"&&file.size>4&&file.size<=MAX_FILE_BYTES; }
async function hasPdfSignature(file:File) { return new TextDecoder().decode(await file.slice(0,5).arrayBuffer())==="%PDF-"; }
function addBusinessDays(days:number) { const date=new Date(); let remaining=Math.max(0,Math.floor(days)); while(remaining>0){ date.setUTCDate(date.getUTCDate()+1); const day=date.getUTCDay(); if(day!==0&&day!==6) remaining--; } return date.toISOString().slice(0,10); }

async function settings(supabase:SupabaseClient) {
  const {data,error}=await supabase.from("app_settings").select("section,value_json"); if(error) throw error;
  return Object.fromEntries((data??[]).map((row:any)=>[row.section,row.value_json]));
}
function mapRequest(row:any) {
  const documents=[...(row.request_documents??[])].sort((a:any,b:any)=>a.checklist_index-b.checklist_index);
  const history=[...(row.request_history??[])].sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at)));
  const comments=[...(row.request_comments??[])].sort((a:any,b:any)=>String(a.created_at).localeCompare(String(b.created_at)));
  return {
    id:row.request_code,buyer:row.buyer,country:row.country,unit:row.business_unit,amount:Number(row.amount),currency:row.currency,requesterId:row.requester_id,
    terms:row.payment_terms,status:row.status,owner:row.owner_name,ownerId:row.owner_id,requester:row.requester_name,
    due:row.due_date,submitted:row.submitted_date,statusChangedAt:row.status_changed_at,nextAction:row.next_action,
    coface:row.coface_reference,approved:row.approved_amount===null?null:Number(row.approved_amount),
    approvalValidUntil:row.approval_valid_until,conditions:row.coface_conditions,decisionReason:row.decision_reason,note:row.note,
    docs:documents.reduce((flags:boolean[],doc:any)=>{flags[doc.checklist_index]=true;return flags;},[]),
    documentFiles:documents.map((doc:any)=>({id:doc.id,checklistIndex:doc.checklist_index,label:doc.label,filename:doc.filename,size:doc.size_bytes})),
    history:history.map((item:any)=>({event:item.event,actor:item.actor_name,createdAt:item.created_at})),
    comments:comments.map((item:any)=>({id:item.id,author:item.author_name,body:item.body,createdAt:item.created_at})),
    claims:(row.assignment_claims??[]).map((item:any)=>({id:item.id,reviewerId:item.reviewer_id,reviewerName:item.reviewer_name,status:item.status,decisionNote:item.decision_note,createdAt:item.created_at,decidedAt:item.decided_at}))
  };
}
const requestSelect="*,request_documents(id,checklist_index,label,filename,size_bytes),request_history(event,actor_name,created_at),request_comments(id,author_name,body,created_at),assignment_claims(id,reviewer_id,reviewer_name,status,decision_note,created_at,decided_at)";
async function requestById(supabase:SupabaseClient,id:string) { const {data,error}=await supabase.from("credit_requests").select(requestSelect).eq("id",id).single(); if(error) throw error; return mapRequest(data); }

async function bootstrap(request:Request) {
  const {supabase,profile}=await context(request); const config=await settings(supabase);
  const {data,error}=await supabase.from("credit_requests").select(requestSelect).order("created_at",{ascending:false}); if(error) throw error;
  let users:any[]=[]; let audit:any[]=[];
  if(profile.app_role==="Administrator") {
    const [{data:userRows,error:userError},{data:auditRows,error:auditError}]=await Promise.all([
      supabase.from("profiles").select("id,email,full_name,app_role,approved,created_at,updated_at").order("created_at",{ascending:true}),
      supabase.from("audit_events").select("id,actor_email,action,entity_type,entity_id,details,created_at").order("created_at",{ascending:false}).limit(100)
    ]);
    if(userError) throw userError; if(auditError) throw auditError;
    users=(userRows??[]).map((item:any)=>({id:item.id,email:item.email,fullName:item.full_name,role:item.app_role,approved:item.approved,createdAt:item.created_at,updatedAt:item.updated_at}));
    audit=(auditRows??[]).map((item:any)=>({id:item.id,actor:item.actor_email,action:item.action,entityType:item.entity_type,entityId:item.entity_id,details:item.details,createdAt:item.created_at}));
  }
  const ownerOptions=profile.app_role==="Administrator"?users.filter(user=>user.approved&&["Finance Reviewer","Administrator"].includes(user.role)).map(user=>({id:user.id,name:user.fullName||user.email,role:user.role})):profile.app_role==="Finance Reviewer"?[{id:profile.id,name:profile.full_name||profile.email,role:profile.app_role}]:[];
  return response({...config,requests:(data??[]).map(mapRequest),users,audit,ownerOptions,session:{id:profile.id,email:profile.email,name:profile.full_name||profile.email,role:profile.app_role,isAdmin:profile.app_role==="Administrator",canReview:["Finance Reviewer","Administrator"].includes(profile.app_role)}});
}

async function createRequest(request:Request) {
  const {supabase,user,profile}=await context(request);
  const form=await request.formData(); const config=await settings(supabase); const checklist=Array.isArray(config.documents)?config.documents:[];
  const buyer=formText(form.get("buyer"),200),country=formText(form.get("country"),100),unit=formText(form.get("unit"),120),currency=formText(form.get("currency"),3).toUpperCase(),terms=formText(form.get("terms"),200)||"Not specified",note=formText(form.get("note"),2000),amount=Number(form.get("amount"));
  if(!buyer||!country||!unit||!Number.isFinite(amount)||amount<=0||!/^[A-Z]{3}$/.test(currency)) fail("Buyer, country, business unit, currency and a positive amount are required");
  const files=checklist.map((_:unknown,index:number)=>form.get(`document_${index}`)).map((entry:FormDataEntryValue|null)=>entry instanceof File&&entry.size?entry:null);
  for(let index=0;index<checklist.length;index++) if(checklist[index]?.required&&!files[index]) fail(`${checklist[index].name} is required`);
  for(const file of files) if(file&&(!isPdf(file)||!(await hasPdfSignature(file)))) fail("Only valid PDF documents up to 10 MB are accepted");
  const firstStatus=Array.isArray(config.statuses)&&config.statuses[0]?.name?config.statuses[0].name:"Submitted to Finance";
  const firstSla=Number(config.statuses?.find((item:any)=>item.name===firstStatus)?.sla??1);
  const {data:created,error:createError}=await supabase.from("credit_requests").insert({requester_id:user.id,requester_name:profile.full_name||profile.email,buyer,country,business_unit:unit,amount,currency,payment_terms:terms,status:firstStatus,due_date:addBusinessDays(firstSla),next_action:"Finance review",status_changed_at:new Date().toISOString(),note}).select("*").single();
  if(createError) throw createError;
  const uploaded:string[]=[];
  try {
    for(let index=0;index<files.length;index++) { const file=files[index]; if(!file) continue; const path=`${created.id}/${crypto.randomUUID()}.pdf`; const {error:uploadError}=await supabase.storage.from(BUCKET).upload(path,file,{contentType:"application/pdf",upsert:false}); if(uploadError) throw uploadError; uploaded.push(path); const {error:documentError}=await supabase.from("request_documents").insert({request_id:created.id,checklist_index:index,label:checklist[index].name,storage_path:path,filename:cleanFilename(file.name),content_type:"application/pdf",size_bytes:file.size,uploaded_by:user.id}); if(documentError) throw documentError; }
  } catch(error) { if(uploaded.length) await supabase.storage.from(BUCKET).remove(uploaded); await supabase.from("credit_requests").delete().eq("id",created.id); throw error; }
  await supabase.from("request_history").insert({request_id:created.id,event:`Request submitted by ${profile.full_name||profile.email}`,actor_id:user.id,actor_name:profile.full_name||profile.email});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.created",entity_type:"credit_request",entity_id:created.request_code,details:{document_count:uploaded.length}});
  return response(await requestById(supabase,created.id),201);
}

async function updateRequest(request:Request,code:string) {
  const {supabase,user,profile}=await context(request); requireRole(profile,["Finance Reviewer","Administrator"]);
  const payload=await request.json() as Record<string,unknown>; const config=await settings(supabase); const statuses=Array.isArray(config.statuses)?config.statuses:[];
  const status=value(payload.status,120); const statusConfig=statuses.find((item:any)=>item.name===status); if(!statusConfig) fail("Unknown workflow status");
  const {data:before,error:findError}=await supabase.from("credit_requests").select("id,request_code,buyer,status,requester_id,owner_id,owner_name,coface_reference,approved_amount,approval_valid_until,coface_conditions,decision_reason").eq("request_code",code).single(); if(findError) throw findError;
  if(profile.app_role==="Finance Reviewer"&&before.owner_id!==user.id) fail("Only the assigned reviewer or an Administrator can update this request",403);
  let ownerId: string|null = typeof payload.ownerId==="string"&&payload.ownerId?payload.ownerId:null; let ownerName="Finance Review Queue";
  if(profile.app_role==="Finance Reviewer") { ownerId=before.owner_id; ownerName=before.owner_name; }
  else if(ownerId) { const {data:owner,error:ownerError}=await supabase.from("profiles").select("id,email,full_name,app_role,approved").eq("id",ownerId).single(); if(ownerError||!owner||!owner.approved||!["Finance Reviewer","Administrator"].includes(owner.app_role)) fail("Select an active finance reviewer or administrator as owner"); ownerName=owner.full_name||owner.email; }
  const nextAction=value(payload.nextAction,500)||(["Approved","Rejected","Closed"].includes(status)?"No further action":"Review and progress request");
  const cofaceReference=value(payload.cofaceReference,120)||before.coface_reference||"-";
  const approvedAmount=payload.approvedAmount===""||payload.approvedAmount===null||payload.approvedAmount===undefined?null:Number(payload.approvedAmount);
  const approvalValidUntil=value(payload.approvalValidUntil,10)||null;
  const conditions=value(payload.conditions,2000);
  const decisionReason=value(payload.decisionReason,2000);
  if(["Submitted to COFACE","Approved","Rejected"].includes(status)&&(cofaceReference==="-"||!cofaceReference)) fail("COFACE reference is required for this stage");
  if(status==="Approved"&&(!Number.isFinite(approvedAmount)||Number(approvedAmount)<=0||!approvalValidUntil)) fail("Approved amount and approval validity date are required");
  if(status==="Rejected"&&!decisionReason) fail("A rejection reason is required");
  const changedAt=new Date().toISOString();
  const updates={status,owner_id:ownerId,owner_name:ownerName,next_action:nextAction,due_date:addBusinessDays(Number(statusConfig.sla??0)),status_changed_at:changedAt,updated_at:changedAt,coface_reference:cofaceReference,approved_amount:approvedAmount,approval_valid_until:approvalValidUntil,coface_conditions:conditions,decision_reason:decisionReason};
  const {error:updateError}=await supabase.from("credit_requests").update(updates).eq("id",before.id); if(updateError) throw updateError;
  const changes=[before.status!==status?`Status changed from ${before.status} to ${status}`:"Request details updated",before.owner_id!==ownerId?`Owner assigned to ${ownerName}`:null].filter(Boolean).join(". ");
  await supabase.from("request_history").insert({request_id:before.id,event:changes,actor_id:user.id,actor_name:profile.full_name||profile.email});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.workflow_updated",entity_type:"credit_request",entity_id:code,details:{from:before.status,to:status,owner_id:ownerId,next_action:nextAction}});
  return response(await requestById(supabase,before.id));
}

async function claimRequest(request:Request,code:string) {
  const {supabase,user,profile}=await context(request); requireRole(profile,["Finance Reviewer"]);
  const {data:item,error:findError}=await supabase.from("credit_requests").select("id,request_code,buyer,owner_id").eq("request_code",code).single(); if(findError) throw findError;
  if(item.owner_id===user.id) return response(await requestById(supabase,item.id));
  if(item.owner_id) fail("This request is already assigned to another reviewer",409);
  const {data:existing}=await supabase.from("assignment_claims").select("id").eq("request_id",item.id).eq("reviewer_id",user.id).eq("status","Pending").maybeSingle();
  if(!existing) { const {error}=await supabase.from("assignment_claims").insert({request_id:item.id,reviewer_id:user.id,reviewer_name:profile.full_name||profile.email}); if(error) throw error; }
  await supabase.from("request_history").insert({request_id:item.id,event:"Assignment requested from Administrator",actor_id:user.id,actor_name:profile.full_name||profile.email});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.assignment_requested",entity_type:"credit_request",entity_id:code,details:{reviewer_id:user.id}});
  return response(await requestById(supabase,item.id),202);
}

async function decideClaim(request:Request,id:string) {
  const {supabase,user,profile}=await context(request); requireRole(profile,["Administrator"]); const payload=await request.json() as {decision?:unknown;note?:unknown};
  const decision=value(payload.decision,20); const note=value(payload.note,1000); if(!["Approved","Rejected"].includes(decision)) fail("Decision must be Approved or Rejected"); if(decision==="Rejected"&&!note) fail("A rejection reason is required");
  const {data:claim,error:findError}=await supabase.from("assignment_claims").select("id,request_id,reviewer_name,status").eq("id",id).single(); if(findError) throw findError; if(claim.status!=="Pending") fail("This assignment request has already been decided",409);
  const {error}=await supabase.from("assignment_claims").update({status:decision,decision_note:note,decided_by:user.id,decided_by_name:profile.full_name||profile.email,decided_at:new Date().toISOString()}).eq("id",id); if(error) fail(error.message.includes("already assigned")?"This request is already assigned to another reviewer":"The assignment decision could not be saved",409);
  await supabase.from("request_history").insert({request_id:claim.request_id,event:"Assignment request "+decision.toLowerCase()+" for "+claim.reviewer_name,actor_id:user.id,actor_name:profile.full_name||profile.email});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.assignment_"+decision.toLowerCase(),entity_type:"assignment_claim",entity_id:id,details:{request_id:claim.request_id,reviewer_name:claim.reviewer_name,note}});
  return response(await requestById(supabase,claim.request_id));
}

async function addComment(request:Request,code:string) {
  const {supabase,user,profile}=await context(request); const payload=await request.json() as {body?:unknown}; const body=value(payload.body,2000); if(!body) fail("Comment cannot be empty");
  const {data:item,error:findError}=await supabase.from("credit_requests").select("id,request_code").eq("request_code",code).single(); if(findError) throw findError;
  const {error}=await supabase.from("request_comments").insert({request_id:item.id,author_id:user.id,author_name:profile.full_name||profile.email,body}); if(error) throw error;
  await supabase.from("request_history").insert({request_id:item.id,event:"Comment added",actor_id:user.id,actor_name:profile.full_name||profile.email});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.comment_added",entity_type:"credit_request",entity_id:code,details:{}});
  return response(await requestById(supabase,item.id),201);
}

async function updateUserAccess(request:Request,id:string) {
  const {supabase,profile}=await context(request); requireRole(profile,["Administrator"]); const payload=await request.json() as {role?:unknown;approved?:unknown};
  const role=value(payload.role,40); if(!ROLES.includes(role as AppRole)||typeof payload.approved!=="boolean") fail("A valid role and account status are required");
  const {data,error}=await supabase.from("profiles").update({app_role:role,approved:payload.approved,updated_at:new Date().toISOString()}).eq("id",id).select("id,email,full_name,app_role,approved").single();
  if(error) fail(error.message.includes("final active administrator")?"The final active administrator cannot be removed or suspended":"User access could not be updated",400);
  return response({id:data.id,email:data.email,fullName:data.full_name,role:data.app_role,approved:data.approved});
}

async function notifications(request:Request) {
  const {supabase}=await context(request);
  const {data,error}=await supabase.from("notifications").select("id,request_id,notification_type,title,message,read_at,created_at").order("created_at",{ascending:false}).limit(75); if(error) throw error;
  return response((data??[]).map((item:any)=>({id:item.id,requestId:item.request_id,type:item.notification_type,title:item.title,message:item.message,readAt:item.read_at,createdAt:item.created_at})));
}
async function markRead(request:Request,id:string) { const {supabase}=await context(request); const {error}=await supabase.from("notifications").update({read_at:new Date().toISOString()}).eq("id",id); if(error) throw error; return response({ok:true}); }
async function updateConfig(request:Request,section:string) {
  const {supabase,user,profile}=await context(request); requireRole(profile,["Administrator"]); const data=await request.json();
  if(!Array.isArray(data)||data.length<1||data.length>50) fail("Configuration must contain between 1 and 50 items");
  if(section==="statuses") {
    const names=data.map((item:any)=>value(item?.name,120));
    if(names.some((name:string)=>!name)||new Set(names.map((name:string)=>name.toLowerCase())).size!==names.length) fail("Status names must be present and unique");
    if(!["Approved","Rejected","Closed"].every(name=>names.includes(name))) fail("Approved, Rejected and Closed are required system stages");
    if(data.some((item:any)=>!Number.isInteger(Number(item.sla))||Number(item.sla)<0||Number(item.sla)>90||!["teal","blue","orange","red","gray"].includes(item.color))) fail("Every status requires a valid colour and SLA between 0 and 90 days");
  }
  if(section==="documents") { const names=data.map((item:any)=>value(item?.name,160)); if(names.some((name:string)=>!name)||new Set(names.map((name:string)=>name.toLowerCase())).size!==names.length||data.some((item:any)=>typeof item.required!=="boolean")) fail("Document names must be unique and each item must specify whether it is required"); }
  if(section==="reminders"&&data.some((item:any)=>!value(item?.event,160)||!Number.isInteger(Number(item.after))||Number(item.after)<1||Number(item.after)>365||!["Business Requester","Finance Reviewer","Administrator"].includes(item.recipient))) fail("Each reminder requires an event, a delay from 1 to 365 days and a valid recipient role");
  const {error}=await supabase.from("app_settings").update({value_json:data,updated_at:new Date().toISOString()}).eq("section",section); if(error) throw error;
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"configuration.updated",entity_type:"application_setting",entity_id:section,details:{item_count:data.length}}); return response(data);
}
async function documentUrl(request:Request,id:string) { const {supabase}=await context(request); const {data:document,error}=await supabase.from("request_documents").select("storage_path").eq("id",id).single(); if(error) throw error; const {data,error:signError}=await supabase.storage.from(BUCKET).createSignedUrl(document.storage_path,120); if(signError) throw signError; return response({url:data.signedUrl,expiresIn:120}); }

async function route(request:Request,routeContext:{params:Promise<{path:string[]}>|{path:string[]}}) {
  try {
    const path=(await routeContext.params).path??[]; const joined=path.join("/");
    if(request.method==="GET"&&joined==="health") return response({status:"ok",database:"Supabase configured"});
    if(request.method==="GET"&&joined==="session") { const {profile}=await context(request); return response({id:profile.id,name:profile.full_name||profile.email,email:profile.email,role:profile.app_role}); }
    if(request.method==="GET"&&joined==="bootstrap") return bootstrap(request);
    if(request.method==="POST"&&joined==="requests") return createRequest(request);
    if(request.method==="GET"&&joined==="notifications") return notifications(request);
    if(request.method==="PATCH"&&path[0]==="notifications"&&path[2]==="read") return markRead(request,path[1]);
    if(request.method==="PATCH"&&path[0]==="requests"&&path[2]==="workflow") return updateRequest(request,decodeURIComponent(path[1]));
    if(request.method==="POST"&&path[0]==="requests"&&path[2]==="claim") return claimRequest(request,decodeURIComponent(path[1]));
    if(request.method==="PATCH"&&path[0]==="claims"&&path[1]) return decideClaim(request,path[1]);
    if(request.method==="POST"&&path[0]==="requests"&&path[2]==="comments") return addComment(request,decodeURIComponent(path[1]));
    if(request.method==="PATCH"&&path[0]==="admin"&&path[1]==="users"&&path[2]) return updateUserAccess(request,path[2]);
    if(request.method==="PUT"&&path[0]==="config"&&["statuses","documents","reminders"].includes(path[1])) return updateConfig(request,path[1]);
    if(request.method==="GET"&&path[0]==="documents"&&path[1]) return documentUrl(request,path[1]);
    return response({error:"API route not found"},404);
  } catch(error:any) { console.error(error); return response({error:error?.status?safeMessage(error):"The request could not be completed"},error?.status??500); }
}
export const GET=route; export const POST=route; export const PATCH=route; export const PUT=route;
