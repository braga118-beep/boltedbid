  (function () {
    // ---- Payment links live in plans.js (one place for the front page and the app).
    // While they're empty, the pricing buttons take people to "Create account" with that plan chosen.
    const P = window.BB_PLANS || {};
    const PAYMENT_LINKS = { monthly: (P.monthly && P.monthly.link) || '', yearly: (P.yearly && P.yearly.link) || '' };

    const $ = (s, el = document) => el.querySelector(s);
    const $$ = (s, el = document) => [...el.querySelectorAll(s)];
    $('#yr').textContent = new Date().getFullYear();

    // Mobile menu
    const menu = $('#mobileMenu'), mb = $('#menuBtn');
    mb.onclick = () => { const on = menu.classList.toggle('on'); mb.setAttribute('aria-expanded', on); };
    $$('#mobileMenu a').forEach((a) => a.addEventListener('click', () => { menu.classList.remove('on'); mb.setAttribute('aria-expanded', 'false'); }));

    // Video lightbox
    const lb = $('#lightbox'), lv = $('#lbVideo');
    const openLb = () => { lb.classList.add('on'); lv.currentTime = 0; lv.play().catch(() => {}); };
    const closeLb = () => { lv.pause(); lb.classList.remove('on'); };
    $('#watch').onclick = openLb; $('#watch2').onclick = openLb;
    $('#lbClose').onclick = closeLb;
    lb.addEventListener('click', (e) => { if (e.target === lb) closeLb(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lb.classList.contains('on')) closeLb(); });

    // Feature tabs: click, arrow keys, and a gentle auto-advance until someone interacts.
    const tabs = $$('.tab'), desc = $('#tabDesc');
    let cur = 0, timer = null, auto = true;
    function show(i, focus) {
      cur = (i + tabs.length) % tabs.length;
      tabs.forEach((t, k) => {
        const on = k === cur;
        t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
        t.classList.toggle('auto', on && auto);
        const p = document.getElementById(t.getAttribute('aria-controls'));
        p.hidden = !on; p.classList.toggle('on', on);
      });
      desc.textContent = tabs[cur].dataset.desc;
      if (focus) tabs[cur].focus();
      clearTimeout(timer);
      if (auto) timer = setTimeout(() => show(cur + 1), 7000);
    }
    const stopAuto = () => { auto = false; clearTimeout(timer); tabs.forEach((t) => t.classList.remove('auto')); };
    tabs.forEach((t, i) => {
      t.onclick = () => { stopAuto(); show(i); };
      t.onkeydown = (e) => {
        if (['ArrowDown', 'ArrowRight'].includes(e.key)) { e.preventDefault(); stopAuto(); show(cur + 1, true); }
        if (['ArrowUp', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); stopAuto(); show(cur - 1, true); }
      };
    });
    // Only auto-advance while the feature tour is on screen.
    const tourIO = new IntersectionObserver(([e]) => { if (!auto) return; if (e.isIntersecting) show(cur); else clearTimeout(timer); }, { threshold: 0.35 });
    tourIO.observe($('.tour'));
    show(0);

    // Reveal on scroll
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
    $$('.reveal').forEach((el) => io.observe(el));

    // ---- Account: create account, sign in, forgot password
    const upF = $('#upForm'), inF = $('#inForm'), segBtns = $$('.seg button');
    function mode(m) {
      segBtns.forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === m));
      upF.hidden = m !== 'up'; inF.hidden = m !== 'in';
      $('#acctTitle').textContent = m === 'up' ? 'Start your 30-day free trial' : 'Welcome back';
    }
    segBtns.forEach((b) => (b.onclick = () => mode(b.dataset.mode)));
    $$('[data-auth]').forEach((a) => a.addEventListener('click', (e) => {
      const plan = a.dataset.plan;
      if (plan && PAYMENT_LINKS[plan] && signedInUser) { e.preventDefault(); location.href = PAYMENT_LINKS[plan]; return; }
      if (signedInUser && a.dataset.auth === 'in') { e.preventDefault(); location.href = 'app.html#/dashboard'; return; }
      mode(a.dataset.auth);
      if (plan === 'monthly' || plan === 'yearly') { const r = upF.querySelector(`input[value=${plan}]`); if (r) r.checked = true; }
      setTimeout(() => { const f = (a.dataset.auth === 'up' ? upF : inF).querySelector('input'); if (f && !signedInUser) f.focus({ preventScroll: true }); }, 450);
    }));

    const cfg = window.APP_CONFIG || {};
    const cloud = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
    let signedInUser = null;
    const say = (el, text, ok) => { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); };
    const friendly = (err) => {
      const m = (err && err.message) || String(err);
      if (/invalid login/i.test(m)) return 'That email and password don\'t match. Try again, or reset your password.';
      if (/already registered/i.test(m)) return 'That email already has an account. Sign in instead.';
      if (/email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link we sent.';
      if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
      return m;
    };
    function showSignedIn(user) {
      signedInUser = user;
      $('#whoami').textContent = user.email;
      $('#signedIn').hidden = false; upF.hidden = true; inF.hidden = true; $('.seg').hidden = true;
      $('#acctTitle').textContent = 'Welcome back';
      $$('[data-auth="in"]').forEach((a) => { a.textContent = 'Open BoltedBid'; a.href = 'app.html#/dashboard'; });
    }

    let ready = (async () => {
      if (!cloud) return; // demo copy of the site: the app runs in demo mode
      try { const r = await window.Store.init(); if (r.user) showSignedIn(r.user); } catch (e) { /* page still works; forms will show the error */ }
    })();

    upF.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(upF), msg = $('#upMsg'), b = upF.querySelector('button[type=submit]');
      const email = String(f.get('email') || '').trim(), pw = String(f.get('password') || '');
      if (!String(f.get('name') || '').trim()) return say(msg, 'Please add your name.');
      if (!/^\S+@\S+\.\S+$/.test(email)) return say(msg, 'Please enter a valid email.');
      if (pw.length < 8) return say(msg, 'Use a password with at least 8 characters.');
      if (!cloud) { location.href = 'app.html'; return; }
      b.disabled = true; b.textContent = 'Creating your account';
      try {
        await ready;
        const trialEnds = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        const r = await window.Store.signUp(email, pw, { full_name: String(f.get('name')).trim(), company_name: String(f.get('company') || '').trim(), plan: f.get('plan'), trial_ends: trialEnds });
        if (r.session) { location.href = 'app.html#/company/new'; return; }
        upF.reset();
        say(msg, 'Almost done. Check your email and tap the link to confirm your account.', true);
      } catch (err) { say(msg, friendly(err)); }
      b.disabled = false; b.textContent = 'Start my free trial';
    };

    inF.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(inF), msg = $('#inMsg'), b = inF.querySelector('button[type=submit]');
      if (!cloud) { location.href = 'app.html'; return; }
      b.disabled = true; b.textContent = 'Signing in';
      try { await ready; await window.Store.signIn(String(f.get('email')).trim(), String(f.get('password'))); location.href = 'app.html#/dashboard'; return; }
      catch (err) { say(msg, friendly(err)); }
      b.disabled = false; b.textContent = 'Sign in';
    };

    $('#forgot').onclick = async () => {
      const email = String(inF.email.value || '').trim(), msg = $('#inMsg');
      if (!/^\S+@\S+\.\S+$/.test(email)) { say(msg, 'Type your email above, then tap "Forgot your password?" again.'); inF.email.focus(); return; }
      if (!cloud) return;
      try { await ready; await window.Store.resetPassword(email); say(msg, 'Check your email for a link to choose a new password.', true); }
      catch (err) { say(msg, friendly(err)); }
    };

    $('#signOut').onclick = async () => { try { await window.Store.signOut(); } catch (e) { /* ignore */ } location.reload(); };
  })();
  
