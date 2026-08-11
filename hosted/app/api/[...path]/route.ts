import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export const runtime = "edge";
const BUCKET = "credit-insurance-documents";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type Profile = { id:string; email:string; full_name:string; app_role:"Business Requester"|"Finance Reviewer"|"Administrator"; approved:boolean };
type Context = { supabase:SupabaseClient; user:User; profile:Profile };

function response(payload:unknown,status=200) { return Response.json(payload,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}}); }
function safeMessage(error:unknown) { return error instanceof Error ? error.message : "Unexpected application error"; }
function text(value:FormDataEntryValue|null,max:number) { return typeof value === "string" ? value.trim().slice(0,max) : ""; }
function bearer(request:Request) { const value=request.headers.get("authorization") ?? ""; return value.startsWith("Bearer ") ? value.slice(7) : ""; }
function clientFor(request:Request) {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL; const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key) throw Object.assign(new Error("Supabase configuration is unavailable"),{status:503});
  const token=bearer(request); if(!token) throw Object.assign(new Error("Sign in is required"),{status:401});
  return {token,supabase:createClient(url,key,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}})};
}
async function context(request:Request):Promise<Context> {
  const {token,supabase}=clientFor(request);
  const {data:{user},error:userError}=await supabase.auth.getUser(token);
  if(userError||!user) throw Object.assign(new Error("Your session is invalid or has expired"),{status:401});
  const {data:profile,error}=await supabase.from("profiles").select("id,email,full_name,app_role,approved").eq("id",user.id).single();
  if(error||!profile) throw Object.assign(new Error("Your application profile is unavailable"),{status:403});
  if(!profile.approved) throw Object.assign(new Error("Your access is pending approval"),{status:403});
  return {supabase,user,profile:profile as Profile};
}
function requireRole(profile:Profile,roles:Profile["app_role"][]) { if(!roles.includes(profile.app_role)) throw Object.assign(new Error("You do not have permission to perform this action"),{status:403}); }
function cleanFilename(value:string) { return value.normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,120) || "document.pdf"; }
function isPdf(file:File) { return file.type === "application/pdf" && file.size > 4 && file.size <= MAX_FILE_BYTES; }
async function hasPdfSignature(file:File) { return new TextDecoder().decode((await file.slice(0,5).arrayBuffer())) === "%PDF-"; }

async function settings(supabase:SupabaseClient) {
  const {data,error}=await supabase.from("app_settings").select("section,value_json"); if(error) throw error;
  return Object.fromEntries((data??[]).map((row:any)=>[row.section,row.value_json]));
}
function mapRequest(row:any) {
  const documents=[...(row.request_documents??[])].sort((a:any,b:any)=>a.checklist_index-b.checklist_index);
  const history=[...(row.request_history??[])].sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at)));
  return {id:row.request_code,buyer:row.buyer,country:row.country,unit:row.business_unit,amount:Number(row.amount),currency:row.currency,terms:row.payment_terms,status:row.status,owner:row.owner_name,requester:row.requester_name,due:row.due_date,submitted:row.submitted_date,coface:row.coface_reference,approved:row.approved_amount===null?null:Number(row.approved_amount),note:row.note,docs:documents.reduce((values:boolean[],doc:any)=>{values[doc.checklist_index]=true;return values;},[]),documentFiles:documents.map((doc:any)=>({id:doc.id,label:doc.label,filename:doc.filename,size:doc.size_bytes})),history:history.map((item:any)=>item.event)};
}
const requestSelect="*,request_documents(id,checklist_index,label,filename,size_bytes),request_history(event,created_at)";

