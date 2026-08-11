"use client";

import { createClient, type Session } from "@supabase/supabase-js";
import { FormEvent, useEffect, useMemo, useState } from "react";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
declare global { interface Window { CREDIT_ACCESS_TOKEN?: string; CREDIT_WORKFLOW_LOADED?: boolean; } }

export function Application() {
  const supabase = useMemo(() => url && publishableKey ? createClient(url, publishableKey) : null, []);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [supabase]);
  useEffect(() => {
    if (!session) return;
    window.CREDIT_ACCESS_TOKEN = session.access_token;
    if (!window.CREDIT_WORKFLOW_LOADED) {
      window.CREDIT_WORKFLOW_LOADED = true;
      const script = document.createElement("script"); script.src = "/workflow.js"; script.defer = true; document.body.appendChild(script);
    }
    return () => { window.CREDIT_ACCESS_TOKEN = undefined; };
  }, [session]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return;
    setBusy(true); setMessage(""); setIsError(false);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const fullName = String(form.get("fullName") ?? "").trim();
    const result = mode === "login" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
    if (result.error) { setMessage(result.error.message); setIsError(true); }
    else if (mode === "register" && !result.data.session) setMessage("Registration received. Check your email to confirm your account, then sign in.");
    setBusy(false);
  }
  if (!ready) return <div className="loading-screen">Preparing secure sign-in...</div>;
  if (!supabase) return <div className="loading-screen">Application configuration is incomplete. Contact the site administrator.</div>;
  if (!session) return <main className="auth-page">
    <section className="auth-context"><div><div className="auth-identity"><span className="auth-mark">CI</span><strong>Credit Insurance Requests</strong></div><h1>Controlled submission, review and approval tracking.</h1><p>Manage buyer credit-insurance requests, supporting documents, finance review and COFACE outcomes through one auditable workflow.</p><div className="auth-points"><div className="auth-point"><span>✓</span>Role-controlled access to requests and administration</div><div className="auth-point"><span>✓</span>Private PDF document storage and controlled retrieval</div><div className="auth-point"><span>✓</span>Workflow history, notifications and overdue reminders</div></div></div><small>Demonstration environment. Do not upload confidential or production data.</small></section>
    <section className="auth-card-wrap"><div className="auth-card"><h2>{mode === "login" ? "Sign in" : "Create account"}</h2><p>{mode === "login" ? "Use your work email to continue." : "Create a walkthrough account and start using the application."}</p><div className="auth-tabs" role="tablist"><button className={`auth-tab ${mode === "login" ? "active" : ""}`} onClick={() => { setMode("login"); setMessage(""); }}>Sign in</button><button className={`auth-tab ${mode === "register" ? "active" : ""}`} onClick={() => { setMode("register"); setMessage(""); }}>Register</button></div><form className="auth-form" onSubmit={submit}>{mode === "register" && <label className="auth-field">Full name<input name="fullName" autoComplete="name" required maxLength={120} /></label>}<label className="auth-field">Work email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label><label className="auth-field">Password<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={12} required /></label>{message && <div className={`auth-message ${isError ? "error" : ""}`}>{message}</div>}<button className="auth-submit" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}</button></form><div className="auth-footnote">The walkthrough supports self-registration. Production deployment should replace this with Microsoft Entra ID single sign-on and company-managed conditional access.</div></div></section>
  </main>;
  return <><div className="app-shell"><aside className="sidebar"><a className="brand" href="#" aria-label="Credit insurance requests home"><span className="brand-mark">CI</span><span><strong>Credit Insurance</strong><small>Request management</small></span></a><nav className="nav" aria-label="Main navigation"><button className="nav-item active" data-view="dashboard"><span className="nav-icon">O</span>Overview</button><button className="nav-item" data-view="requests"><span className="nav-icon">R</span>Requests <span id="requestCount" className="nav-count"></span></button><button className="nav-item" data-view="admin"><span className="nav-icon">A</span>Admin settings</button></nav></aside><main className="main"><header className="topbar"><div><button className="mobile-menu" id="mobileMenu" aria-label="Open navigation">Menu</button><span className="eyebrow" id="pageEyebrow">CREDIT INSURANCE</span><h1 id="pageTitle">Request overview</h1></div><div className="top-actions"><button className="icon-button" id="notificationButton" aria-label="Notifications">Alerts<span id="notificationBadge" className="notification-badge" hidden>0</span></button><button className="primary-button" id="newRequestButton">New request</button></div></header><section id="dashboardView" className="view active"></section><section id="requestsView" className="view"></section><section id="adminView" className="view"></section></main></div><div id="modalRoot"></div><div id="toastRoot" className="toast-root" aria-live="polite"></div><div className="account-strip"><div><small>Signed in</small><strong>{session.user.email}</strong></div><button onClick={() => supabase.auth.signOut()}>Sign out</button></div></>;
}
