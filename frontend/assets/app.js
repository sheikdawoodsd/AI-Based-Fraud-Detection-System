(async function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const view = $('#view');
  const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABEL = { normal: 'Looks safe', review: 'Needs review', suspicious: 'Likely fraud' };
  const COLOR = { normal: 'var(--ok)', review: 'var(--warn)', suspicious: 'var(--bad)' };
  const HEX = { normal: '#3FD9A8', review: '#FFB84D', suspicious: '#FF5D73' };
  const TYPE_NAME = { upi: 'UPI', card_online: 'Card (online)', card_pos: 'Card (in store)', net_banking: 'Net banking', wallet: 'Wallet', atm_withdrawal: 'ATM withdrawal' };
  const MERCH_NAME = { grocery: 'Grocery', food: 'Food and dining', travel: 'Travel', electronics: 'Electronics', jewellery: 'Jewellery', gaming: 'Gaming', crypto: 'Crypto', utilities: 'Bills and utilities', other: 'Other' };
  const IC = {
    ok: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    review: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    bad: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m10 9.5 4 4m0-4-4 4"/>',
    up: '<path d="M7 17 17 7M7 7h10v10"/>', down: '<path d="M7 7l10 10M17 7v10H7"/>', flat: '<path d="M5 12h14"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M17.9 17.9A10.7 10.7 0 0 1 12 19c-6.4 0-10-7-10-7a18 18 0 0 1 4.1-5M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.2M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    right: '<path d="M5 12h14M13 6l6 6-6 6"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>', shield: '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>'
  };
  const ico = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;
  const vIcon = v => ico(v === 'normal' ? 'ok' : v === 'review' ? 'review' : 'bad');

  let sb, cfg, session, cache = null;

  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 3400);
  }
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { } }
  };

  async function api(path, opts = {}) {
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    const r = await fetch('/api' + path, {
      ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
    });
    if (r.status === 401) { await sb.auth.signOut(); throw Object.assign(new Error('Session expired. Please sign in again.'), { status: 401 }); }
    if (!r.ok) {
      let d = ''; try { d = (await r.json()).detail; } catch (e) { }
      if (Array.isArray(d)) d = d.map(x => (x.loc ? x.loc[x.loc.length - 1] + ': ' : '') + x.msg).join('. ');
      throw Object.assign(new Error(typeof d === 'string' && d ? d : 'Something went wrong. Please try again.'), { status: r.status });
    }
    return r.json();
  }

  /* ---------- helpers ---------- */
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  function rel(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'Just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  const dayLabel = iso => {
    const d = startOfDay(iso), t = startOfDay(Date.now());
    return d === t ? 'Today' : d === t - 864e5 ? 'Yesterday' : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
  };
  const fmtDate = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const counts = l => ({ total: l.length, normal: l.filter(t => t.verdict === 'normal').length, review: l.filter(t => t.verdict === 'review').length, suspicious: l.filter(t => t.verdict === 'suspicious').length });
  const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
  const goCheck = '<a class="btn primary" href="#/check">Check a payment</a>';
  const head = (title, sub, extra = '') => `<div class="page-head"><div><h2>${title}</h2><p>${sub}</p></div><div>${extra}<button class="btn ghost sm mobile-out" id="m-out">Sign out</button></div></div>`;
  const bindOut = () => { const b = $('#m-out'); if (b) b.onclick = () => sb.auth.signOut(); };
  const skeleton = () => '<div class="skeleton"></div><div class="skeleton" style="height:260px"></div>';

  /* ---------- boot ---------- */
  try { cfg = await (await fetch('/api/config')).json(); }
  catch (e) {
    document.body.insertAdjacentHTML('beforeend', '<p style="position:relative;z-index:2;padding:40px">The server is waking up. Refresh this page in a few seconds.</p>');
    return;
  }
  sb = supabase.createClient(cfg.supabase_url, cfg.supabase_key);
  const { data: s0 } = await sb.auth.getSession(); session = s0.session;
  sb.auth.onAuthStateChange((_e, s) => { const was = !!session; session = s; if (!!s !== was) render(); });
  function render() {
    $('#auth').hidden = !!session; $('#app').hidden = !session;
    if (session) {
      const u = session.user, name = (u.user_metadata && u.user_metadata.full_name) || u.email.split('@')[0];
      $('#who-name').textContent = name; $('#who-mail').textContent = u.email; $('#avatar').textContent = name[0].toUpperCase();
      cache = null;
      if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
      route();
    }
  }

  /* ---------- decorative sign-in feed (clearly labelled as samples) ---------- */
  function startFeed() {
    const list = $('#feed-list'); if (!list) return;
    const rows = [['normal', 'Grocery, card in store', 840], ['normal', 'Electricity bill, UPI', 2150], ['suspicious', 'Crypto, new device, 2:14 AM', 85000],
    ['review', 'Large first payment to new receiver', 32000], ['normal', 'Food delivery, wallet', 460], ['suspicious', 'International, 9 payments in a day', 41500], ['normal', 'Train ticket, net banking', 1280]];
    let i = 0;
    const add = () => {
      const [v, t, a] = rows[i++ % rows.length];
      const li = document.createElement('li');
      li.innerHTML = `<span class="pill ${v}">${LABEL[v]}</span><span>${t}</span><span class="amt">${inr(a)}</span>`;
      list.prepend(li); while (list.children.length > 4) list.lastChild.remove();
    };
    add(); add(); add();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(() => { if (!$('#auth').hidden) add(); }, 2600);
  }

  /* ---------- auth ---------- */
  let mode = 'login';
  $$('.tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  const pt = $('#pass-toggle'); pt.innerHTML = ico('eye');
  pt.onclick = () => {
    const show = $('#a-pass').type === 'password';
    $('#a-pass').type = show ? 'text' : 'password';
    pt.innerHTML = ico(show ? 'eyeoff' : 'eye'); pt.setAttribute('aria-pressed', show); pt.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };
  function setMode(m) {
    mode = m;
    $('#tab-login').setAttribute('aria-selected', m === 'login'); $('#tab-register').setAttribute('aria-selected', m === 'register');
    $('#name-field').hidden = m === 'login';
    $('#auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#auth-title').textContent = m === 'login' ? 'Welcome back' : 'Create your account';
    $('#auth-lede').textContent = m === 'login' ? 'Sign in to check and track your payments.' : 'It takes a few seconds. No card needed.';
    $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#auth-msg').textContent = '';
  }
  $('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#auth-msg'), btn = $('#auth-submit');
    const email = $('#a-email').value.trim(), password = $('#a-pass').value, name = $('#a-name').value.trim();
    msg.className = 'form-msg';
    if (!/^\S+@\S+\.\S+$/.test(email)) { $('#a-email').focus(); return msg.textContent = 'Enter a valid email address.'; }
    if (password.length < 6) { $('#a-pass').focus(); return msg.textContent = 'Password must be at least 6 characters.'; }
    if (mode === 'register' && !name) { $('#a-name').focus(); return msg.textContent = 'Enter your full name.'; }
    btn.disabled = true; const label = btn.textContent; btn.innerHTML = '<span class="spin"></span>Please wait';
    try {
      if (mode === 'register') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name } } });
        if (error) throw error;
        if (!data.session) { const r = await sb.auth.signInWithPassword({ email, password }); if (r.error) throw r.error; }
        toast('Account created. Welcome, ' + name.split(' ')[0] + '.');
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
      }
    } catch (err) {
      const m = err.message || '';
      msg.textContent = /invalid login/i.test(m) ? 'Email or password is wrong. Check them and try again.'
        : /already registered/i.test(m) ? 'This email already has an account. Sign in instead.'
          : /confirm/i.test(m) ? 'Confirm your email first, then sign in.' : m || 'Could not sign in. Try again.';
    } finally { btn.disabled = false; btn.textContent = label; }
  };
  $('#logout').onclick = () => sb.auth.signOut();

  /* ---------- router ---------- */
  const routes = { dashboard, check, track, history, reports };
  function route() {
    if (!session) return;
    const parts = location.hash.replace('#/', '').split('/');
    let name = parts[0] || 'dashboard'; const arg = parts[1] ? decodeURIComponent(parts[1]) : '';
    if (name === 'model') name = 'reports';
    if (!routes[name]) name = 'dashboard';
    $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.route === name));
    view.innerHTML = skeleton();
    routes[name](arg).catch(e => { if (e.status === 401) return; view.innerHTML = `<div class="card empty-block"><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`; });
    scrollTo(0, 0); view.focus({ preventScroll: true });
  }
  async function txns(force) { if (!cache || force) cache = await api('/transactions?limit=1000'); return cache; }

  /* ---------- shared pieces ---------- */
  function spark(vals, color) {
    if (vals.length < 2) return '<svg class="sp" aria-hidden="true"></svg>';
    const mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
    const xy = vals.map((v, i) => [i / (vals.length - 1) * 94 + 3, 29 - (v - mn) / sp * 26]);
    const d = xy.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1)).join('');
    const [lx, ly] = xy[xy.length - 1];
    return `<svg class="sp" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${lx},32L${xy[0][0]},32Z" fill="${color}" opacity=".12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <path d="M${lx},${ly}h0" stroke="${color}" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function statCell(label, value, trend, color, delta) {
    const d = delta ? `<div class="delta ${delta.tone}">${ico(delta.dir, 'sm')}<span>${delta.text}</span></div>` : '';
    return `<div class="stat-cell"><div class="lab">${label}</div><div class="row"><span class="val">${value}</span>${spark(trend, color)}</div>${d}</div>`;
  }
  function daily(l, fn, days = 7) {
    const t0 = startOfDay(Date.now()), out = Array(days).fill(0);
    l.forEach(t => { const k = days - 1 - Math.round((t0 - startOfDay(t.created_at)) / 864e5); if (k >= 0 && k < days) out[k] += fn(t); });
    return out;
  }
  function timeline(l) {
    if (!l.length) return '';
    let html = '', last = '';
    l.forEach(t => {
      const g = dayLabel(t.created_at);
      if (g !== last) { if (last) html += '</ul>'; html += `<div class="tl-day">${g}</div><ul class="tl">`; last = g; }
      html += `<li><a href="#/track/${encodeURIComponent(t.txn_ref || '')}"><span class="node ${t.verdict}">${vIcon(t.verdict)}</span>
        <span class="txt"><b>${inr(t.amount)}</b> to <b>${esc(t.receiver_name || 'Unknown receiver')}</b> · ${LABEL[t.verdict]}<span class="ref">${esc(t.txn_ref || 'No ID')} · ${esc(TYPE_NAME[t.txn_type] || '')}</span></span>
        <time datetime="${t.created_at}">${rel(t.created_at)}</time></a></li>`;
    });
    return html + '</ul>';
  }
  function donut(c) {
    const R = 68, C = 2 * Math.PI * R; let off = 0;
    const segs = ['normal', 'review', 'suspicious'].map(k => {
      const len = c.total ? C * c[k] / c.total : 0;
      const s = `<circle data-len="${len}" data-c="${C}" cx="85" cy="85" r="${R}" stroke="${HEX[k]}" stroke-dasharray="0 ${C}" stroke-dashoffset="${-off}"/>`;
      off += len; return s;
    }).join('');
    return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 170 170" role="img" aria-label="Results split"><g transform="rotate(-90 85 85)"><circle cx="85" cy="85" r="${R}" stroke="var(--line)" style="fill:none;stroke-width:22"/>${segs}</g></svg>
      <div class="legend">${['normal', 'review', 'suspicious'].map(k => `<div><i style="background:${COLOR[k]}"></i>${LABEL[k]}: <b>${c[k]}</b></div>`).join('')}</div></div>`;
  }
  const animateDonut = () => requestAnimationFrame(() => requestAnimationFrame(() => $$('.donut circle[data-len]').forEach(el => el.setAttribute('stroke-dasharray', `${el.dataset.len} ${el.dataset.c}`))));
  function trendChart(l) {
    if (l.length < 2) return '<p class="muted">Check at least two payments to see a trend.</p>';
    const w = 520, h = 150, p = 10;
    const pts = l.map((t, i) => [p + i * (w - 2 * p) / (l.length - 1), h - p - (Number(t.risk_score) / 100) * (h - 2 * p)]);
    const d = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
    const y80 = h - p - .8 * (h - 2 * p);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Risk trend of recent checks">
      <line x1="0" x2="${w}" y1="${y80}" y2="${y80}" stroke="var(--bad)" stroke-dasharray="4 5" opacity=".5"/>
      <path d="${d} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h}Z" fill="rgba(124,140,255,.14)"/>
      <path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      ${pts.map((q, i) => `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="${HEX[l[i].verdict]}"><title>${esc(l[i].txn_ref || '')} ${Number(l[i].risk_score).toFixed(0)}%</title></circle>`).join('')}</svg>`;
  }
  function gaugeHTML(risk, verdict) {
    return `<div class="gauge" data-risk="${risk}"><svg viewBox="0 0 230 230"><circle class="track" cx="115" cy="115" r="95"/><circle class="bar" cx="115" cy="115" r="95" stroke="${HEX[verdict]}"/></svg>
      <div class="num"><strong>0%</strong><small>risk score</small></div></div>`;
  }
  function animateGauge(root) {
    const g = $('.gauge', root); if (!g) return;
    const risk = Number(g.dataset.risk), bar = $('.bar', g), pct = $('strong', g), t0 = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => bar.style.strokeDashoffset = 597 * (1 - risk / 100)));
    (function tick(n) { const k = Math.min((n - t0) / 1300, 1), e = 1 - Math.pow(1 - k, 3); pct.textContent = (risk * e).toFixed(0) + '%'; if (k < 1) requestAnimationFrame(tick); else pct.textContent = risk.toFixed(0) + '%'; })(t0);
  }
  const SUB = { normal: 'No strong warning signs found.', review: 'Some signs look unusual. Confirm with the receiver before paying.', suspicious: 'Do not complete this payment until you verify it.' };
  const reasonList = (r, v) => `<ul class="reasons">${(r.length ? r : ['Amount, time and behaviour all match normal activity']).map((x, i) =>
    `<li class="${r.length ? '' : 'none'}" style="animation-delay:${.4 + i * .08}s">${esc(x)}</li>`).join('')}</ul>`;
  function trackSearch(val = '') {
    return `<form class="search" id="tsearch" role="search"><div class="search-box">${ico('search')}<input id="tq" type="search" value="${esc(val)}" placeholder="Enter transaction ID" aria-label="Transaction ID" autocomplete="off" spellcheck="false"></div><button class="btn primary" type="submit">Track</button></form>`;
  }
  function bindSearch() {
    const f = $('#tsearch'); if (!f) return;
    f.onsubmit = e => { e.preventDefault(); const v = $('#tq').value.trim().replace(/\s+/g, ''); if (!v) return $('#tq').focus(); location.hash = '#/track/' + encodeURIComponent(v.toUpperCase()); };
  }

  /* ---------- dashboard ---------- */
  async function dashboard() {
    const l = await txns(true), c = counts(l);
    const name = (session.user.user_metadata && session.user.user_metadata.full_name || session.user.email.split('@')[0]).split(' ')[0];
    const today = startOfDay(Date.now()), td = l.filter(t => startOfDay(t.created_at) === today);
    const flaggedAmt = l.filter(t => t.verdict === 'suspicious').reduce((s, t) => s + Number(t.amount), 0);
    const avg = l.length ? l.reduce((s, t) => s + Number(t.risk_score), 0) / l.length : 0;
    const dl = (n, goodUp) => n ? { dir: 'up', text: `+${n} today`, tone: goodUp === null ? '' : goodUp ? 'good' : 'bad' } : { dir: 'flat', text: 'None today', tone: '' };
    view.innerHTML = `<div class="page-head"><div class="hello"><h2>${greet()}, ${esc(name)}</h2><p>Here is how your payments look right now.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap">${trackSearch()}<button class="btn ghost sm mobile-out" id="m-out">Sign out</button></div></div>
      <div class="stat-group" role="group" aria-label="Summary">
        ${statCell('Payments checked', c.total, daily(l, () => 1), '#7C8CFF', dl(td.length, null))}
        ${statCell('Likely fraud', c.suspicious, daily(l, t => t.verdict === 'suspicious' ? 1 : 0), '#FF5D73', dl(td.filter(t => t.verdict === 'suspicious').length, false))}
        ${statCell('Value flagged', inr(flaggedAmt), daily(l, t => t.verdict === 'suspicious' ? Number(t.amount) : 0), '#FFB84D', null)}
        ${statCell('Average risk', avg.toFixed(0) + '%', l.slice(0, 12).reverse().map(t => Number(t.risk_score)), '#3FD9A8', null)}
      </div>
      ${l.length ? `
      <div class="grid two">
        <div class="card"><h3>Risk of recent checks</h3>${trendChart(l.slice(0, 20).reverse())}<p class="note">Dots above the dashed line are likely fraud.</p></div>
        <div class="card"><h3>Results split</h3>${donut(c)}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Recent activity</h3>${timeline(l.slice(0, 8))}</div>`
        : `<div class="card empty-block"><h3>No payments checked yet</h3><p>Enter a transaction ID and its details to get your first result.</p>${goCheck}</div>`}`;
    bindOut(); bindSearch(); animateDonut();
  }

  /* ---------- check ---------- */
  const mkRef = () => { const d = new Date(); return 'TXN' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + Math.random().toString(36).slice(2, 8).toUpperCase(); };
  const SAFE = { ref: 'TXN-DEMO-1001', sender: 'Priya Sharma', rname: 'Fresh Mart Grocers', rid: 'freshmart@okhdfc', amount: 850, hour: 14, type: 'upi', merchant: 'grocery', intl: false, dev: false, ben: false, n24: 1, age: 900, avg: 1200 };
  const RISKY = { ref: 'TXN-DEMO-2002', sender: 'Priya Sharma', rname: 'Quick Gains Ltd', rid: 'quickgains99@paytm', amount: 85000, hour: 2, type: 'upi', merchant: 'crypto', intl: true, dev: true, ben: true, n24: 8, age: 12, avg: 2500 };
  async function check() {
    const pre = store.get('prefillRef'); store.del('prefillRef');
    const me = (session.user.user_metadata && session.user.user_metadata.full_name) || '';
    view.innerHTML = head('Check a payment', 'Enter the transaction ID and details. You get a risk score and the reasons behind it.') + `
    <div class="grid check">
      <form class="card" id="f" novalidate>
        <div class="presets"><button type="button" class="btn sm" data-p="safe">Fill a normal example</button><button type="button" class="btn sm" data-p="risky">Fill a suspicious example</button></div>
        <div class="sec"><h3>Payment details</h3><div class="form-grid">
          <div class="field full" data-f="ref"><span>Transaction ID</span><div class="with-btn"><input id="ref" value="${esc(pre || '')}" placeholder="From your bank or UPI app" autocomplete="off" spellcheck="false" aria-describedby="e-ref"><button type="button" class="btn sm" id="gen" title="Make an ID if you do not have one">${ico('refresh')}Generate</button></div><small class="e" id="e-ref"></small></div>
          <label class="field" data-f="amount"><span>Amount (₹)</span><input id="amount" type="number" min="0" step="any" inputmode="decimal" placeholder="50000" aria-describedby="e-amount"><small class="e" id="e-amount"></small></label>
          <label class="field" data-f="time"><span>Time of payment</span><input id="time" type="time" aria-describedby="e-time"><small class="e" id="e-time"></small></label>
          <label class="field" data-f="sender"><span>Sender name</span><input id="sender" value="${esc(me)}" placeholder="Who is paying" autocomplete="off" aria-describedby="e-sender"><small class="e" id="e-sender"></small></label>
          <label class="field" data-f="rname"><span>Receiver name</span><input id="rname" placeholder="Who is being paid" autocomplete="off" aria-describedby="e-rname"><small class="e" id="e-rname"></small></label>
          <label class="field" data-f="type"><span>Payment type</span><select id="type">${cfg.txn_types.map(t => `<option value="${t}">${TYPE_NAME[t]}</option>`).join('')}</select></label>
          <label class="field" data-f="rid"><span id="rid-label">Receiver UPI ID</span><input id="rid" placeholder="name@bank" autocomplete="off" spellcheck="false" aria-describedby="e-rid"><small class="e" id="e-rid"></small></label>
          <label class="field" data-f="merchant"><span>Paid for</span><select id="merchant">${cfg.merchants.map(t => `<option value="${t}">${MERCH_NAME[t]}</option>`).join('')}</select></label>
          <label class="field" data-f="note"><span>Note (optional)</span><input id="note" maxlength="200" placeholder="Payment remark" autocomplete="off"></label>
        </div></div>
        <div class="sec"><h3>About the sender</h3><div class="form-grid">
          <label class="field"><span>Usual payment amount (₹)</span><input id="avg" type="number" min="0" step="any" inputmode="decimal" placeholder="Average of last 30 days"><small class="hint">Helps spot an unusually large payment.</small></label>
          <label class="field"><span>Payments in the last 24 hours</span><input id="n24" type="number" min="0" max="500" value="1"></label>
          <label class="field full"><span>Account age (days)</span><input id="age" type="number" min="0" value="365"></label>
        </div>
        <div class="switches">
          <label class="switch"><span>Payment is international</span><input id="intl" type="checkbox"></label>
          <label class="switch"><span>Made from a new device</span><input id="dev" type="checkbox"></label>
          <label class="switch"><span>Paying a new beneficiary</span><input id="ben" type="checkbox"></label>
        </div></div>
        <p class="form-msg" id="f-msg" role="alert"></p>
        <button class="btn primary wide" id="f-go" type="submit">Check this payment</button>
      </form>
      <section class="card result" id="res" aria-live="polite">
        <div class="empty">${ico('shield')}<p>Your result and the reasons behind it will show up here.</p></div>
      </section>
    </div>`;
    bindOut();
    $$('.empty svg').forEach(s => { s.style.cssText = 'width:54px;height:54px;color:var(--line);margin-bottom:10px'; });
    const fill = p => {
      $('#ref').value = p.ref + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(); $('#sender').value = p.sender; $('#rname').value = p.rname; $('#rid').value = p.rid;
      $('#amount').value = p.amount; $('#time').value = String(p.hour).padStart(2, '0') + ':30'; $('#type').value = p.type; $('#merchant').value = p.merchant;
      $('#avg').value = p.avg; $('#n24').value = p.n24; $('#age').value = p.age; $('#intl').checked = p.intl; $('#dev').checked = p.dev; $('#ben').checked = p.ben;
      $$('.field.err').forEach(f => f.classList.remove('err')); $$('.e').forEach(e => e.textContent = ''); typeLabel();
    };
    const typeLabel = () => { const u = $('#type').value === 'upi'; $('#rid-label').textContent = u ? 'Receiver UPI ID' : 'Receiver account or ID'; $('#rid').placeholder = u ? 'name@bank' : 'Account number or wallet ID'; };
    $('#type').onchange = typeLabel;
    $('#time').value = new Date().toTimeString().slice(0, 5);
    $('#gen').onclick = () => { $('#ref').value = mkRef(); clearErr('ref'); };
    $$('[data-p]').forEach(b => b.onclick = () => fill(b.dataset.p === 'safe' ? SAFE : RISKY));
    const setErr = (k, m) => { const f = $(`[data-f=${k}]`); f.classList.add('err'); $('#e-' + k).textContent = m; return k; };
    const clearErr = k => { const f = $(`[data-f=${k}]`); if (f) { f.classList.remove('err'); const e = $('#e-' + k); if (e) e.textContent = ''; } };
    ['ref', 'amount', 'time', 'sender', 'rname', 'rid'].forEach(k => $('#' + k).addEventListener('input', () => clearErr(k)));

    $('#f').onsubmit = async e => {
      e.preventDefault();
      const msg = $('#f-msg'); msg.textContent = '';
      const v = { ref: $('#ref').value.trim().replace(/\s+/g, ''), sender: $('#sender').value.trim(), rname: $('#rname').value.trim(), rid: $('#rid').value.trim(), amount: $('#amount').value };
      $$('.field.err').forEach(f => f.classList.remove('err')); $$('.e').forEach(x => x.textContent = '');
      const bad = [];
      if (v.ref.length < 6 || !/^[A-Za-z0-9_\-]+$/.test(v.ref)) bad.push(setErr('ref', 'Use 6 to 40 letters, numbers or dashes. Use Generate if you have no ID.'));
      if (v.amount === '' || !(parseFloat(v.amount) > 0)) bad.push(setErr('amount', 'Enter an amount greater than zero.'));
      if (!$('#time').value) bad.push(setErr('time', 'Enter the time of the payment.'));
      if (!v.sender) bad.push(setErr('sender', 'Enter the sender name.'));
      if (!v.rname) bad.push(setErr('rname', 'Enter the receiver name.'));
      if (v.rid.length < 3 || !/^[A-Za-z0-9@._\-]+$/.test(v.rid)) bad.push(setErr('rid', 'Enter the receiver ID using letters, numbers and . _ - @ only.'));
      if (bad.length) { const el = $('#' + bad[0]); el.focus(); return; }
      const body = {
        txn_ref: v.ref, sender_name: v.sender, receiver_name: v.rname, receiver_id: v.rid, note: $('#note').value.trim() || null,
        amount: parseFloat(v.amount), txn_hour: parseInt($('#time').value.split(':')[0], 10),
        txn_type: $('#type').value, merchant_category: $('#merchant').value,
        is_international: $('#intl').checked, new_device: $('#dev').checked, new_beneficiary: $('#ben').checked,
        txns_last_24h: parseInt($('#n24').value || '0', 10), account_age_days: parseInt($('#age').value || '0', 10),
        avg_amount_30d: parseFloat($('#avg').value || '0')
      };
      const btn = $('#f-go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Checking';
      try {
        const r = await api('/predict', { method: 'POST', body: JSON.stringify(body) });
        cache = null; showResult(r);
      } catch (err) {
        if (err.status === 409) { setErr('ref', err.message); $('#ref').focus(); } else msg.textContent = err.message;
      } finally { btn.disabled = false; btn.textContent = 'Check this payment'; }
    };
  }
  function showResult(r) {
    const box = $('#res'), risk = Number(r.risk_score);
    box.className = 'card result is-' + r.verdict;
    box.innerHTML = `${gaugeHTML(risk, r.verdict)}<h3 style="color:${COLOR[r.verdict]}">${LABEL[r.verdict]}</h3><p class="muted">${SUB[r.verdict]}</p>
      <p class="note" style="margin:6px 0 0">${esc(r.txn_ref)} · ${inr(r.amount)} to ${esc(r.receiver_name)}</p>${reasonList(r.reasons, r.verdict)}
      <div class="actions"><a class="btn primary" href="#/track/${encodeURIComponent(r.txn_ref)}">View full details</a><button class="btn" id="again" type="button">Check another</button></div>`;
    animateGauge(box);
    $('#again').onclick = () => { route(); };
    if (matchMedia('(max-width:900px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- track ---------- */
  async function track(ref) {
    if (!ref) {
      const l = await txns(true);
      view.innerHTML = head('Track a transaction', 'Enter a transaction ID to see who paid whom, the risk score and the full history of that payment.', trackSearch()) +
        (l.length ? `<div class="card"><h3>Recent payments</h3>${timeline(l.slice(0, 10))}</div>`
          : `<div class="card empty-block"><h3>No payments to track yet</h3><p>Check a payment first. It will show up here by its transaction ID.</p>${goCheck}</div>`);
      bindOut(); bindSearch(); return;
    }
    view.innerHTML = head('Track a transaction', 'Full details for one payment.', trackSearch(ref)) + skeleton(); bindOut(); bindSearch();
    let res;
    try { res = await api('/lookup/' + encodeURIComponent(ref)); }
    catch (e) {
      if (e.status === 404 || e.status === 422) {
        view.innerHTML = head('Track a transaction', 'Full details for one payment.', trackSearch(ref)) +
          `<div class="card empty-block"><h3>No payment found for ${esc(ref)}</h3><p>${esc(e.message)}</p><button class="btn primary" id="chk-this">Check this payment</button></div>`;
        bindOut(); bindSearch();
        $('#chk-this').onclick = () => { store.set('prefillRef', ref); location.hash = '#/check'; };
        return;
      }
      throw e;
    }
    const t = res.txn, rel_ = res.related || [];
    const yn = b => b ? 'Yes' : 'No';
    view.innerHTML = head('Track a transaction', 'Full details for one payment.', trackSearch(ref)) + `
    <div class="detail">
      <section class="card">
        <div class="d-head"><div><div class="refline"><span>${esc(t.txn_ref)}</span><button class="copy" id="copy" aria-label="Copy transaction ID">${ico('copy')}</button></div><small class="muted">Checked ${fmtDate(t.created_at)}</small></div><span class="pill ${t.verdict}">${LABEL[t.verdict]}</span></div>
        <div class="parties">
          <div class="party"><small>From</small><strong>${esc(t.sender_name || 'Not recorded')}</strong></div>
          <div class="flow"><b>${inr(t.amount)}</b>${ico('right')}</div>
          <div class="party to"><small>To</small><strong>${esc(t.receiver_name || 'Not recorded')}</strong><span>${esc(t.receiver_id || '')}</span></div>
        </div>
        <div class="mini-gauge">${gaugeHTML(Number(t.risk_score), t.verdict)}<div><h3 style="color:${COLOR[t.verdict]};font-size:20px;margin-bottom:4px">${LABEL[t.verdict]}</h3><p class="muted">${SUB[t.verdict]}</p></div></div>
        ${reasonList(t.reasons || [], t.verdict)}
        <dl class="facts">
          <div><dt>Payment type</dt><dd>${esc(TYPE_NAME[t.txn_type] || t.txn_type)}</dd></div>
          <div><dt>Paid for</dt><dd>${esc(MERCH_NAME[t.merchant_category] || '-')}</dd></div>
          <div><dt>Time of payment</dt><dd>${String(t.txn_hour).padStart(2, '0')}:00 hour</dd></div>
          <div><dt>International</dt><dd>${yn(t.is_international)}</dd></div>
          <div><dt>New device</dt><dd>${yn(t.new_device)}</dd></div>
          <div><dt>New beneficiary</dt><dd>${yn(t.new_beneficiary)}</dd></div>
          <div><dt>Payments in 24 hours</dt><dd>${t.txns_last_24h}</dd></div>
          <div><dt>Account age</dt><dd>${t.account_age_days} days</dd></div>
          <div><dt>Usual amount</dt><dd>${Number(t.avg_amount_30d) ? inr(t.avg_amount_30d) : 'Not given'}</dd></div>
          ${t.note ? `<div style="grid-column:1/-1"><dt>Note</dt><dd>${esc(t.note)}</dd></div>` : ''}
        </dl>
      </section>
      <aside class="grid">
        <div class="card"><h3>Payment journey</h3><ul class="tl">
          <li><div style="display:flex;gap:14px;align-items:center;padding:8px 0"><span class="node">${ico('right')}</span><span class="txt"><b>Submitted</b><span class="ref">${fmtDate(t.created_at)}</span></span></div></li>
          <li><div style="display:flex;gap:14px;align-items:center;padding:8px 0"><span class="node">${ico('search')}</span><span class="txt"><b>Scored by the model</b><span class="ref">Risk ${Number(t.risk_score).toFixed(1)}%</span></span></div></li>
          <li><div style="display:flex;gap:14px;align-items:center;padding:8px 0"><span class="node ${t.verdict}">${vIcon(t.verdict)}</span><span class="txt"><b>${LABEL[t.verdict]}</b><span class="ref">${(t.reasons || []).length} warning sign${(t.reasons || []).length === 1 ? '' : 's'} found</span></span></div></li></ul></div>
        <div class="card"><h3>Other payments to ${esc(t.receiver_name || 'this receiver')}</h3>
          ${rel_.length ? rel_.map(x => `<a class="row-link" href="#/track/${encodeURIComponent(x.txn_ref)}"><span><b>${esc(x.txn_ref)}</b><small>${fmtDate(x.created_at)}</small></span><span style="text-align:right"><b>${inr(x.amount)}</b><small><span class="pill ${x.verdict}">${LABEL[x.verdict]}</span></small></span></a>`).join('')
        : '<p class="muted">This is the only payment you have checked to this receiver.</p>'}</div>
      </aside>
    </div>`;
    bindOut(); bindSearch(); animateGauge(view);
    $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(t.txn_ref); toast('Transaction ID copied'); } catch (e) { toast('Could not copy. Select the ID and copy it.', true); } };
  }

  /* ---------- history ---------- */
  function table(l, del) {
    return `<div class="table-wrap"><table><thead><tr><th>Transaction ID</th><th>When</th><th>Sender to receiver</th><th class="num">Amount</th><th class="num">Risk</th><th>Result</th>${del ? '<th></th>' : ''}</tr></thead><tbody>
    ${l.map(t => `<tr><td><a href="#/track/${encodeURIComponent(t.txn_ref || '')}" style="color:var(--brand);font-weight:600;text-decoration:none">${esc(t.txn_ref || 'No ID')}</a></td>
      <td>${fmtDate(t.created_at)}</td><td>${esc(t.sender_name || '-')}<span class="muted"> to </span>${esc(t.receiver_name || '-')}</td>
      <td class="num">${inr(t.amount)}</td><td class="num">${Number(t.risk_score).toFixed(1)}%</td><td><span class="pill ${t.verdict}">${LABEL[t.verdict]}</span></td>
      ${del ? `<td><button class="del" data-id="${t.id}" aria-label="Delete ${esc(t.txn_ref || 'this check')}">Delete</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  }
  async function history() {
    const all = await txns(true); let f = 'all', q = '';
    const draw = () => {
      const l = all.filter(t => (f === 'all' || t.verdict === f) && (!q || [t.txn_ref, t.sender_name, t.receiver_name, t.receiver_id].join(' ').toLowerCase().includes(q)));
      $('#h-body').innerHTML = l.length ? table(l, true) : `<div class="empty-block"><p>${all.length ? 'No payments match your search.' : 'You have not checked any payments yet.'}</p>${all.length ? '' : goCheck}</div>`;
      $$('.del').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this check? This cannot be undone.')) return;
        try { await api('/transactions/' + b.dataset.id, { method: 'DELETE' }); const i = all.findIndex(t => t.id === b.dataset.id); all.splice(i, 1); cache = all; draw(); toast('Check deleted'); }
        catch (e) { toast(e.message, true); }
      });
    };
    view.innerHTML = head('History', 'Every payment you have checked, newest first.') + `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;align-items:center"><div class="search-box" style="max-width:340px">${ico('search')}<input id="hq" type="search" placeholder="Search ID, sender or receiver" aria-label="Search history"></div>
      <div class="chips" style="margin:0" role="group" aria-label="Filter by result">${[['all', 'All'], ['normal', 'Looks safe'], ['review', 'Needs review'], ['suspicious', 'Likely fraud']].map(([k, n]) => `<button class="chip" data-f="${k}" aria-pressed="${k === 'all'}">${n}</button>`).join('')}</div></div>
      <div class="card" id="h-body"></div>`;
    bindOut();
    $('#hq').oninput = e => { q = e.target.value.trim().toLowerCase(); draw(); };
    $$('.chip').forEach(b => b.onclick = () => { f = b.dataset.f; $$('.chip').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
    draw();
  }

  /* ---------- reports (with model performance) ---------- */
  async function reports() {
    const [l, m] = await Promise.all([txns(true), api('/model')]);
    const c = counts(l), cf = m.confusion, pc = x => (x * 100).toFixed(1) + '%';
    const tally = {}; l.forEach(t => (t.reasons || []).forEach(r => { const k = r.replace(/[\d.]+x/, 'N×').replace(/\d+ (transactions)/, 'N $1').replace(/\(\d+ days old\)/, '').replace(/\(\d\d:00.*\)/, '').replace(/\d+ earlier/, 'N earlier').trim(); tally[k] = (tally[k] || 0) + 1; }));
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6), mx = top.length ? top[0][1] : 1;
    const money = k => l.filter(t => t.verdict === k).reduce((s, t) => s + Number(t.amount), 0);
    view.innerHTML = head('Reports', 'A summary of your checks and how well the model performs.', l.length ? '<button class="btn" id="csv">Download CSV</button> <button class="btn primary" id="print">Print report</button>' : '') + (l.length ? `
      <div class="stat-group">
        ${statCell('Payments checked', c.total, daily(l, () => 1), '#7C8CFF')}
        ${statCell('Fraud rate', (100 * c.suspicious / c.total).toFixed(1) + '%', [], '#FF5D73')}
        ${statCell('Value flagged as fraud', inr(money('suspicious')), daily(l, t => t.verdict === 'suspicious' ? Number(t.amount) : 0), '#FF5D73')}
        ${statCell('Value awaiting review', inr(money('review')), daily(l, t => t.verdict === 'review' ? Number(t.amount) : 0), '#FFB84D')}
      </div>
      <div class="grid two">
        <div class="card"><h3>Most common warning signs</h3>${top.length ? `<div class="bars">${top.map(([k, n]) => `<div class="bar-row"><span>${esc(k)}</span><b>${n}</b><div class="track"><div class="fill" data-w="${100 * n / mx}"></div></div></div>`).join('')}</div>` : '<p class="muted">No warning signs found in your checks.</p>'}</div>
        <div class="card"><h3>Results split</h3>${donut(c)}</div>
      </div>` : `<div class="card empty-block" style="margin-bottom:16px"><h3>Nothing to report yet</h3><p>Your report fills in after you check a payment.</p>${goCheck}</div>`) + `
      <h3 style="margin:26px 0 12px;font-size:20px">Model performance</h3>
      <div class="stat-group">
        ${statCell('Precision', pc(m.precision), [], '#7C8CFF')}${statCell('Recall', pc(m.recall), [], '#7C8CFF')}${statCell('ROC AUC', m.roc_auc.toFixed(3), [], '#7C8CFF')}${statCell('F1 score', m.f1.toFixed(3), [], '#7C8CFF')}
      </div>
      <div class="grid two">
        <div class="card"><h3>Test results on ${m.test_rows.toLocaleString('en-IN')} payments</h3>
          <div class="confusion"><span></span><div class="h">Predicted safe</div><div class="h">Predicted fraud</div>
            <div class="h">Actually safe</div><div class="g"><strong>${cf.tn.toLocaleString('en-IN')}</strong>correct</div><div class="r"><strong>${cf.fp}</strong>false alarms</div>
            <div class="h">Actually fraud</div><div class="r"><strong>${cf.fn}</strong>missed</div><div class="g"><strong>${cf.tp}</strong>caught</div></div></div>
        <div class="card"><h3>About this model</h3>
          <p class="muted">Gradient boosting classifier trained on ${m.train_rows.toLocaleString('en-IN')} payments (${(m.fraud_rate * 100).toFixed(1)}% fraud). It weighs amount against usual spend, time of day, payment type, what was bought, new devices and beneficiaries, payment bursts and account age. Receivers you flagged before are also checked.</p>
          <p class="note">Trained on generated data that follows common fraud patterns, not on real bank records. It checks payments you enter here and cannot see or stop real bank transactions. Always confirm with your bank. Last trained ${esc(m.trained_at)}.</p></div>
      </div>`;
    bindOut(); animateDonut();
    requestAnimationFrame(() => requestAnimationFrame(() => $$('.fill').forEach(f => f.style.width = f.dataset.w + '%')));
    if ($('#print')) $('#print').onclick = () => print();
    if ($('#csv')) $('#csv').onclick = () => {
      const cols = ['txn_ref', 'created_at', 'sender_name', 'receiver_name', 'receiver_id', 'amount', 'txn_hour', 'txn_type', 'merchant_category', 'is_international', 'new_device', 'new_beneficiary', 'txns_last_24h', 'account_age_days', 'avg_amount_30d', 'risk_score', 'verdict', 'reasons', 'note'];
      const q = v => { let s = String(v == null ? '' : Array.isArray(v) ? v.join('; ') : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const csv = [cols.join(','), ...l.map(t => cols.map(k => q(t[k])).join(','))].join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'fraud-report.csv'; a.click(); URL.revokeObjectURL(a.href);
    };
  }

  /* ---------- start (must stay last: everything above has to be defined first) ---------- */
  addEventListener('hashchange', route);
  startFeed();
  render();
})();