async function bootstrap(request:Request) {
  const {supabase,profile}=await context(request); const config=await settings(supabase);
  const {data,error}=await supabase.from("credit_requests").select(requestSelect).order("created_at",{ascending:false}); if(error) throw error;
  return response({...config,requests:(data??[]).map(mapRequest),session:{email:profile.email,name:profile.full_name||profile.email,role:profile.app_role}});
}
async function createRequest(request:Request) {
  const {supabase,user,profile}=await context(request);
  const form=await request.formData(); const config=await settings(supabase); const checklist=Array.isArray(config.documents)?config.documents:[];
  const buyer=text(form.get("buyer"),200),country=text(form.get("country"),100),unit=text(form.get("unit"),120),currency=text(form.get("currency"),3).toUpperCase(),terms=text(form.get("terms"),200)||"Not specified",note=text(form.get("note"),2000),amount=Number(form.get("amount"));
  if(!buyer||!country||!unit||!Number.isFinite(amount)||amount<=0||!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error("Buyer, country, business unit, currency and a positive amount are required"),{status:400});
  const files=checklist.map((_:unknown,index:number)=>form.get(`document_${index}`)).map(value=>value instanceof File&&value.size?value:null);
  for(let index=0;index<checklist.length;index++) if(checklist[index]?.required&&!files[index]) throw Object.assign(new Error(`${checklist[index].name} is required`),{status:400});
  for(const file of files) if(file&&(!isPdf(file)||!(await hasPdfSignature(file)))) throw Object.assign(new Error("Only valid PDF documents up to 10 MB are accepted"),{status:400});
  const firstStatus=Array.isArray(config.statuses)&&config.statuses[0]?.name?config.statuses[0].name:"Submitted to Finance";
  const due=new Date(); due.setUTCDate(due.getUTCDate()+1);
  const {data:created,error:createError}=await supabase.from("credit_requests").insert({requester_id:user.id,requester_name:profile.full_name||profile.email,buyer,country,business_unit:unit,amount,currency,payment_terms:terms,status:firstStatus,due_date:due.toISOString().slice(0,10),note}).select("*").single();
  if(createError) throw createError;
  const requestCode=created.request_code as string;
  const uploaded:string[]=[];
  try {
    for(let index=0;index<files.length;index++) { const file=files[index]; if(!file) continue; const path=`${created.id}/${crypto.randomUUID()}.pdf`; const {error:uploadError}=await supabase.storage.from(BUCKET).upload(path,file,{contentType:"application/pdf",upsert:false}); if(uploadError) throw uploadError; uploaded.push(path); const {error:docError}=await supabase.from("request_documents").insert({request_id:created.id,checklist_index:index,label:checklist[index].name,storage_path:path,filename:cleanFilename(file.name),content_type:"application/pdf",size_bytes:file.size,uploaded_by:user.id}); if(docError) throw docError; }
  } catch(error) { if(uploaded.length) await supabase.storage.from(BUCKET).remove(uploaded); await supabase.from("credit_requests").delete().eq("id",created.id); throw error; }
  await supabase.from("request_history").insert({request_id:created.id,event:`Request submitted by ${profile.full_name||profile.email}`,actor_id:user.id,actor_name:profile.full_name||profile.email});
  await supabase.from("notifications").insert({recipient_id:user.id,request_id:created.id,notification_type:"new_request",title:"Request submitted",message:`${requestCode} - ${buyer} was submitted for finance review.`,event_key:`created:${created.id}:${user.id}`});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.created",entity_type:"credit_request",entity_id:requestCode,details:{document_count:uploaded.length}});
  const {data,error}=await supabase.from("credit_requests").select(requestSelect).eq("id",created.id).single(); if(error) throw error;
  return response(mapRequest(data),201);
}
async function updateStatus(request:Request,code:string) {
  const {supabase,user,profile}=await context(request); requireRole(profile,["Finance Reviewer","Administrator"]);
  const payload=await request.json() as {status?:string}; const config=await settings(supabase); const allowed=(config.statuses??[]).map((item:any)=>item.name);
  if(!payload.status||!allowed.includes(payload.status)) throw Object.assign(new Error("Unknown workflow status"),{status:400});
  const {data:before,error:findError}=await supabase.from("credit_requests").select("id,buyer,status,requester_id").eq("request_code",code).single(); if(findError) throw findError;
  const {error:updateError}=await supabase.from("credit_requests").update({status:payload.status,updated_at:new Date().toISOString()}).eq("id",before.id); if(updateError) throw updateError;
  await supabase.from("request_history").insert({request_id:before.id,event:`Status changed from ${before.status} to ${payload.status}`,actor_id:user.id,actor_name:profile.full_name||profile.email});
  if(before.requester_id===user.id) await supabase.from("notifications").insert({recipient_id:user.id,request_id:before.id,notification_type:"status_change",title:"Request stage updated",message:`${code} - ${before.buyer} moved to ${payload.status}.`,event_key:`status:${before.id}:${Date.now()}`});
  await supabase.from("audit_events").insert({actor_id:user.id,actor_email:profile.email,action:"request.status_changed",entity_type:"credit_request",entity_id:code,details:{from:before.status,to:payload.status}});
  const {data,error}=await supabase.from("credit_requests").select(requestSelect).eq("id",before.id).single(); if(error) throw error; return response(mapRequest(data));
}
async function notifications(request:Request) {
  const {supabase,user}=await context(request);
  const cutoff=new Date(Date.now()-3*86400000).toISOString(); const {data:pending}=await supabase.from("credit_requests").select("id,request_code,buyer,status").lt("updated_at",cutoff).not("status","in",'(\"Approved\",\"Rejected\",\"Closed\")');
  for(const item of pending??[]) await supabase.from("notifications").upsert({recipient_id:user.id,request_id:item.id,notification_type:"reminder",title:"Request pending for more than 3 days",message:`${item.request_code} - ${item.buyer} is still at ${item.status}.`,event_key:`pending:${item.id}:${new Date().toISOString().slice(0,10)}:${user.id}`},{onConflict:"event_key",ignoreDuplicates:true});
  const {data,error}=await supabase.from("notifications").select("id,request_id,notification_type,title,message,read_at,created_at").order("created_at",{ascending:false}).limit(50); if(error) throw error;
  return response((data??[]).map((item:any)=>({id:item.id,requestId:item.request_id,type:item.notification_type,title:item.title,message:item.message,readAt:item.read_at,createdAt:item.created_at})));
}
async function markRead(request:Request,id:string) { const {supabase}=await context(request); const {error}=await supabase.from("notifications").update({read_at:new Date().toISOString()}).eq("id",id); if(error) throw error; return response({ok:true}); }
async function updateConfig(request:Request,section:string) { const {supabase,profile}=await context(request); requireRole(profile,["Administrator"]); const value=await request.json(); if(!Array.isArray(value)) throw Object.assign(new Error("Configuration must be an array"),{status:400}); const {error}=await supabase.from("app_settings").update({value_json:value,updated_at:new Date().toISOString()}).eq("section",section); if(error) throw error; return response(value); }
async function documentUrl(request:Request,id:string) { const {supabase}=await context(request); const {data:document,error}=await supabase.from("request_documents").select("storage_path").eq("id",id).single(); if(error) throw error; const {data,error:signError}=await supabase.storage.from(BUCKET).createSignedUrl(document.storage_path,120); if(signError) throw signError; return response({url:data.signedUrl,expiresIn:120}); }

