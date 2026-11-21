(async function () {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const inr = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABEL = { normal: 'Looks safe', review: 'Needs review', suspicious: 'Likely fraud' };
  const COLOR = { normal: 'var(--ok)', review: 'var(--warn)', suspicious: 'var(--bad)' };
  const TYPE_NAME = { upi: 'UPI', card_online: 'Card (online)', card_pos: 'Card (in store)', net_banking: 'Net banking', wallet: 'Wallet', atm_withdrawal: 'ATM withdrawal' };
  const MERCH_NAME = { grocery: 'Grocery', food: 'Food and dining', travel: 'Travel', electronics: 'Electronics', jewellery: 'Jewellery', gaming: 'Gaming', crypto: 'Crypto', utilities: 'Bills and utilities', other: 'Other' };

  let sb, cfg, session, cache = null;

  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 3200);
  }

  async function api(path, opts = {}) {
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    const r = await fetch('/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
    });
    if (r.status === 401) { await sb.auth.signOut(); throw new Error('Session expired. Please sign in again.'); }
    if (!r.ok) {
      let d = ''; try { d = (await r.json()).detail; } catch (e) { }
      throw new Error(typeof d === 'string' && d ? d : 'Something went wrong. Please try again.');
    }
    return r.json();
  }

  /* ---------- boot ---------- */
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend', '<p style="position:relative;z-index:2;padding:40px">The server is waking up. Refresh this page in a few seconds.</p>');
    return;
  }
  sb = supabase.createClient(cfg.supabase_url, cfg.supabase_key);
  const { data: s0 } = await sb.auth.getSession();
  session = s0.session;
  sb.auth.onAuthStateChange((_e, s) => { const was = !!session; session = s; if (!!s !== was) render(); });
  addEventListener('hashchange', route);
  render();

  function render() {
    $('#auth').hidden = !!session;
    $('#app').hidden = !session;
    if (session) {
      const u = session.user, name = (u.user_metadata && u.user_metadata.full_name) || u.email.split('@')[0];
      $('#who-name').textContent = name; $('#who-mail').textContent = u.email;
      $('#avatar').textContent = name[0].toUpperCase();
      cache = null;
      if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
      route();
    }
  }

  /* ---------- auth ---------- */
  let mode = 'login';
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  function setMode(m) {
    mode = m;
    $('#tab-login').setAttribute('aria-selected', m === 'login');
    $('#tab-register').setAttribute('aria-selected', m === 'register');
    $('#name-field').hidden = m === 'login';
    $('#auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#auth-msg').textContent = '';
  }
  $('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#auth-msg'), btn = $('#auth-submit');
    const email = $('#a-email').value.trim(), password = $('#a-pass').value, name = $('#a-name').value.trim();
    msg.className = 'form-msg';
    if (!/^\S+@\S+\.\S+$/.test(email)) return msg.textContent = 'Enter a valid email address.';
    if (password.length < 6) return msg.textContent = 'Password must be at least 6 characters.';
    if (mode === 'register' && !name) return msg.textContent = 'Enter your full name.';
    btn.disabled = true; const label = btn.textContent; btn.innerHTML = '<span class="spin"></span>Please wait';
    try {
      if (mode === 'register') {
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name } } });
        if (error) throw error;
        if (!data.session) {
          const r = await sb.auth.signInWithPassword({ email, password });
          if (r.error) throw r.error;
        }
        toast('Account created. Welcome, ' + name.split(' ')[0] + '.');
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
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
  const routes = { dashboard, check, history, reports, model };
  function route() {
    if (!session) return;
    const r = (location.hash.replace('#/', '') || 'dashboard');
    const name = routes[r] ? r : 'dashboard';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.route === name));
    view.innerHTML = '<p class="muted"><span class="spin"></span>Loading</p>';
    routes[name]().catch(e => { view.innerHTML = `<div class="card empty-block"><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`; });
    scrollTo(0, 0);
  }
  async function txns(force) {
    if (!cache || force) cache = await api('/transactions?limit=1000');
    return cache;
  }
  const head = (title, sub, extra = '') => `<div class="page-head"><div><h2>${title}</h2><p>${sub}</p></div><div>${extra}<button class="btn ghost sm mobile-out" id="m-out">Sign out</button></div></div>`;
  const bindOut = () => { const b = $('#m-out'); if (b) b.onclick = () => sb.auth.signOut(); };
  const counts = l => ({ total: l.length, normal: l.filter(t => t.verdict === 'normal').length, review: l.filter(t => t.verdict === 'review').length, suspicious: l.filter(t => t.verdict === 'suspicious').length });
  const goCheck = '<a class="btn primary" href="#/check">Check a payment</a>';

  /* ---------- dashboard ---------- */
  async function dashboard() {
    const l = await txns(true), c = counts(l);
    const flagged = l.filter(t => t.verdict === 'suspicious').reduce((s, t) => s + Number(t.amount), 0);
    const avg = l.length ? l.reduce((s, t) => s + Number(t.risk_score), 0) / l.length : 0;
    view.innerHTML = head('Dashboard', 'A live summary of every payment you have checked.', goCheck) + `
      <div class="grid stats">
        <div class="card stat"><small>Payments checked</small><strong>${c.total}</strong></div>
        <div class="card stat ok"><small>Looks safe</small><strong>${c.normal}</strong></div>
        <div class="card stat warn"><small>Needs review</small><strong>${c.review}</strong></div>
        <div class="card stat bad"><small>Likely fraud</small><strong>${c.suspicious}</strong></div>
      </div>
      ${l.length ? `
      <div class="grid two">
        <div class="card"><h3>Results split</h3>${donut(c)}</div>
        <div class="card"><h3>Risk score of recent checks</h3>${spark(l.slice(0, 20).reverse())}<p class="note">Average risk ${avg.toFixed(1)}%. Value of likely-fraud payments: ${inr(flagged)}.</p></div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Latest checks</h3>${table(l.slice(0, 6), false)}</div>`
      : `<div class="card empty-block"><h3>No payments checked yet</h3><p>Check your first payment to see results here.</p>${goCheck}</div>`}`;
    bindOut(); animateDonut();
  }
  function donut(c) {
    const R = 68, C = 2 * Math.PI * R; let off = 0;
    const segs = ['normal', 'review', 'suspicious'].map(k => {
      const len = c.total ? C * c[k] / c.total : 0;
      const s = `<circle data-len="${len}" data-c="${C}" cx="85" cy="85" r="${R}" stroke="${COLOR[k].replace('var(', '').replace(')', '') && getComputedStyle(document.documentElement).getPropertyValue(COLOR[k].slice(4, -1)).trim()}" stroke-dasharray="0 ${C}" stroke-dashoffset="${-off}"/>`;
      off += len; return s;
    }).join('');
    return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 170 170" role="img" aria-label="Results split"><g transform="rotate(-90 85 85)"><circle cx="85" cy="85" r="${R}" stroke="var(--line)" style="fill:none;stroke-width:22"/>${segs}</g></svg>
      <div class="legend">${['normal', 'review', 'suspicious'].map(k => `<div><i style="background:${COLOR[k]}"></i>${LABEL[k]}: <b>${c[k]}</b></div>`).join('')}</div></div>`;
  }
  function animateDonut() {
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.donut circle[data-len]').forEach(el =>
      el.setAttribute('stroke-dasharray', `${el.dataset.len} ${el.dataset.c}`))));
  }
  function spark(l) {
    if (l.length < 2) return '<p class="muted">Check at least two payments to see a trend.</p>';
    const w = 520, h = 140, p = 10;
    const pts = l.map((t, i) => [p + i * (w - 2 * p) / (l.length - 1), h - p - (Number(t.risk_score) / 100) * (h - 2 * p)]);
    const d = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Risk trend">
      <line x1="0" x2="${w}" y1="${h - p - 0.8 * (h - 2 * p)}" y2="${h - p - 0.8 * (h - 2 * p)}" stroke="var(--bad)" stroke-dasharray="4 5" opacity=".5"/>
      <path d="${d} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h}Z" fill="rgba(124,140,255,.14)"/>
      <path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      ${pts.map((q, i) => `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="${COLOR[l[i].verdict]}"/>`).join('')}</svg>`;
  }
  function table(l, del) {
    return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th class="num">Amount</th><th class="num">Risk</th><th>Result</th>${del ? '<th></th>' : ''}</tr></thead><tbody>
    ${l.map(t => `<tr><td>${new Date(t.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${esc(TYPE_NAME[t.txn_type] || t.txn_type)}<span class="muted"> · ${esc(MERCH_NAME[t.merchant_category] || '')}</span></td>
      <td class="num">${inr(t.amount)}</td><td class="num">${Number(t.risk_score).toFixed(1)}%</td>
      <td><span class="pill ${t.verdict}">${LABEL[t.verdict]}</span></td>
      ${del ? `<td><button class="del" data-id="${t.id}" aria-label="Delete this check">Delete</button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
  }

  /* ---------- check ---------- */
  const SAFE = { amount: 850, hour: 14, type: 'card_pos', merchant: 'grocery', intl: false, dev: false, ben: false, n24: 1, age: 900, avg: 1200 };
  const RISKY = { amount: 85000, hour: 2, type: 'upi', merchant: 'crypto', intl: true, dev: true, ben: true, n24: 8, age: 12, avg: 2500 };
  async function check() {
    view.innerHTML = head('Check a payment', 'Fill in what you know about the payment. The more detail, the better the result.') + `
    <div class="grid check">
      <form class="card" id="f" novalidate>
        <div class="presets"><button type="button" class="btn sm" data-p="safe">Try a normal payment</button><button type="button" class="btn sm" data-p="risky">Try a suspicious payment</button></div>
        <div class="form-grid">
          <label class="field"><span>Amount (₹)</span><input id="amount" type="number" min="0" step="any" inputmode="decimal" placeholder="50000" required></label>
          <label class="field"><span>Time of payment</span><input id="time" type="time" required></label>
          <label class="field"><span>Payment type</span><select id="type">${cfg.txn_types.map(t => `<option value="${t}">${TYPE_NAME[t]}</option>`).join('')}</select></label>
          <label class="field"><span>Paid to</span><select id="merchant">${cfg.merchants.map(t => `<option value="${t}">${MERCH_NAME[t]}</option>`).join('')}</select></label>
          <label class="field"><span>Your usual payment amount (₹)</span><input id="avg" type="number" min="0" step="any" inputmode="decimal" placeholder="Average of last 30 days"></label>
          <label class="field"><span>Payments in the last 24 hours</span><input id="n24" type="number" min="0" max="500" value="1"></label>
          <label class="field full"><span>Account age (days)</span><input id="age" type="number" min="0" value="365"></label>
        </div>
        <div class="switches">
          <label class="switch"><span>Payment is international</span><input id="intl" type="checkbox"></label>
          <label class="switch"><span>Made from a new device</span><input id="dev" type="checkbox"></label>
          <label class="switch"><span>Paying a new beneficiary</span><input id="ben" type="checkbox"></label>
        </div>
        <p class="form-msg" id="f-msg" role="alert"></p>
        <button class="btn primary wide" id="f-go" type="submit">Check this payment</button>
      </form>
      <section class="card result" id="res" aria-live="polite">
        <div class="empty"><svg viewBox="0 0 24 24"><path d="M12 3l8 3v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6z"/></svg><p>Your result and the reasons behind it will show up here.</p></div>
      </section>
    </div>`;
    bindOut();
    const fill = p => {
      $('#amount').value = p.amount; $('#time').value = String(p.hour).padStart(2, '0') + ':30';
      $('#type').value = p.type; $('#merchant').value = p.merchant; $('#avg').value = p.avg;
      $('#n24').value = p.n24; $('#age').value = p.age;
      $('#intl').checked = p.intl; $('#dev').checked = p.dev; $('#ben').checked = p.ben;
    };
    $('#time').value = new Date().toTimeString().slice(0, 5);
    document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => fill(b.dataset.p === 'safe' ? SAFE : RISKY));
    $('#f').onsubmit = async e => {
      e.preventDefault();
      const msg = $('#f-msg'); msg.textContent = '';
      const amount = parseFloat($('#amount').value);
      if (!(amount >= 0) || $('#amount').value === '') return msg.textContent = 'Enter the payment amount.';
      if (!$('#time').value) return msg.textContent = 'Enter the time of the payment.';
      const body = {
        amount, txn_hour: parseInt($('#time').value.split(':')[0], 10),
        txn_type: $('#type').value, merchant_category: $('#merchant').value,
        is_international: $('#intl').checked, new_device: $('#dev').checked, new_beneficiary: $('#ben').checked,
        txns_last_24h: parseInt($('#n24').value || '0', 10), account_age_days: parseInt($('#age').value || '0', 10),
        avg_amount_30d: parseFloat($('#avg').value || '0')
      };
      const btn = $('#f-go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Checking';
      try {
        const r = await api('/predict', { method: 'POST', body: JSON.stringify(body) });
        cache = null; showResult(r);
      } catch (err) { msg.textContent = err.message; }
      finally { btn.disabled = false; btn.textContent = 'Check this payment'; }
    };
  }
  function showResult(r) {
    const box = $('#res'), risk = Number(r.risk_score), col = COLOR[r.verdict];
    const sub = { normal: 'No strong warning signs found.', review: 'Some signs look unusual. Confirm it with the sender first.', suspicious: 'Do not complete this payment until you verify it.' }[r.verdict];
    box.className = 'card result is-' + r.verdict;
    box.innerHTML = `<div class="gauge"><svg viewBox="0 0 230 230"><circle class="track" cx="115" cy="115" r="95"/><circle class="bar" id="bar" cx="115" cy="115" r="95" stroke="${col}"/></svg>
      <div class="num"><strong id="pct">0%</strong><small>risk score</small></div></div>
      <h3 style="color:${col}">${LABEL[r.verdict]}</h3><p class="muted">${sub}</p>
      <ul class="reasons">${(r.reasons.length ? r.reasons : ['Amount, time and behaviour all match normal activity']).map((x, i) =>
      `<li class="${r.reasons.length ? '' : 'none'}" style="animation-delay:${.5 + i * .08}s">${esc(x)}</li>`).join('')}</ul>`;
    const bar = $('#bar'); requestAnimationFrame(() => requestAnimationFrame(() => bar.style.strokeDashoffset = 597 * (1 - risk / 100)));
    const pct = $('#pct'), t0 = performance.now();
    (function tick(n) { const k = Math.min((n - t0) / 1300, 1), e = 1 - Math.pow(1 - k, 3); pct.textContent = (risk * e).toFixed(0) + '%'; if (k < 1) requestAnimationFrame(tick); else pct.textContent = risk.toFixed(0) + '%'; })(t0);
    if (matchMedia('(max-width:900px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- history ---------- */
  async function history() {
    const all = await txns(true); let f = 'all';
    const draw = () => {
      const l = f === 'all' ? all : all.filter(t => t.verdict === f);
      $('#h-body').innerHTML = l.length ? table(l, true) : `<div class="empty-block"><p>${all.length ? 'No payments match this filter.' : 'You have not checked any payments yet.'}</p>${all.length ? '' : goCheck}</div>`;
      document.querySelectorAll('.del').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this check? This cannot be undone.')) return;
        try { await api('/transactions/' + b.dataset.id, { method: 'DELETE' }); const i = all.findIndex(t => t.id === b.dataset.id); all.splice(i, 1); cache = all; draw(); toast('Check deleted'); }
        catch (e) { toast(e.message, true); }
      });
    };
    view.innerHTML = head('History', 'Every payment you have checked, newest first.') + `
      <div class="chips" role="group" aria-label="Filter by result">${[['all', 'All'], ['normal', 'Looks safe'], ['review', 'Needs review'], ['suspicious', 'Likely fraud']].map(([k, n]) => `<button class="chip" data-f="${k}" aria-pressed="${k === 'all'}">${n}</button>`).join('')}</div>
      <div class="card" id="h-body"></div>`;
    bindOut();
    document.querySelectorAll('.chip').forEach(b => b.onclick = () => { f = b.dataset.f; document.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', x === b)); draw(); });
    draw();
  }

  /* ---------- reports ---------- */
  async function reports() {
    const l = await txns(true), c = counts(l);
    const tally = {}; l.forEach(t => (t.reasons || []).forEach(r => { const k = r.replace(/[\d.]+x/, 'N×').replace(/\d+ (transactions)/, 'N $1').replace(/\(\d+ days old\)/, '').replace(/\(\d\d:00.*\)/, '').trim(); tally[k] = (tally[k] || 0) + 1; }));
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6), mx = top.length ? top[0][1] : 1;
    const money = k => l.filter(t => t.verdict === k).reduce((s, t) => s + Number(t.amount), 0);
    view.innerHTML = head('Reports', 'A summary you can download or print.', l.length ? '<button class="btn" id="csv">Download CSV</button> <button class="btn primary" id="print">Print report</button>' : '') + (l.length ? `
      <div class="grid stats">
        <div class="card stat"><small>Payments checked</small><strong>${c.total}</strong></div>
        <div class="card stat"><small>Fraud rate</small><strong>${(100 * c.suspicious / c.total).toFixed(1)}%</strong></div>
        <div class="card stat bad"><small>Value flagged as fraud</small><strong>${inr(money('suspicious'))}</strong></div>
        <div class="card stat warn"><small>Value awaiting review</small><strong>${inr(money('review'))}</strong></div>
      </div>
      <div class="grid two">
        <div class="card"><h3>Most common warning signs</h3>${top.length ? `<div class="bars">${top.map(([k, n]) => `<div class="bar-row"><span>${esc(k)}</span><b>${n}</b><div class="track"><div class="fill" data-w="${100 * n / mx}"></div></div></div>`).join('')}</div>` : '<p class="muted">No warning signs found in your checks.</p>'}</div>
        <div class="card"><h3>Results split</h3>${donut(c)}</div>
      </div>
      <p class="note">Report generated ${new Date().toLocaleString('en-IN')}.</p>`
      : `<div class="card empty-block"><h3>Nothing to report yet</h3><p>Reports appear after you check a payment.</p>${goCheck}</div>`);
    bindOut(); animateDonut();
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.fill').forEach(f => f.style.width = f.dataset.w + '%')));
    if ($('#print')) $('#print').onclick = () => print();
    if ($('#csv')) $('#csv').onclick = () => {
      const cols = ['created_at', 'amount', 'txn_hour', 'txn_type', 'merchant_category', 'is_international', 'new_device', 'new_beneficiary', 'txns_last_24h', 'account_age_days', 'avg_amount_30d', 'risk_score', 'verdict', 'reasons'];
      const q = v => '"' + String(Array.isArray(v) ? v.join('; ') : v).replace(/"/g, '""') + '"';
      const csv = [cols.join(','), ...l.map(t => cols.map(k => q(t[k])).join(','))].join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'fraud-report.csv'; a.click(); URL.revokeObjectURL(a.href);
    };
  }

  /* ---------- model ---------- */
  async function model() {
    const m = await api('/model'), cf = m.confusion, pc = x => (x * 100).toFixed(1) + '%';
    view.innerHTML = head('Model', 'How the fraud model was trained and how well it did on payments it had never seen.') + `
      <div class="grid stats">
        <div class="card stat"><small>Precision</small><strong>${pc(m.precision)}</strong></div>
        <div class="card stat"><small>Recall</small><strong>${pc(m.recall)}</strong></div>
        <div class="card stat"><small>ROC AUC</small><strong>${m.roc_auc.toFixed(3)}</strong></div>
        <div class="card stat"><small>F1 score</small><strong>${m.f1.toFixed(3)}</strong></div>
      </div>
      <div class="grid two">
        <div class="card"><h3>Test results on ${m.test_rows.toLocaleString('en-IN')} payments</h3>
          <div class="confusion"><span></span><div class="h">Predicted safe</div><div class="h">Predicted fraud</div>
            <div class="h">Actually safe</div><div class="g"><strong>${cf.tn.toLocaleString('en-IN')}</strong>correct</div><div class="r"><strong>${cf.fp}</strong>false alarms</div>
            <div class="h">Actually fraud</div><div class="r"><strong>${cf.fn}</strong>missed</div><div class="g"><strong>${cf.tp}</strong>caught</div></div></div>
        <div class="card"><h3>About this model</h3>
          <p class="muted">Gradient boosting classifier trained on ${m.train_rows.toLocaleString('en-IN')} payments (${(m.fraud_rate * 100).toFixed(1)}% fraud). It looks at amount against your usual spend, time of day, payment type, merchant category, new devices and beneficiaries, payment bursts, and account age.</p>
          <p class="note">Trained on generated data that follows common fraud patterns, not on real bank records. Use results as guidance and always confirm with your bank. Last trained ${esc(m.trained_at)}.</p></div>
      </div>`;
    bindOut();
  }
})();
