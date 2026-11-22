  (function () {
    const $ = (s, el = document) => el.querySelector(s);
    const main = $('#main');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (t) => { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3500); };
    const cfg = window.APP_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { main.innerHTML = '<div class="card"><h2>Time clock</h2><p class="sub">The time clock works on boltedbid.com once the database is connected.</p></div>'; return; }
    const sb = window.supabase.createClient(new URL(String(cfg.SUPABASE_URL).trim()).origin, String(cfg.SUPABASE_ANON_KEY).trim());
    const here = new URL('team.html', location.href).href;
    let user = null, team = null, tick = null;

    const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const hm = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
    const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    const friendly = (e) => {
      const m = (e && e.message) || String(e);
      if (/invalid login/i.test(m)) return 'That email and password don\'t match.';
      if (/already registered/i.test(m)) return 'That email already has an account. Sign in instead.';
      if (/email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link.';
      if (/signups not allowed/i.test(m)) return 'New sign-ups are turned off right now. Please tell your employer.';
      return m;
    };
    const say = (el, t, ok) => { el.textContent = t; el.className = 'msg ' + (ok ? 'ok' : 'err'); };

    // Location: asked for at each punch so your employer can confirm you were on site.
    const where = () => new Promise((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });

    // ---------- Sign in / create employee account ----------
    function authView(mode = 'up', note = '', ok = false) {
      $('#out').hidden = true;
      const code = new URLSearchParams(location.search).get('code') || '';
      main.innerHTML = `
        <div class="card">
          <h1 style="font-size:24px">${mode === 'up' ? 'Employee sign up' : 'Employee sign in'}</h1>
          <p class="sub" style="margin:6px 0 18px">${mode === 'up' ? 'Create your login to punch in and out. Ask your employer for the company code.' : 'Sign in to punch in and out.'}</p>
          <div class="seg" role="tablist"><button type="button" data-m="up" aria-selected="${mode === 'up'}">Create account</button><button type="button" data-m="in" aria-selected="${mode === 'in'}">Sign in</button></div>
          <form id="f" novalidate>
            ${mode === 'up' ? `<label>Company code<input name="code" required autocapitalize="characters" autocomplete="off" placeholder="ABCD-1234" value="${esc(code)}"></label>
            <label>Your full name<input name="name" required autocomplete="name"></label>
            <label>Phone<input name="phone" type="tel" autocomplete="tel"></label>` : ''}
            <label>Email<input name="email" type="email" required autocomplete="email"></label>
            <label>Password<input name="password" type="password" required minlength="8" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" ${mode === 'up' ? 'placeholder="At least 8 characters"' : ''}></label>
            <button class="btn primary wide" type="submit">${mode === 'up' ? 'Create my account' : 'Sign in'}</button>
            <p class="msg ${ok ? 'ok' : 'err'}" id="m">${esc(note)}</p>
            ${mode === 'in' ? '<p class="center"><button type="button" class="link" id="fp">Forgot your password?</button></p>' : ''}
          </form>
        </div>
        <p class="sub center">Business owner? <a href="./">Go to BoltedBid</a></p>`;
      main.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => authView(b.dataset.m)));
      const f = $('#f'), m = $('#m');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(f));
        const b = f.querySelector('button[type=submit]'); b.disabled = true;
        try {
          if (mode === 'up') {
            if (!String(v.code || '').trim()) throw new Error('Enter the company code from your employer.');
            if (!String(v.name || '').trim()) throw new Error('Enter your name.');
            if (String(v.password).length < 8) throw new Error('Use a password with at least 8 characters.');
            const r = await sb.auth.signUp({ email: v.email.trim(), password: v.password, options: { emailRedirectTo: here, data: { role: 'employee', full_name: v.name.trim(), phone: (v.phone || '').trim(), join_code: v.code.trim().toUpperCase() } } });
            if (r.error) throw r.error;
            if (!r.data.session) { authView('in', 'Almost done. Check your email and tap the confirmation link, then sign in here.', true); return; }
          } else {
            const r = await sb.auth.signInWithPassword({ email: v.email.trim(), password: v.password });
            if (r.error) throw r.error;
          }
          await start();
        } catch (err) { say(m, friendly(err)); b.disabled = false; }
      };
      if ($('#fp')) $('#fp').onclick = async () => {
        const email = f.email.value.trim();
        if (!email) { say(m, 'Type your email above first.'); return; }
        const r = await sb.auth.resetPasswordForEmail(email, { redirectTo: here });
        if (r.error) say(m, friendly(r.error)); else say(m, 'Check your email for a link to choose a new password.', true);
      };
    }

    function newPasswordView() {
      main.innerHTML = `<div class="card"><h1 style="font-size:24px">Choose a new password</h1><form id="np" style="margin-top:16px"><label>New password<input type="password" name="p" minlength="8" required autocomplete="new-password"></label><button class="btn primary wide">Save password</button><p class="msg" id="m"></p></form></div>`;
      $('#np').onsubmit = async (e) => {
        e.preventDefault();
        const r = await sb.auth.updateUser({ password: e.target.p.value });
        if (r.error) say($('#m'), friendly(r.error)); else { toast('Password saved'); start(); }
      };
    }

    // ---------- Join a company ----------
    function joinView(note) {
      const meta = (user && user.user_metadata) || {};
      main.innerHTML = `<div class="card"><h1 style="font-size:24px">Join your company</h1><p class="sub" style="margin:6px 0 16px">Enter the code your employer gave you.</p>
        <form id="j"><label>Company code<input name="code" required autocapitalize="characters" placeholder="ABCD-1234" value="${esc(meta.join_code || '')}"></label>
        <label>Your full name<input name="name" required value="${esc(meta.full_name || '')}"></label><label>Phone<input name="phone" type="tel" value="${esc(meta.phone || '')}"></label>
        <button class="btn primary wide">Join</button><p class="msg err" id="m">${esc(note || '')}</p></form></div>`;
      $('#j').onsubmit = async (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(e.target));
        const r = await sb.rpc('join_company', { p_code: v.code, p_name: v.name, p_phone: v.phone });
        if (r.error) { say($('#m'), friendly(r.error)); return; }
        start();
      };
    }

    // ---------- Punch clock ----------
    async function clockView() {
      const e = team.employee, c = team.company;
      const name = (e.name || '').split(' ')[0];
      if (e.status === 'pending') {
        main.innerHTML = `<div class="card hello"><h1>Hi ${esc(name)}</h1><div class="co">${c.logo ? `<span class="logo" style="background-image:url('${esc(c.logo)}')"></span>` : ''}${esc(c.name)}</div></div>
          <div class="note">You've asked to join <b>${esc(c.name)}</b>. You can punch in as soon as they approve you.</div>
          <button class="btn wide" id="re">Check again</button>
          ${(isIOS || isAndroid) && !standalone() ? '<button class="btn wide" id="getApp">Install the Time Clock app</button>' : ''}`;
        $('#re').onclick = start;
        if ($('#getApp')) $('#getApp').onclick = () => { try { sessionStorage.removeItem(skipKey); } catch (e) { /* ignore */ } installView(); };
        return;
      }
      if (e.status === 'removed') {
        main.innerHTML = `<div class="card"><h1 style="font-size:24px">You're no longer on ${esc(c.name)}'s team</h1><p class="sub" style="margin-top:8px">If this is a mistake, talk to your employer. To join another company, use its code.</p><button class="btn wide" id="jn" style="margin-top:16px">Join with a code</button></div>`;
        $('#jn').onclick = () => joinView(); return;
      }
      // This week's and recent shifts
      const now = new Date();
      const wk = new Date(now); wk.setHours(0, 0, 0, 0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7)); // Monday
      const since = new Date(wk); since.setDate(since.getDate() - 14);
      const { data: rows } = await sb.from('time_entries').select('*').eq('employee_id', e.id).gte('clock_in', since.toISOString()).order('clock_in', { ascending: false });
      const list = rows || [];
      const dur = (t) => (t.clock_out ? new Date(t.clock_out) : new Date()) - new Date(t.clock_in);
      const weekMs = () => list.filter((t) => new Date(t.clock_in) >= wk).reduce((s, t) => s + dur(t), 0);
      const todayMs = () => { const d0 = new Date(); d0.setHours(0, 0, 0, 0); return list.filter((t) => new Date(t.clock_in) >= d0).reduce((s, t) => s + dur(t), 0); };
      const open = team.open;
      const jobName = (id) => (team.jobs.find((j) => j.id === id) || {}).name;
      main.innerHTML = `
        <div class="card hello"><h1>Hi ${esc(name)}</h1><div class="co">${c.logo ? `<span class="logo" style="background-image:url('${esc(c.logo)}')"></span>` : ''}${esc(c.name)}</div></div>
        ${team.company_active ? '' : '<div class="note">Punching in is paused for this company right now. Please tell your employer.</div>'}
        <div class="card clock">
          <span class="state ${open ? 'on' : ''}">${open ? 'On the clock' : 'Off the clock'}</span>
          <div class="timer" id="tm">${open ? hms(Date.now() - new Date(open.clock_in)) : '0:00:00'}</div>
          <p class="since">${open ? `Since ${esc(fmtTime(open.clock_in))}, ${esc(fmtDay(open.clock_in))}${open.job_id && jobName(open.job_id) ? ` · ${esc(jobName(open.job_id))}` : ''}` : 'Tap below when you start working.'}</p>
          ${!open && team.jobs.length ? `<select id="job" aria-label="Job"><option value="">Which job? (optional)</option>${team.jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.name)}${j.address ? ' · ' + esc(j.address.split('\n')[0]) : ''}</option>`).join('')}</select>` : ''}
          <button class="punch ${open ? 'out' : ''}" id="pb" ${team.company_active || open ? '' : 'disabled'}>${open ? 'Punch out' : 'Punch in'}</button>
          <p class="loc">Your location is recorded when you punch in and out, so your employer can confirm the job site.</p>
        </div>
        ${(isIOS || isAndroid) && !standalone() ? '<div class="card" style="display:flex;align-items:center;gap:12px;padding:14px 16px"><img src="icons/icon-192.png" alt="" style="width:40px;height:40px;border-radius:10px"><div style="flex:1"><b>Get the Time Clock app</b><div class="sub">Punch in from your home screen.</div></div><button class="btn" id="getApp" style="min-height:42px">Install</button></div>' : ''}
        <div class="stats"><div class="stat"><span>Today</span><b id="td">${hm(todayMs())}</b></div><div class="stat"><span>This week</span><b id="tw">${hm(weekMs())}</b></div></div>
        <div class="card"><h3>Recent shifts</h3>
          <ul class="shifts">${list.length ? list.slice(0, 20).map((t) => `<li><div><div class="d">${esc(fmtDay(t.clock_in))}</div><div class="sub">${esc(fmtTime(t.clock_in))} – ${t.clock_out ? esc(fmtTime(t.clock_out)) : 'now'}${t.job_id && jobName(t.job_id) ? ' · ' + esc(jobName(t.job_id)) : ''}</div></div><div class="h">${hm(dur(t))}</div></li>`).join('') : '<li class="sub">No shifts yet.</li>'}</ul>
        </div>`;
      if ($('#getApp')) $('#getApp').onclick = () => { try { sessionStorage.removeItem(skipKey); } catch (e) { /* ignore */ } installView(); };
      clearInterval(tick);
      if (open) tick = setInterval(() => { $('#tm').textContent = hms(Date.now() - new Date(open.clock_in)); $('#td').textContent = hm(todayMs()); $('#tw').textContent = hm(weekMs()); }, 1000);
      $('#pb').onclick = async () => {
        const b = $('#pb'); b.disabled = true; b.textContent = 'Getting your location';
        const loc = await where();
        b.textContent = open ? 'Punching out' : 'Punching in';
        const r = open
          ? await sb.rpc('punch_out', { p_lat: loc && loc.lat, p_lng: loc && loc.lng, p_acc: loc && loc.acc, p_note: null })
          : await sb.rpc('punch_in', { p_job: ($('#job') && $('#job').value) || null, p_lat: loc && loc.lat, p_lng: loc && loc.lng, p_acc: loc && loc.acc });
        if (r.error) { toast(friendly(r.error)); start(); return; }
        if (navigator.vibrate) navigator.vibrate(40);
        toast(open ? `Punched out at ${fmtTime(r.data.clock_out)}` : `Punched in at ${fmtTime(r.data.clock_in)}`);
        start();
      };
    }

    // ---------- Install the app (iPhone, iPad, Android) ----------
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|GSA\/|; wv\)/i.test(ua);
    const iosSafari = isIOS && !/CriOS|FxiOS|EdgiOS/i.test(ua);
    const skipKey = 'bb-skip-install';
    const skipped = () => { try { return sessionStorage.getItem(skipKey) === '1'; } catch (e) { return false; } };
    const share = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    const plusBox = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

    async function installView() {
      $('#out').hidden = true;
      const { data: s0 } = await sb.auth.getSession();
      const signedIn = !!s0.session;
      const finish = signedIn ? 'and sign in there' : 'and sign up there';
      const code = new URLSearchParams(location.search).get('code') || '';
      const chip = code ? `<p class="sub" style="margin-bottom:16px">Your company code is <span class="codechip">${esc(code.toUpperCase())}</span>${isIOS ? '. It will be filled in for you.' : ''}</p>` : '';
      let body = '';
      if (inAppBrowser) {
        body = `<h1>Open this in ${isIOS ? 'Safari' : 'Chrome'}</h1>
          <p class="lead">This link opened inside another app. To install the Time Clock, open it in your phone's browser.</p>
          <ol class="steps"><li><span>Tap the <b>⋯</b> or <b>⋮</b> menu at the top or bottom of this screen</span></li><li><span>Tap <b>Open in ${isIOS ? 'Safari' : 'Chrome'}</b> (or "Open in browser")</span></li></ol>
          <button class="btn wide" id="cp">Copy this link instead</button>`;
      } else if (isIOS && !iosSafari) {
        body = `<h1>Add the Time Clock to your home screen</h1><p class="lead">Free, takes 10 seconds, no App Store needed.</p>
          <ol class="steps"><li><span>Tap the Share button ${share} in the address bar</span></li><li><span>Scroll down and tap <b>Add to Home Screen</b> ${plusBox}</span></li><li><span>Tap <b>Add</b>, then open <b>Time Clock</b> from your home screen</span></li></ol>
          <p class="sub">Don't see it? Open this page in <b>Safari</b> and try again.</p>`;
      } else if (isIOS) {
        body = `<h1>Add the Time Clock to your home screen</h1><p class="lead">Free, takes 10 seconds, no App Store needed.</p>
          <ol class="steps"><li><span>Tap the Share button ${share} at the bottom of Safari</span></li><li><span>Scroll down and tap <b>Add to Home Screen</b> ${plusBox}</span></li><li><span>Tap <b>Add</b>, then open <b>Time Clock</b> from your home screen ${finish}</span></li></ol>`;
      } else {
        body = `<h1>Install the Time Clock app</h1><p class="lead">Free, takes 10 seconds, no Play Store needed.</p>
          <button class="btn primary wide" id="inst" ${window.__bip ? '' : 'hidden'}>Install the app</button>
          <ol class="steps" id="manual" ${window.__bip ? 'hidden' : ''}><li><span>Tap the <b>⋮</b> menu at the top right of Chrome</span></li><li><span>Tap <b>Install app</b> or <b>Add to Home screen</b></span></li><li><span>Open <b>Time Clock</b> from your home screen ${finish}</span></li></ol>
          <p class="sub" id="manualNote" ${window.__bip ? 'hidden' : ''}>Opened this by scanning a QR code and don't see <b>Install app</b>? Tap <b>⋮</b> → <b>Open in Chrome</b> first.</p>`;
      }
      main.innerHTML = `<div class="card install"><img class="icon" src="icons/icon-192.png" alt="Time Clock app icon">${body}${chip}
        <p><button class="link" id="skip">Continue in the browser instead</button></p></div>
        ${isIOS && iosSafari && !inAppBrowser ? `<div class="arrow" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M6 13l6 6 6-6"/></svg></div>` : ''}`;
      $('#skip').onclick = () => { try { sessionStorage.setItem(skipKey, '1'); } catch (e) { /* ignore */ } start(); };
      if (signedIn && isIOS) main.insertAdjacentHTML('beforeend', '<p class="sub center">On iPhone, the app keeps its own sign-in, so you\'ll sign in once more inside it.</p>');
      if ($('#cp')) $('#cp').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied. Paste it in ' + (isIOS ? 'Safari' : 'Chrome') + '.'); } catch (e) { prompt('Copy this link:', location.href); } };
      const showBtn = () => { if ($('#inst')) { $('#inst').hidden = false; $('#manual').hidden = true; if ($('#manualNote')) $('#manualNote').hidden = true; } };
      document.addEventListener('bip', showBtn, { once: true });
      if ($('#inst')) $('#inst').onclick = async () => {
        const e = window.__bip; if (!e) return;
        e.prompt();
        const r = await e.userChoice;
        window.__bip = null;
        if (r.outcome === 'accepted') main.innerHTML = '<div class="card install"><img class="icon" src="icons/icon-192.png" alt=""><h1>Installed</h1><p class="lead">Open <b>Time Clock</b> from your home screen to sign up and punch in.</p><p><button class="link" id="skip2">Or continue here</button></p></div>';
        if ($('#skip2')) $('#skip2').onclick = () => { try { sessionStorage.setItem(skipKey, '1'); } catch (er) { /* ignore */ } start(); };
      };
    }
    window.addEventListener('appinstalled', () => toast('Time Clock installed. Open it from your home screen.'));

    async function start() {
      clearInterval(tick);
      if ((isIOS || isAndroid) && !standalone() && !skipped()) return installView();
      const { data } = await sb.auth.getSession();
      user = data.session && data.session.user;
      if (!user) return authView(new URLSearchParams(location.search).get('code') ? 'up' : 'in');
      $('#out').hidden = false;
      const r = await sb.rpc('my_team');
      if (r.error) { main.innerHTML = `<div class="card"><p class="msg err">${esc(/function/i.test(r.error.message) ? 'The time clock isn\'t set up yet. Please tell your employer.' : r.error.message)}</p></div>`; return; }
      team = r.data;
      if (!team.joined) {
        // Just signed up: join the company from the code they entered.
        const meta = user.user_metadata || {};
        if (meta.join_code) {
          const j = await sb.rpc('join_company', { p_code: meta.join_code, p_name: meta.full_name || '', p_phone: meta.phone || '' });
          if (!j.error) return start();
          return joinView(friendly(j.error));
        }
        if (meta.role !== 'employee') {
          main.innerHTML = `<div class="card"><h1 style="font-size:22px">This page is for employees</h1><p class="sub" style="margin:8px 0 16px">You're signed in with a BoltedBid business account.</p><a class="btn primary wide" href="app.html#/team">Open your Team page</a><p class="center" style="margin-top:12px"><button class="link" id="jn">I'm an employee, join with a code</button></p></div>`;
          $('#jn').onclick = () => joinView(); return;
        }
        return joinView();
      }
      clockView();
    }

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
    $('#out').onclick = async () => { await sb.auth.signOut(); location.replace('team.html'); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden && user) start(); });
    const recovering = /type=recovery/.test(location.hash);
    sb.auth.getSession().then(() => { if (recovering) { history.replaceState(null, '', 'team.html'); newPasswordView(); } else { if (/access_token=/.test(location.hash)) history.replaceState(null, '', 'team.html'); start(); } });
  })();
  