async function route(request:Request,routeContext:{params:Promise<{path:string[]}>|{path:string[]}}) {
  try {
    const path=(await routeContext.params).path??[]; const joined=path.join("/");
    if(request.method==="GET"&&joined==="health") return response({status:"ok",database:"Supabase configured"});
    if(request.method==="GET"&&joined==="session") { const {profile}=await context(request); return response({name:profile.full_name||profile.email,email:profile.email,roles:[profile.app_role]}); }
    if(request.method==="GET"&&joined==="bootstrap") return bootstrap(request);
    if(request.method==="POST"&&joined==="requests") return createRequest(request);
    if(request.method==="GET"&&joined==="notifications") return notifications(request);
    if(request.method==="PATCH"&&path[0]==="notifications"&&path[2]==="read") return markRead(request,path[1]);
    if(request.method==="PATCH"&&path[0]==="requests"&&path[2]==="status") return updateStatus(request,decodeURIComponent(path[1]));
    if(request.method==="PUT"&&path[0]==="config"&&["statuses","documents","roles","reminders"].includes(path[1])) return updateConfig(request,path[1]);
    if(request.method==="GET"&&path[0]==="documents"&&path[1]) return documentUrl(request,path[1]);
    return response({error:"API route not found"},404);
  } catch(error:any) { console.error(error); return response({error:error?.status?safeMessage(error):"The request could not be completed"},error?.status??500); }
}
export const GET=route; export const POST=route; export const PATCH=route; export const PUT=route;
