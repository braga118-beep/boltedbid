// Data layer. Uses Supabase when config.js has keys, otherwise a demo store in localStorage.
(function () {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------------- Demo store ----------------
  const Local = {
    key: 'folio:db',
    read() { try { return JSON.parse(localStorage.getItem(this.key)); } catch (e) { return null; } },
    db() {
      let d = this.read();
      if (!d) { d = seed(); this.save(d); }
      ['companies', 'customers', 'documents', 'payments', 'events', 'items', 'photos', 'jobs'].forEach((k) => { if (!d[k]) d[k] = []; });
      d.companies.forEach((c) => { if (c.contract_after_accept === undefined) c.contract_after_accept = true; });
      if (!d.accounts) d.accounts = demoAccounts();
      if (!d.account_payments) d.account_payments = [];
      if (!d.employees) Object.assign(d, demoTeam(d));
      return d;
    },
    save(d) {
      try { localStorage.setItem(this.key, JSON.stringify(d)); }
      catch (e) { throw new Error('Demo storage in this browser is full. Delete some photos, or connect your database to store more.'); }
    },
    reset() { localStorage.removeItem(this.key); },
    async init() { this.db(); return { mode: 'demo', user: { email: 'Demo mode' } }; },
    async list(t) { return clone(this.db()[t] || []); },
    async upsert(t, obj) {
      const d = this.db();
      const arr = d[t];
      const now = new Date().toISOString();
      let row;
      const i = obj.id ? arr.findIndex((x) => x.id === obj.id) : -1;
      if (i >= 0) {
        row = arr[i] = { ...arr[i], ...obj };
      } else {
        row = { ...obj, id: obj.id || uid(), created_at: now };
        if (t === 'documents') row.public_token = row.public_token || token();
        if (t === 'events' && row.seen === undefined) row.seen = false;
        arr.push(row);
      }
      if (t === 'documents') row.updated_at = now;
      this.save(d);
      return clone(row);
    },
    async remove(t, id) {
      const d = this.db();
      d[t] = d[t].filter((x) => x.id !== id);
      if (t === 'companies') {
        const gone = new Set(d.documents.filter((x) => x.company_id === id).map((x) => x.id));
        d.documents = d.documents.filter((x) => !gone.has(x.id));
        d.payments = d.payments.filter((p) => !gone.has(p.document_id));
        d.events = d.events.filter((e) => !gone.has(e.document_id));
        d.photos = d.photos.filter((p) => !gone.has(p.document_id));
        d.items = d.items.filter((it) => it.company_id !== id);
      }
      if (t === 'documents') {
        d.payments = d.payments.filter((p) => p.document_id !== id);
        d.events = d.events.filter((e) => e.document_id !== id);
        d.photos = d.photos.filter((p) => p.document_id !== id);
      }
      if (t === 'customers') d.documents.forEach((x) => { if (x.customer_id === id) x.customer_id = null; });
      if (t === 'jobs') d.documents.forEach((x) => { if (x.job_id === id) x.job_id = null; });
      if (t === 'companies') d.jobs = d.jobs.filter((j) => j.company_id !== id);
      this.save(d);
    },
    async getPublic(tok, record = true) {
      const d = this.db();
      const doc = d.documents.find((x) => x.public_token === tok && !x.archived);
      if (!doc) return null;
      if (record && doc.status !== 'draft') {
        const now = new Date().toISOString();
        doc.viewed_at = doc.viewed_at || now;
        doc.view_count = (doc.view_count || 0) + 1;
        const recent = d.events.some((e) => e.document_id === doc.id && e.kind === 'viewed' && Date.now() - Date.parse(e.created_at) < 30 * 60e3);
        if (!recent) d.events.push({ id: uid(), document_id: doc.id, kind: 'viewed', detail: null, seen: false, created_at: now });
        this.save(d);
      }
      const company = d.companies.find((c) => c.id === doc.company_id) || {};
      const photos = doc.show_photos === false ? [] : d.photos.filter((p) => p.document_id === doc.id)
        .sort((a, b) => (a.position || 0) - (b.position || 0)).map((p) => ({ url: p.url, caption: p.caption }));
      return { document: clone(doc), company: clone(company), photos };
    },
    async accept(tok, name, selected, signature) {
      const d = this.db();
      const doc = d.documents.find((x) => x.public_token === tok && (x.type === 'estimate' || x.type === 'change_order') && x.status === 'sent');
      if (!doc) return false;
      const now = new Date().toISOString();
      if (Array.isArray(selected)) doc.items = doc.items.map((it, i) => (it.option ? { ...it, selected: selected.includes(i) } : it));
      Object.assign(doc, { status: 'accepted', accepted_at: now, accepted_by: name.slice(0, 120) });
      const coA = d.companies.find((c) => c.id === doc.company_id) || {};
      if (!signature && doc.type === 'estimate' && coA.contract_enabled && coA.contract_after_accept !== false) doc.contract_requested_at = now;
      if (signature) {
        const co = coA;
        const snapDoc = clone(doc); delete snapDoc.signature;
        doc.signature = { ...signature, name: name.slice(0, 120), signed_at: now, company: clone(co), document: snapDoc };
      }
      d.events.push({ id: uid(), document_id: doc.id, kind: 'accepted', detail: doc.accepted_by, seen: false, created_at: now });
      this.save(d);
      return true;
    },
    async signContract(tok, name, signature) {
      const d = this.db();
      const doc = d.documents.find((x) => x.public_token === tok && x.type === 'estimate' && ['accepted', 'converted'].includes(x.status) && !x.signature && x.contract_requested_at);
      if (!doc || !signature) return false;
      const now = new Date().toISOString();
      const co = d.companies.find((c) => c.id === doc.company_id) || {};
      const snapDoc = clone(doc); delete snapDoc.signature;
      doc.signature = { ...signature, name: name.slice(0, 120), signed_at: now, company: clone(co), document: snapDoc };
      d.events.push({ id: uid(), document_id: doc.id, kind: 'signed', detail: name.slice(0, 120), seen: false, created_at: now });
      this.save(d);
      return true;
    },
    async send(p) {
      const d = this.db();
      const doc = d.documents.find((x) => x.id === p.document_id);
      if (!doc) throw new Error('Document not found');
      const now = new Date().toISOString();
      doc.sent_at = doc.sent_at || now;
      doc.last_sent_at = now;
      if (doc.status === 'draft') doc.status = 'sent';
      d.events.push({ id: uid(), document_id: doc.id, kind: p.kind === 'reminder' ? 'reminder' : 'sent', detail: p.to, seen: true, created_at: now });
      this.save(d);
      return { ok: true, demo: true };
    },
    // Demo mode keeps photos inside the browser as small images.
    async uploadPhoto(docId, blob) {
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      return { path: null, url };
    },
    async removePhotoFile() {},
    async uploadContract(file) {
      if (file.size > 3 * 1024 * 1024) throw new Error('In demo mode, contract files are limited to 3 MB. Connect your database to upload up to 10 MB.');
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      return { path: null, url };
    },
    onEvent(cb) { window.addEventListener('storage', (e) => { if (e.key === this.key) cb(); }); },
    async signOut() {},
    // Accounts and the admin panel (demo: sample sign-ups, and you are the admin)
    async myAccount() { return { account: { user_id: 'demo', status: 'comped', plan: 'monthly', discount_percent: 0 }, admin: true }; },
    async adminAccounts() {
      const d = this.db();
      return d.accounts.map((a) => ({ ...a,
        total_paid: d.account_payments.filter((p) => p.user_id === a.user_id).reduce((s, p) => s + Number(p.amount || 0), 0) }));
    },
    async adminUpdate(userId, patch) {
      const d = this.db(); const a = d.accounts.find((x) => x.user_id === userId);
      if (!a) throw new Error('Account not found');
      Object.assign(a, patch, { updated_at: new Date().toISOString() }); this.save(d); return a;
    },
    async adminPayments(userId) { return this.db().account_payments.filter((p) => p.user_id === userId).sort((a, b) => (a.paid_on < b.paid_on ? 1 : -1)); },
    async adminAddPayment(p) { const d = this.db(); const row = { ...p, id: uid(), created_at: new Date().toISOString() }; d.account_payments.push(row); this.save(d); return row; },
    async adminRemovePayment(id) { const d = this.db(); d.account_payments = d.account_payments.filter((p) => p.id !== id); this.save(d); },
    // Team time clock
    async timeEntries(fromIso, toIso) { return clone(this.db().time_entries.filter((t) => t.clock_in >= fromIso && t.clock_in < toIso)); },
    async openEntries() { return clone(this.db().time_entries.filter((t) => !t.clock_out)); },
    async regenerateJoinCode(companyId) {
      const d = this.db(); const c = d.companies.find((x) => x.id === companyId);
      const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let k = ''; for (let i = 0; i < 8; i++) k += a[Math.floor(Math.random() * a.length)];
      c.join_code = k.slice(0, 4) + '-' + k.slice(4); this.save(d); return c.join_code;
    },
    async setRate(employeeId, rate) {
      const d = this.db(); const i = d.employee_pay.findIndex((x) => x.employee_id === employeeId);
      const row = { employee_id: employeeId, hourly_rate: rate, created_at: new Date().toISOString() };
      if (i >= 0) d.employee_pay[i] = row; else d.employee_pay.push(row); this.save(d); return row;
    }
  };

  function demoTeam(d) {
    const co = d.companies[0];
    if (!co) return { employees: [], employee_pay: [], time_entries: [] };
    if (!co.join_code) co.join_code = 'NRTH-7K4Q';
    const job = (d.jobs || [])[0];
    const emp = (id, full_name, phone, status, days) => ({ id, owner: 'demo', company_id: co.id, user_id: 'u-' + id, full_name, phone, email: full_name.split(' ')[0].toLowerCase() + '@example.com', status, approved_at: status === 'active' ? new Date(Date.now() - days * 86400000).toISOString() : null, created_at: new Date(Date.now() - days * 86400000).toISOString() });
    const employees = [emp('e1', 'Marco Silva', '(508) 555-0141', 'active', 90), emp('e2', 'Jake Turner', '(508) 555-0188', 'active', 60), emp('e3', 'Ana Ramos', '(401) 555-0122', 'active', 20), emp('e4', 'Kevin Doyle', '(508) 555-0175', 'pending', 0)];
    const at = (dayOffset, h, m) => { const x = new Date(); x.setHours(h, m, 0, 0); x.setDate(x.getDate() + dayOffset); return x.toISOString(); };
    const time_entries = [];
    const loc = { in_lat: 41.7015, in_lng: -71.1550, in_acc: 12, out_lat: 41.7016, out_lng: -71.1551, out_acc: 15 };
    for (let back = 13; back >= 1; back--) {
      const wd = new Date(); wd.setDate(wd.getDate() - back);
      if (wd.getDay() === 0) continue;
      [['e1', 7, 0, 15, 30], ['e2', 7, 15, 16, 0], ['e3', 8, 0, 14, 45]].forEach(([e, h1, m1, h2, m2], k) => {
        if (wd.getDay() === 6 && e !== 'e1') return;
        const x = (back * 7 + k * 3) % 11 - 5;
        time_entries.push({ id: `t-${e}-${back}`, owner: 'demo', company_id: co.id, employee_id: e, user_id: 'u-' + e, job_id: job ? job.id : null, clock_in: at(-back, h1, m1 + x), clock_out: at(-back, h2 + (e === 'e1' && back % 3 === 0 ? 1 : 0), m2 + x), ...loc, source: 'employee', created_at: at(-back, h1, m1) });
      });
    }
    time_entries.push({ id: 't-now-e1', owner: 'demo', company_id: co.id, employee_id: 'e1', user_id: 'u-e1', job_id: job ? job.id : null, clock_in: at(0, 7, 2), clock_out: null, in_lat: 41.7015, in_lng: -71.1550, in_acc: 9, source: 'employee', created_at: at(0, 7, 2) });
    time_entries.push({ id: 't-now-e2', owner: 'demo', company_id: co.id, employee_id: 'e2', user_id: 'u-e2', job_id: null, clock_in: at(0, 7, 31), clock_out: null, in_lat: 41.70, in_lng: -71.15, in_acc: 30, source: 'employee', created_at: at(0, 7, 31) });
    return { employees, employee_pay: [{ employee_id: 'e1', hourly_rate: 32, created_at: at(-90, 8, 0) }, { employee_id: 'e2', hourly_rate: 26, created_at: at(-60, 8, 0) }], time_entries };
  }

  function demoAccounts() {
    const day = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const ago = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const row = (id, full_name, company_name, email, o) => ({ user_id: id, full_name, company_name, email, plan: 'monthly', status: 'trial', trial_ends: day(20), paid_through: null, discount_percent: 0, discount_note: '', notes: '', created_at: ago(10), last_sign_in_at: ago(1), email_confirmed: true, companies: 1, estimates: 4, invoices: 2, last_activity: ago(1), ...o });
    return [
      row('a1', 'Mike Duarte', 'Duarte Roofing', 'mike@duarteroofing.example', { created_at: ago(2), trial_ends: day(28), estimates: 1, invoices: 0, last_activity: ago(0.2), last_sign_in_at: ago(0.2) }),
      row('a2', 'Sarah Kim', 'Kim Painting Co.', 'sarah@kimpainting.example', { created_at: ago(25), trial_ends: day(5), estimates: 9, invoices: 3, plan: 'yearly' }),
      row('a3', 'Tony Alves', 'Alves Carpentry', 'tony@alvescarpentry.example', { created_at: ago(70), status: 'active', paid_through: day(21), estimates: 31, invoices: 18 }),
      row('a4', 'Jen Walsh', 'Walsh Remodeling', 'jen@walshremodeling.example', { created_at: ago(140), status: 'active', plan: 'yearly', paid_through: day(225), estimates: 64, invoices: 40, discount_percent: 10, discount_note: 'Founding customer' }),
      row('a5', 'Luis Ortega', 'Ortega Concrete', 'luis@ortegaconcrete.example', { created_at: ago(40), trial_ends: day(-10), estimates: 2, invoices: 0, last_sign_in_at: ago(12), last_activity: ago(15) }),
      row('a6', 'Dana Price', 'Price Electric', 'dana@priceelectric.example', { created_at: ago(95), status: 'active', paid_through: day(-6), estimates: 22, invoices: 15 }),
      row('a7', 'Rob Lee', 'Lee Handyman', 'rob@leehandyman.example', { created_at: ago(30), status: 'comped', notes: 'Beta tester, free for a year', estimates: 12, invoices: 8 }),
      row('a8', 'Chris Hall', 'Hall Builders', 'chris@hallbuilders.example', { created_at: ago(60), status: 'revoked', notes: 'Chargeback', estimates: 3, invoices: 1 })
    ];
  }

  // When an account's trial has ended or access was paused, the database refuses changes.
  const LOCKED = 'Your BoltedBid account is read-only right now (your free trial ended or your plan is paused). You can still view and download everything. Choose a plan in Settings to keep working.';
  const locked = (e) => (e && (e.code === '42501' || /row-level security/i.test(e.message || '')) ? new Error(LOCKED) : e);

  // ---------------- Supabase ----------------
  const Remote = {
    sb: null,
    async init() {
      // Accept a pasted URL with extra parts (like /rest/v1/ or a trailing slash): keep only https://xxxx.supabase.co
      let url = String(cfg.SUPABASE_URL).trim();
      try { url = new URL(url).origin; } catch (e) { throw new Error('The SUPABASE_URL in config.js is not a valid web address.'); }
      this.sb = window.supabase.createClient(url, String(cfg.SUPABASE_ANON_KEY).trim());
      const { data } = await this.sb.auth.getSession();
      return { mode: 'cloud', user: data.session ? data.session.user : null };
    },
    async signIn(email, password) {
      const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    },
    async signUp(email, password, meta) {
      // The confirmation email opens the app itself, wherever the sign-up started.
      const { data, error } = await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: new URL('app.html', location.href).href, data: meta || {} } });
      if (error) throw error;
      return data;
    },
    async resetPassword(email) {
      const { error } = await this.sb.auth.resetPasswordForEmail(email, { redirectTo: new URL('app.html', location.href).href });
      if (error) throw error;
    },
    async updatePassword(password) {
      const { error } = await this.sb.auth.updateUser({ password });
      if (error) throw error;
    },
    async signOut() { await this.sb.auth.signOut(); },
    async myAccount() {
      const { data: s } = await this.sb.auth.getSession();
      if (!s.session) return { account: null, admin: false, missing: false };
      const r = await this.sb.from('accounts').select('*').eq('user_id', s.session.user.id).maybeSingle();
      if (r.error) return { account: null, admin: false, missing: /relation|does not exist|schema cache/i.test(r.error.message) };
      const ad = await this.sb.rpc('is_admin');
      return { account: r.data, admin: !ad.error && ad.data === true, missing: false };
    },
    async adminAccounts() {
      const { data, error } = await this.sb.rpc('admin_accounts');
      if (error) throw new Error(error.message);
      return data || [];
    },
    async adminUpdate(userId, patch) {
      // Private notes live in their own admin-only table, so the subscriber can never read them.
      const { notes, ...rest } = patch;
      let noteTable = true;
      if ('notes' in patch) {
        const n = await this.sb.from('account_notes').upsert({ user_id: userId, notes, updated_at: new Date().toISOString() });
        if (n.error) { if (/account_notes/.test(n.error.message)) { noteTable = false; rest.notes = notes; } else throw new Error(n.error.message); }
      }
      const { data, error } = await this.sb.from('accounts').update({ ...rest, updated_at: new Date().toISOString() }).eq('user_id', userId).select().single();
      if (error) throw new Error(error.message);
      return noteTable && 'notes' in patch ? { ...data, notes } : data;
    },
    async adminPayments(userId) {
      const { data, error } = await this.sb.from('account_payments').select('*').eq('user_id', userId).order('paid_on', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
    async adminAddPayment(p) {
      const { data, error } = await this.sb.from('account_payments').insert(p).select().single();
      if (error) throw new Error(error.message);
      return data;
    },
    async adminRemovePayment(id) {
      const { error } = await this.sb.from('account_payments').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    async timeEntries(fromIso, toIso) {
      const { data, error } = await this.sb.from('time_entries').select('*').gte('clock_in', fromIso).lt('clock_in', toIso).order('clock_in');
      if (error) throw error;
      return data || [];
    },
    async openEntries() {
      const { data, error } = await this.sb.from('time_entries').select('*').is('clock_out', null);
      if (error) throw error;
      return data || [];
    },
    async regenerateJoinCode(companyId) {
      const { data, error } = await this.sb.rpc('regenerate_join_code', { p_company: companyId });
      if (error) throw error;
      return data;
    },
    async setRate(employeeId, rate) {
      const { data, error } = await this.sb.from('employee_pay').upsert({ employee_id: employeeId, hourly_rate: rate }).select().single();
      if (error) throw locked(error);
      return data;
    },
    async list(t) {
      const { data, error } = await this.sb.from(t).select('*').order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
    async upsert(t, obj) {
      const o = { ...obj };
      delete o.owner;
      if (t === 'documents' || t === 'items') o.updated_at = new Date().toISOString();
      const q = o.id ? this.sb.from(t).update(o).eq('id', o.id) : this.sb.from(t).insert(o);
      const { data, error } = await q.select().single();
      if (error) throw locked(error);
      return data;
    },
    async remove(t, id) {
      const { error, count } = await this.sb.from(t).delete({ count: 'exact' }).eq('id', id);
      if (error) throw locked(error);
      if (count === 0 && t !== 'events') throw new Error(LOCKED);
    },
    async getPublic(tok, record = true) {
      const { data, error } = await this.sb.rpc('get_public_document', { p_token: tok, p_record: record });
      if (error) throw error;
      return data;
    },
    async accept(tok, name, selected, signature) {
      if (signature) {
        const r = await this.sb.rpc('accept_estimate', { p_token: tok, p_name: name, p_selected: Array.isArray(selected) ? selected : null, p_signature: signature });
        if (r.error) throw new Error(/function|signature/i.test(r.error.message) ? 'Signing is not set up yet. Run upgrade-3.sql in Supabase.' : r.error.message);
        return r.data;
      }
      if (Array.isArray(selected)) {
        const r = await this.sb.rpc('accept_estimate', { p_token: tok, p_name: name, p_selected: selected });
        if (!r.error) return r.data;
        // Database not upgraded yet: accept without saving the choices.
      }
      const { data, error } = await this.sb.rpc('accept_estimate', { p_token: tok, p_name: name });
      if (error) throw error;
      return data;
    },
    async signContract(tok, name, signature) {
      const r = await this.sb.rpc('sign_contract', { p_token: tok, p_name: name, p_signature: signature });
      if (r.error) throw new Error(/function/i.test(r.error.message) ? 'Signing is not set up yet. Run upgrade-4.sql in Supabase.' : r.error.message);
      return r.data;
    },
    async send(payload) {
      const { data, error } = await this.sb.functions.invoke('send-document', { body: payload });
      if (error) {
        let msg = error.message;
        try { const b = await error.context.json(); msg = b.error || msg; } catch (e) { /* keep message */ }
        throw new Error(msg);
      }
      if (data && data.error) throw new Error(data.error);
      return data;
    },
    async uploadPhoto(docId, blob) {
      const { data } = await this.sb.auth.getSession();
      if (!data.session) throw new Error('You are signed out. Sign in again.');
      const path = `${data.session.user.id}/${docId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await this.sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error(error.message);
      return { path, url: this.sb.storage.from('photos').getPublicUrl(path).data.publicUrl };
    },
    // Each upload gets its own file name and old files are kept, so contracts already signed
    // keep pointing at the exact file the customer signed.
    async uploadContract(file) {
      const { data } = await this.sb.auth.getSession();
      if (!data.session) throw new Error('You are signed out. Sign in again.');
      const base = (file.name || 'contract').replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'contract';
      const path = `${data.session.user.id}/${Date.now().toString(36)}-${base}.pdf`;
      const { error } = await this.sb.storage.from('contracts').upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (error) throw new Error(/bucket/i.test(error.message) ? 'Contract uploads are not set up yet. Run upgrade-6.sql in Supabase.' : error.message);
      return { path, url: this.sb.storage.from('contracts').getPublicUrl(path).data.publicUrl };
    },
    async removePhotoFile(path) {
      if (path) await this.sb.storage.from('photos').remove([path]);
    },
    onEvent(cb) {
      this.sb.channel('folio-events')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => cb())
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'documents' }, () => cb())
        .subscribe();
    }
  };

  // ---------------- Demo seed ----------------
  function seed() {
    const D = window.Doc;
    const t = D.today();
    const day = (n) => D.addDays(t, n);
    const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

    const co = {
      id: uid(), created_at: at(120), name: 'Northline Builders', email: 'office@northlinebuilders.com', phone: '(207) 555-0142',
      website: 'northlinebuilders.com', address: '214 Harbor Street, Suite 2\nPortland, ME 04101', license_no: 'License CB-20418', tax_id: '',
      logo: '', color: '#1F4E46', invoice_prefix: 'INV-', estimate_prefix: 'EST-', next_invoice_no: 5, next_estimate_no: 4,
      tax_rate: 5.5, payment_terms_days: 30, estimate_valid_days: 30,
      default_notes: 'All work performed to local code. Daily cleanup and final debris removal included.',
      default_terms: '50% deposit due on acceptance, balance due on completion. Workmanship guaranteed for one year.',
      payment_instructions: 'Check payable to Northline Builders, or Zelle to office@northlinebuilders.com.',
      change_order_prefix: 'CO-', next_change_order_no: 2,
      use_schedule: true,
      default_schedule: [
        { name: 'Deposit, due on start day', percent: 50, basis: 'all' },
        { name: 'After rough-in', percent: 25, basis: 'all' },
        { name: 'At completion', percent: 25, basis: 'all' }
      ]
    };
    const cust = (name, email, phone, address) => ({ id: uid(), created_at: at(100), name, email, phone, address, notes: '' });
    const customers = [
      cust('John Doe', 'john.doe@example.com', '(207) 555-0110', '12 Bourbon Ave\nFalmouth, ME 04105'),
      cust('Sophie Smith', 'sophie.smith@example.com', '(207) 555-0187', '48 Pine Ridge Rd\nCape Elizabeth, ME 04107'),
      cust('AB Company', 'facilities@abcompany.com', '(207) 555-0133', '900 Commerce Way, Floor 2\nSouth Portland, ME 04106'),
      cust('Jane Doe', 'jane.doe@example.com', '(207) 555-0164', '7 Willow Lane\nScarborough, ME 04074'),
      cust('Alice Jones', 'alice.jones@example.com', '(207) 555-0199', '31 Ocean View Dr\nYarmouth, ME 04096')
    ];
    const [john, sophie, ab, jane, alice] = customers;
    const L = (kind, description, qty, price, taxable = kind === 'Material') => ({ kind, description, qty, price, taxable });
    const mk = (o, c) => {
      const d = {
        id: uid(), public_token: token(), company_id: co.id, customer_id: c.id, customer_name: c.name, customer_email: c.email,
        customer_phone: c.phone, customer_address: c.address, status: 'sent', tax_rate: 5.5, discount_type: 'percent', discount_value: 0,
        notes: co.default_notes, terms: co.default_terms, amount_paid: 0, view_count: 0, archived: false, job_site: c.address, show_photos: true,
        schedule: o.type === 'estimate' ? clone(co.default_schedule) : [],
        created_at: at(o.age), updated_at: at(o.age), sent_at: o.status === 'draft' ? null : at(o.age), viewed_at: null, ...o
      };
      delete d.age;
      d.total = D.totals(d).total;
      return d;
    };

    const inv1 = mk({ age: 52, type: 'invoice', number: 'INV-0001', job_title: 'Sill plate repair', issue_date: day(-52), due_date: day(-22), viewed_at: at(51), view_count: 2,
      items: [L('Labor', 'Replace rotted sill plate and rim joist along east wall', 16, 85), L('Material', 'Pressure-treated lumber, sill seal, fasteners', 1, 640)] }, john);
    inv1.amount_paid = inv1.total;
    const inv2 = mk({ age: 20, type: 'invoice', number: 'INV-0002', job_title: 'Kitchen remodel, phase 1', issue_date: day(-20), due_date: day(10), viewed_at: at(19), view_count: 3, amount_paid: 4000,
      items: [L('Labor', 'Demolition and haul-away of existing cabinets, counters and flooring', 24, 85), L('Subcontract', 'Electrical rough-in by licensed electrician', 1, 1850, false), L('Material', 'Shaker cabinets, white oak, per approved layout', 1, 6400)] }, sophie);
    const inv3 = mk({ age: 45, type: 'invoice', number: 'INV-0003', job_title: 'Office partition walls', issue_date: day(-45), due_date: day(-15),
      items: [L('Service', 'Frame, hang and finish partition walls for three offices', 1, 5200, false), L('Material', 'Steel studs, drywall, compound and trim', 1, 1000)] }, ab);
    const est1 = mk({ age: 9, type: 'estimate', number: 'EST-0001', job_title: 'Primary bathroom remodel', issue_date: day(-9), due_date: day(21), status: 'accepted',
      viewed_at: at(8), view_count: 2, accepted_at: at(5), accepted_by: 'Jane Doe',
      items: [L('Labor', 'Demolition, framing adjustments and waterproofing', 40, 85), L('Material', 'Porcelain tile, schluter trim, setting materials', 1, 2350), L('Subcontract', 'Plumbing: relocate shower valve, set vanity and toilet', 1, 2200, false)] }, jane);
    const inv4 = mk({ age: 3, type: 'invoice', number: 'INV-0004', job_title: 'Primary bathroom remodel, deposit', issue_date: day(-3), due_date: day(27), status: 'draft',
      items: [L('Service', '50% deposit per accepted estimate EST-0001', 1, 4100, false)] }, jane);
    inv4.source_id = est1.id;
    const est2 = mk({ age: 1, type: 'estimate', number: 'EST-0002', job_title: 'Second-floor build-out', issue_date: day(-1), due_date: day(29), viewed_at: at(0.04), view_count: 1,
      items: [L('Labor', 'Layout, framing and drywall for open office and two meeting rooms', 120, 85), L('Material', 'Framing lumber, drywall, insulation and acoustic batts', 1, 7800), L('Subcontract', 'HVAC branch ducts and diffusers', 1, 6400, false)] }, ab);
    const est3 = mk({ age: 0, type: 'estimate', number: 'EST-0003', job_title: 'Deck replacement', issue_date: t, due_date: day(30), status: 'draft',
      items: [L('Labor', 'Remove existing deck and footings; install new helical piers', 32, 85),
        { ...L('Material', 'Composite decking, standard color line, with PT framing and hidden fasteners', 1, 9200), option: 'choice', group: 'Decking', selected: true },
        { ...L('Material', 'Composite decking, premium capped line with 50-year warranty, PT framing and hidden fasteners', 1, 11800), option: 'choice', group: 'Decking', selected: false },
        { ...L('Service', 'Upgrade to black aluminum cable railing, 36 linear ft', 1, 2400), option: 'addon', selected: false },
        { ...L('Service', 'Low-voltage post-cap lighting, 8 lights with timer', 1, 950), option: 'addon', selected: false }] }, alice);
    est3.total = D.totals(est3).total;

    // Jobs group each project's estimate, change orders and invoices.
    const job = (name, c, status, age) => ({ id: uid(), created_at: at(age), company_id: co.id, customer_id: c.id, name, address: c.address, status, notes: '' });
    const jobs = [
      job('Sill plate repair', john, 'completed', 52), job('Kitchen remodel', sophie, 'active', 22), job('Office partition walls', ab, 'completed', 45),
      job('Primary bathroom remodel', jane, 'active', 9), job('Second-floor build-out', ab, 'estimating', 1), job('Deck replacement', alice, 'estimating', 0)
    ];
    [[inv1, 0], [inv2, 1], [inv3, 2], [est1, 3], [inv4, 3], [est2, 4], [est3, 5]].forEach(([d, j]) => (d.job_id = jobs[j].id));
    inv4.milestone_index = 0; inv4.milestone_name = 'Deposit, due on start day';
    const co1 = mk({ age: 2, type: 'change_order', number: 'CO-0001', job_title: 'Primary bathroom remodel', issue_date: day(-2), due_date: day(28), schedule: [],
      notes: 'Requested by the homeowner during demolition.',
      items: [L('Material', 'Electric radiant floor heating mat, 40 sq ft, with programmable thermostat', 1, 780), L('Labor', 'Install heating mat and thermostat; electrician hookup', 6, 85)] }, jane);
    co1.job_id = jobs[3].id; co1.source_id = est1.id;
    co1.contract = { original: est1.total, prior: 0, ref: est1.number };

    const ev = (doc, kind, daysAgo, seen = true, detail = null) => ({ id: uid(), document_id: doc.id, kind, detail, seen, created_at: at(daysAgo) });
    const item = (name, kind, unit, price, description = '') => ({ id: uid(), created_at: at(60), updated_at: at(60), company_id: null, name, kind, unit, price, description });
    const items = [
      item('Tiled shower niche', 'Service', 'each', 450, 'Frame, waterproof and tile a 12 x 24 in. recessed niche, with a sloped sill and trim edges'),
      item('Carpenter labor', 'Labor', 'hour', 85),
      item('Drywall, hang and finish', 'Service', 'sq ft', 3.25, 'Hang, tape and finish to a level 4 finish, ready for paint'),
      item('Interior painting, walls', 'Service', 'sq ft', 2.5, 'Prime and two finish coats, customer-selected color'),
      item('Dumpster rental, 20 yard', 'Equipment', 'each', 650, 'Delivery, one week on site, haul-away and disposal fees'),
      item('Building permit', 'Permit', 'each', 250, 'Permit filing and inspection fees')
    ];
    return {
      items,
      photos: [],
      companies: [co],
      customers,
      jobs,
      documents: [inv1, inv2, inv3, est1, inv4, est2, est3, co1],
      payments: [
        { id: uid(), document_id: inv1.id, amount: inv1.total, paid_on: day(-30), method: 'Check', reference: '1042', note: '', created_at: at(30) },
        { id: uid(), document_id: inv2.id, amount: 4000, paid_on: day(-18), method: 'Zelle', reference: '', note: 'Deposit', created_at: at(18) }
      ],
      events: [
        ev(inv1, 'sent', 52, true, john.email), ev(inv1, 'viewed', 51), ev(inv1, 'paid', 30, true, String(inv1.total)),
        ev(inv3, 'sent', 45, true, ab.email),
        ev(inv2, 'sent', 20, true, sophie.email), ev(inv2, 'viewed', 19), ev(inv2, 'paid', 18, true, '4000'),
        ev(est1, 'sent', 9, true, jane.email), ev(est1, 'viewed', 8), ev(est1, 'accepted', 5, true, 'Jane Doe'),
        ev(est2, 'sent', 1, true, ab.email), ev(est2, 'viewed', 0.04, false), ev(co1, 'sent', 2, true, jane.email)
      ]
    };
  }

  const configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  if (configured && !window.supabase) {
    // Keys are set but the Supabase library didn't load: show an error instead of silently using demo mode.
    window.Store = { init: async () => { throw new Error('The Supabase library did not load. Check your internet connection and refresh the page.'); } };
  } else {
    window.Store = configured ? Remote : Local;
  }
})();
