// app.js - MC-Lite phone PWA (#3920): token screen, step 1 'Turn on alerts' (Web Push subscription on the push-subs issue), step 2 the live runs home screen.
// No backend: the GitHub API is called straight from the browser with the token typed once and kept in localStorage.
const REPO = 'hinermandanny-dev/mclite', API = localStorage.getItem('gh-api') || 'https://api.github.com';   // gh-api: only phonerunscheck sets it (a mocked GitHub)
const $ = (h) => { document.getElementById('app').innerHTML = h; };
const tok = () => localStorage.getItem('gh-token');
const gh = async (method, path, body) => {
  const r = await fetch(API + path.replace('{repo}', REPO), { method, headers: { Authorization: 'Bearer ' + tok(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${method} ${path}`);
  return r.status === 204 ? null : r.json();
};
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function subsIssue() {
  const l = await gh('GET', '/repos/{repo}/issues?labels=push-subs&state=open&per_page=1');
  return (l[0] || await gh('POST', '/repos/{repo}/issues', { title: 'push subscriptions (one comment per device; written by the phone app)', labels: ['push-subs'] })).number;
}
async function turnOn() {
  const msg = (t, c) => { document.getElementById('msg').className = c || ''; document.getElementById('msg').textContent = t; };
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return msg('This browser has no push. Open the app from the Home Screen icon (iOS 16.4 or newer).', 'bad');
    if (await Notification.requestPermission() !== 'granted') return msg('Alerts are blocked. Allow them in Settings > Notifications > MC-Lite.', 'bad');
    const reg = await navigator.serviceWorker.ready;
    const key = (await gh('GET', '/repos/{repo}/actions/variables/MCLITE_VAPID')).value;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    const n = await subsIssue(), at = await gh('GET', `/repos/{repo}/issues/${n}/comments?per_page=100`), w = Subs.upsert(at, sub.toJSON());
    if (w.method === 'PATCH') await gh('PATCH', `/repos/{repo}/issues/comments/${w.id}`, { body: w.body });
    else await gh('POST', `/repos/{repo}/issues/${n}/comments`, { body: w.body });
    msg('Alerts are on for this phone.', 'ok');
  } catch (e) { msg(String(e.message || e), 'bad'); }
}
function settings() {
  $(`<p><a href="#/">&larr; Live runs</a></p><div class="card">${standalone() ? '' : '<p><b>Install first:</b> tap Share, then <b>Add to Home Screen</b>, then open MC-Lite from your Home Screen. Alerts only work from the installed app.</p>'}
    <button id="on">Turn on alerts</button><p id="msg"><small>You will get a notification when the brain needs you.</small></p>
    <button class="alt" id="out">Change token</button></div>`);
  document.getElementById('on').onclick = turnOn;
  document.getElementById('out').onclick = () => { localStorage.removeItem('gh-token'); start(); };
}
// ---- step 2 (#4175): the live runs home screen. Auto-refresh every 15 s while the app is open and showing it (also pull down, or on return to the app).
const E = (s) => Runs.esc(s), data = { running: [], queued: [], comments: [], loaded: 0, err: '' }, seen = {};
const markerCache = () => { try { return JSON.parse(localStorage.getItem('run-markers') || '{}'); } catch { return {}; } };
const saveMarkers = (m) => { try { const k = Object.keys(m).slice(-200), o = {}; k.forEach((x) => { o[x] = m[x]; }); localStorage.setItem('run-markers', JSON.stringify(o)); } catch { /* storage may be off: markers are re-found */ } };
// A worker's issue is named by the marker comment the launcher leaves on it. It is found once per run (a few pages of comments since the run started) and remembered.
async function markersFor(runs, comments) {
  const known = { ...markerCache(), ...Runs.parseMarkers(comments) };
  for (const r of runs.filter((x) => ['worker', 'tester', 'fixer', 'commander', 'chore'].includes(Runs.roleOf(x)) && !known[x.id])) {
    if (Date.now() - (seen[r.id] || 0) < 120e3) continue;                    // looked a moment ago: not again for 2 minutes
    seen[r.id] = Date.now();
    for (let p = 1; p <= 4 && !known[r.id]; p++) {
      const page = await gh('GET', `/repos/{repo}/issues/comments?sort=created&direction=asc&per_page=100&page=${p}&since=${encodeURIComponent(r.run_started_at || r.created_at)}`);
      Object.assign(known, Runs.parseMarkers(page));
      if (page.length < 100) break;
    }
  }
  saveMarkers(known);
  return known;
}
async function load() {
  try {
    const [a, q, c] = await Promise.all([
      gh('GET', '/repos/{repo}/actions/runs?status=in_progress&per_page=50'), gh('GET', '/repos/{repo}/actions/runs?status=queued&per_page=50'),
      gh('GET', `/repos/{repo}/issues/comments?sort=created&direction=desc&per_page=100&since=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`)]);
    Object.assign(data, { running: a.workflow_runs || [], queued: q.workflow_runs || [], comments: c, loaded: Date.now(), err: '' });
    data.markers = await markersFor(data.running, c);
  } catch (e) { data.err = String(e.message || e); }
}
// ---- Home (#4979): usage, master, the lander queue, runners and the fill. Fetched at most once a minute; each piece fails on its own.
const ACCT_PATH = (n) => `/repos/{repo}/actions/variables/FILL_WORKERS_${n.toUpperCase()}`, ACCOUNTS = ['max', 'pro'];   // #5045: each account's own worker count; FILL_WORKERS stays the master on/off
const home = { at: 0, usage: [], fill: null, acct: [], factor: 1, commitAt: '', reds: null, queue: null, runners: null, busy: false };
async function loadHome(force) {
  if (home.busy || (!force && Date.now() - home.at < 60e3)) return;
  home.busy = true;
  const t = (p) => p.catch(() => undefined);
  try {
    const [u, f, cm, rd, pr, rn, am, ap, rl] = await Promise.all([t(getVar('/repos/{repo}/actions/variables/MCLITE_USAGE')), t(getVar(FILL)), t(gh('GET', '/repos/{repo}/commits/master')),
      t(gh('GET', '/repos/{repo}/issues?state=open&labels=severe&per_page=100')), t(gh('GET', '/repos/{repo}/pulls?state=open&per_page=50')), t(gh('GET', '/repos/{repo}/actions/runners?per_page=100')),
      t(getVar(ACCT_PATH('max'))), t(getVar(ACCT_PATH('pro'))), t(gh('GET', '/repos/{repo}/contents/tools/brain/roles.json'))]);
    let quiet = null; try { quiet = JSON.parse(decodeURIComponent(escape(atob(String(rl.content).replace(/\s/g, ''))))).fill.quiet; } catch { /* the quiet factor stays 1 */ }   // #5045: targets are the set count x the quiet-hours factor
    home.factor = Home.quietFactor(quiet, Date.now()); home.acct = Home.acctFill({ max: am, pro: ap }, home.factor);
    Object.assign(home, { at: Date.now(), usage: u ? Home.parseUsage(u, Date.now()) : [], fill: f == null ? null : f, commitAt: cm && cm.commit ? cm.commit.committer.date : '', reds: rd ? Home.redChecks(rd) : null, queue: pr ? Home.landQueue(pr) : null, runners: Home.runnerCount(rn) });
  } finally { home.busy = false; }
}
const SESSION_ROLES = ['worker', 'tester', 'fixer', 'commander', 'chore'];
function meter(label, pct, resets) {
  if (pct == null) return '';
  const on = Home.cells(pct), cs = Array.from({ length: Home.CELLS }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
  return `<div class="meter"><span>${label}</span><div class="cells ${Home.tone(pct)}" role="img" aria-label="${label} ${pct} percent used">${cs}</div><span class="pct">${Math.round(pct)}%${resets ? `<small>${E(resets)}</small>` : ''}</span></div>`;
}
function homeHtml() {
  const cs = Runs.cards(data.running, data.queued, data.comments, data.markers), live = cs.filter((c) => c.state === 'running' && SESSION_ROLES.includes(c.role)).length, now = Date.now();
  const red = home.reds ? home.reds.length : null, q = home.queue ? home.queue.length : 0;
  const head = Home.headline({ live, red, queue: q, fill: home.fill });
  const usage = home.usage.length ? home.usage.map((a) => `<div class="acc${a.stale ? ' stale' : ''}"><div class="who"><b>${E(a.key)}</b><small>${a.stale ? 'reading is old' : E(a.email)}</small></div>
      ${meter('Week', a.week, a.weekResets ? 'resets in ' + Home.resetsIn(a.weekResets, now) : '')}${meter('5 hours', a.win, a.winResets ? 'resets in ' + Home.resetsIn(a.winResets, now) : '')}</div>`).join('') : '<p class="empty">Usage is not available yet.</p>';
  const fs = Home.fillSummary(home.acct, home.fill, home.factor), runTxt = home.runners ? `${home.runners.online}/${home.runners.total}` : '?';
  return `<p class="head ${red ? 'bad' : 'ok'}">${E(head)}</p><p class="sub">Updated ${data.loaded ? new Date(data.loaded).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'never'}. Pull down to refresh.</p>
    <div class="card" id="usage">${usage}</div>
    <div class="tiles">
      <a class="tile ${red ? 'bad' : red === 0 ? 'ok' : ''}" href="https://github.com/${REPO}/issues?q=is%3Aopen+RED+label%3Asevere"><b>${red == null ? '?' : red}</b><span>red on master</span></a>
      <a class="tile" href="https://github.com/${REPO}/pulls?q=is%3Aopen+label%3Aland"><b>${home.queue ? q : '?'}</b><span>waiting to land</span></a>
      <a class="tile" href="#/controls"><b>${E(fs.big)}</b><span>${E(fs.small)}</span></a>
      <div class="tile"><b>${runTxt}</b><span>runners online</span></div>
      <div class="tile wide"><b>${home.commitAt ? E(Home.ago(home.commitAt, now)) : '?'}</b><span>last change landed on master</span>${red ? `<p class="reds">${E(home.reds.slice(0, 12).join(', '))}${home.reds.length > 12 ? ' and more' : ''}</p>` : ''}</div>
    </div><h2>Running now</h2>`;
}
const cardHtml = (c) => `<a class="run ${c.state}" href="#/run/${c.id}"><div class="top"><span class="badge" style="background:${c.colour}">${E(c.name)}</span>${c.account ? `<span class="acct">@${E(c.account)}</span>` : ''}${c.model ? `<span class="acct model">${E(Runs.modelName(c.model))}</span>` : ''}<span class="age" data-since="${E(c.startedAt)}">${Runs.elapsed(c.startedAt, Date.now())}</span></div>
  <div class="what">${c.issue ? `<b>#${c.issue}</b> ${E(c.title)}` : E(c.title || c.runTitle)}</div>${c.state === 'running' ? '<div class="tokline">Tokens and cost appear when this run ends (Claude reports them only then)</div>' : ''}${c.last ? `<div class="last">${E(c.last.text)}</div>` : ''}</a>`;
function runsHtml() {
  const cs = Runs.cards(data.running, data.queued, data.comments, data.markers), live = cs.filter((c) => c.state === 'running'), wait = cs.filter((c) => c.state === 'queued'), done = Runs.ended(data.comments, Date.now());
  return `<div class="bar"><b>${live.length} running</b>${wait.length ? `, ${wait.length} waiting` : ''}<small id="stamp"> &middot; updated ${data.loaded ? new Date(data.loaded).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : 'never'}</small></div>
    ${data.err ? `<p class="bad">Could not refresh: ${E(data.err)}</p>` : ''}${live.map(cardHtml).join('') || '<p class="empty">Nothing is running right now.</p>'}
    ${wait.length ? `<h2>Waiting to start</h2>${wait.map(cardHtml).join('')}` : ''}
    <details class="done"><summary>Finished in the last hour (${done.length})</summary>${done.map((d) => `<div class="end"><span class="${d.ok ? 'ok' : 'bad'}">${d.ok ? '&#10003;' : '&#10007;'}</span> <b>${E(d.role)}</b> <small>${new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>${endStat(d)}<div>${E(d.text)}</div></div>`).join('') || '<p class="empty">No runs ended yet.</p>'}</details>`;
}
let openDone = false;
/** the Refresh button on Home, Stats and Talk: reload that screen now (the 15 s auto-refresh and pull-down stay) */
function wireRefresh(fn) {
  const b = document.getElementById('rf'); if (!b) return;
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Refreshing\u2026';
    try { await fn(); } catch { /* the screen shows its own error */ }
    const x = document.getElementById('rf'); if (x) { x.disabled = false; x.innerHTML = '&#8635; Refresh'; }
  };
}
/** one line of numbers for a finished run: model, tokens, USD, turns, the Pro/Max 5h change */
const endStat = (d) => d.model ? `<div class="tokline">${E(Runs.modelName(d.model))} &middot; ${Runs.fmtTok(d.tin + d.tout + d.cw + d.cr)} tokens (${Runs.fmtTok(d.tout)} out) &middot; $${d.cost.toFixed(2)} &middot; ${d.turns} turns${d.to5h != null ? ` &middot; ${E(d.acct)} 5h ${d.from5h}&rarr;${d.to5h}%` : ''}</div>` : '';
function drawRuns() {
  const d = document.querySelector('details.done'); if (d) openDone = d.open;
  $(`<p class="nav"><button class="alt rf" id="rf">&#8635; Refresh</button><a href="#/settings">Alerts &amp; token</a></p>${homeHtml()}${runsHtml()}`);
  wireRefresh(async () => { await load(); await loadHome(true).catch(() => {}); if (route.at === 'home') drawRuns(); });
  const n = document.querySelector('details.done'); if (n && openDone) n.open = true;
}
async function refresh() { if (route.at !== 'home') return; await load(); if (route.at === 'home') drawRuns(); loadHome().then(() => { if (route.at === 'home' && home.at) drawRuns(); }).catch(() => {}); }
// ---- tap a card: its issue, its PR/branch, the lines it posted, and the tail of its log when GitHub lets the phone read it
async function detail(id) {
  $('<p><a href="#/">&larr; Live runs</a></p><div class="card"><p>Loading&hellip;</p></div>');
  if (!data.loaded) await load();
  const c = Runs.cards(data.running, data.queued, data.comments, data.markers).find((x) => String(x.id) === String(id));
  if (route.at !== 'run') return;
  if (!c) return $('<p><a href="#/">&larr; Live runs</a></p><div class="card"><p>That run has finished or is not in the list any more. It is under &ldquo;Finished in the last hour&rdquo; if it ended recently.</p></div>');
  let jobs = [], pr = null, log = '';
  try { jobs = (await gh('GET', `/repos/{repo}/actions/runs/${id}/jobs`)).jobs || []; } catch { /* shown without the job */ }
  if (c.issue) { try { pr = (await gh('GET', '/repos/{repo}/pulls?state=open&per_page=100')).find((p) => p.head.ref.startsWith(`work/${c.issue}-`) || new RegExp(`#${c.issue}\\b`).test(p.title)) || null; } catch { /* no PR info */ } }
  const job = jobs.find((j) => j.status === 'in_progress') || jobs[jobs.length - 1];
  if (job) { try { const r = await fetch(`${API}/repos/${REPO}/actions/jobs/${job.id}/logs`, { headers: { Authorization: 'Bearer ' + tok() } }); if (r.ok) log = (await r.text()).split('\n').filter(Boolean).slice(-20).join('\n'); } catch { /* the log host may refuse the phone: say so below */ } }
  const mine = data.comments.filter((x) => !String(x.body || '').startsWith(Runs.MARK) && Date.parse(x.created_at) >= Date.parse(c.startedAt) && (c.issue ? new RegExp(`#${c.issue}\\b`).test(Runs.bodyText(x.body)) : new RegExp(`^${c.role}:`, 'i').test(Runs.bodyText(x.body)))).slice(0, 20);
  const step = job && (job.steps || []).find((s) => s.status === 'in_progress');
  $(`<p><a href="#/">&larr; Live runs</a></p><div class="card"><div class="top"><span class="badge" style="background:${c.colour}">${E(c.name)}</span>${c.account ? `<span class="acct">@${E(c.account)}</span>` : ''}${c.model ? `<span class="acct model">${E(Runs.modelName(c.model))}</span>` : ''}<span class="age" data-since="${E(c.startedAt)}">${Runs.elapsed(c.startedAt, Date.now())}</span></div>
    <div class="what">${c.issue ? `<b>#${c.issue}</b> ${E(c.title)}` : E(c.title || c.runTitle)}</div>
    <p><small>${c.state === 'queued' ? 'Waiting for a runner.' : `Running on ${E((job && job.runner_name) || 'a runner')}${step ? `, step: ${E(step.name)}` : ''}.`}</small></p>
    ${c.issue ? `<p><a href="https://github.com/${REPO}/issues/${c.issue}">Issue #${c.issue}</a>${pr ? ` &middot; <a href="${E(pr.html_url)}">PR #${pr.number}</a> <small>(${E(pr.head.ref)})</small>` : ' <small>&middot; no PR yet</small>'}</p>` : ''}
    <p><a href="${E(c.url)}">Open the run on GitHub</a></p></div>
    <h2>Message this session</h2>${talkBox(Home.addressForRun(c), c.issue ? 'The session on this issue reads it at its next step, usually within a few minutes.' : 'This run has no issue of its own, so the message goes to ' + Home.addressForRun(c) + '.')}
    <h2>Last lines it posted</h2><div class="card">${mine.map((x) => `<div class="end"><small>${new Date(x.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small><div>${E(Runs.clip(Runs.bodyText(x.body), 240))}</div></div>`).join('') || '<p class="empty">It has not posted anything yet.</p>'}</div>
    <h2>End of the run log</h2><div class="card">${log ? `<pre>${E(log)}</pre>` : '<p class="empty">GitHub did not let the phone read the log. Use &ldquo;Open the run on GitHub&rdquo; above.</p>'}</div>`);
  wireTalk();
}
// ---- talk to the runners (#4979): a message box on a run, and the Talk tab with the live bus
const talk = { to: 'commander', type: 'reply', text: '', msg: '', bad: false, all: false, feed: [], loaded: 0, busy: false };
const typePicker = () => `<div class="types" role="radiogroup" aria-label="Message type">${Home.TYPES.map((t) => `<button type="button" class="alt ty${talk.type === t.type ? ' on' : ''}" data-ty="${t.type}" role="radio" aria-checked="${talk.type === t.type}">${E(t.label)}</button>`).join('')}</div><small id="tytxt">${E(Home.typeInfo(talk.type).hint)}</small>`;
function talkBox(to, hint) {
  return `<div class="card" data-to="${E(to)}"><textarea id="tt" placeholder="Write to ${E(to)}" aria-label="Message to ${E(to)}">${E(talk.text)}</textarea>${typePicker()}<small id="thint">${E(hint)}</small>
    <button id="tsend">Send to ${E(to)}</button><p id="tmsg" class="${talk.bad ? 'bad' : 'ok'}">${E(talk.msg)}</p></div>`;
}
async function sendTalk(to, text) {
  const m = Home.compose(to, text, talk.type);
  if (!m) { talk.msg = 'Write a message first.'; talk.bad = true; return false; }
  try { await postBus(m); talk.text = ''; talk.msg = `Sent to ${to}.`; talk.bad = false; return true; } catch (e) { talk.msg = need(e); talk.bad = true; return false; }
}
function wireTalk() {
  const box = document.querySelector('[data-to]'), ta = document.getElementById('tt'), btn = document.getElementById('tsend');
  if (!box || !ta || !btn) return;
  ta.oninput = () => { talk.text = ta.value; };
  document.querySelectorAll('button.ty').forEach((b) => { b.onclick = () => { talk.type = b.dataset.ty; document.querySelectorAll('button.ty').forEach((x) => { const on = x.dataset.ty === talk.type; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); const t = document.getElementById('tytxt'); if (t) t.textContent = Home.typeInfo(talk.type).hint; }; });
  btn.onclick = async () => { btn.disabled = true; const ok = await sendTalk(box.dataset.to, ta.value); if (route.at === 'bus') { await busFeed(); drawBus(); } else if (route.at === 'run') { const p = document.getElementById('tmsg'); if (p) { p.textContent = talk.msg; p.className = talk.bad ? 'bad' : 'ok'; } ta.value = talk.text; btn.disabled = false; } if (!ok) btn.disabled = false; };
}
async function busFeed() {
  const bus = await busNumber(), since = encodeURIComponent(new Date(Date.now() - 6 * 3600e3).toISOString()), out = [];
  for (let p = 1; p <= 3; p++) {
    const page = await gh('GET', `/repos/{repo}/issues/${bus}/comments?per_page=100&page=${p}&since=${since}`); out.push(...page);
    if (page.length < 100) break;
  }
  talk.feed = Home.parseBus(out); talk.loaded = Date.now();
}
const talkVisible = (m) => talk.all || (m.to !== 'log' && m.from !== 'brain');
function feedHtml() {
  const rows = talk.feed.filter(talkVisible).slice(0, 60);
  return rows.map((m) => `<div class="msg ${m.from === 'dan' ? 'dan' : ''}"><div class="who"><b>${E(m.from)}</b> to ${E(m.to)}${m.type && m.type !== 'reply' ? ` <span class="x">${E(Home.typeInfo(m.type).label.toLowerCase())}</span>` : ''} &middot; ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}${m.n > 1 ? ` <span class="x">&times;${m.n}</span>` : ''}</div><div class="t">${E(Runs.clip(m.text, 600))}</div></div>`).join('') || '<p class="empty">Nothing on the bus in the last 6 hours.</p>';
}
function drawBus() {
  if (route.at !== 'bus') return;
  const cards = Runs.cards(data.running, data.queued, data.comments, data.markers), addr = Home.addresses(cards);
  if (!addr.some((a) => a.to === talk.to)) talk.to = 'commander';
  const cur = addr.find((a) => a.to === talk.to);
  $(`<div class="card" data-to="${E(talk.to)}"><select id="tto" aria-label="Send to">${addr.map((a) => `<option value="${E(a.to)}"${a.to === talk.to ? ' selected' : ''}>${E(a.label)}</option>`).join('')}</select>
    <textarea id="tt" placeholder="Write a message" aria-label="Message">${E(talk.text)}</textarea>${typePicker()}<small id="thint">${E(cur.hint)}.</small><button id="tsend">Send</button><p id="tmsg" class="${talk.bad ? 'bad' : 'ok'}">${E(talk.msg)}</p></div>
    <h2>The bus</h2><button class="alt rf" id="rf" style="margin:0 8px 6px 0">&#8635; Refresh</button><button class="alt" id="tall" style="margin:0 0 6px">${talk.all ? 'Showing everything, tap for conversations only' : 'Showing conversations, tap for everything'}</button><div class="card" id="feed">${feedHtml()}</div>`);
  document.getElementById('tto').onchange = (e) => { talk.to = e.target.value; document.querySelector('[data-to]').dataset.to = talk.to; drawBus(); };
  document.getElementById('tall').onclick = () => { talk.all = !talk.all; drawBus(); };
  wireTalk(); wireRefresh(async () => { await load(); await busFeed(); drawBus(); });
}
async function showBus() {
  talk.msg = ''; if (!talk.loaded) $('<div class="card"><p>Loading&hellip;</p></div>');
  if (!data.loaded) await load();
  try { await busFeed(); } catch (e) { talk.msg = need(e); talk.bad = true; }
  drawBus();
}
async function pollBus() { if (route.at !== 'bus' || document.hidden || !tok() || talk.busy) return; talk.busy = true; try { await busFeed(); const f = document.getElementById('feed'); if (f && route.at === 'bus') f.innerHTML = feedHtml(); } catch { /* next poll */ } talk.busy = false; }
// ---- step 3 (#4176): one-tap controls and the questions to Dan
const FILL = '/repos/{repo}/actions/variables/FILL_WORKERS', BEFORE = '/repos/{repo}/actions/variables/FILL_WORKERS_BEFORE_PAUSE';
const ctl = { fill: undefined, before: undefined, acct: { max: null, pro: null }, acctPending: { max: null, pro: null }, pending: null, msg: '', armed: '', qs: [], qMsg: '', qLoaded: 0 };
const getVar = async (path) => { try { return (await gh('GET', path)).value; } catch (e) { if (/ 404 /.test(e.message)) return null; throw e; } };
async function setVar(path, name, value) {                              // value null = remove the variable (the brain then follows roles.json)
  if (value == null) { try { await gh('DELETE', path); } catch (e) { if (!/ 404 /.test(e.message)) throw e; } return; }
  try { await gh('PATCH', path, { name, value: String(value) }); } catch (e) { if (!/ 404 /.test(e.message)) throw e; await gh('POST', '/repos/{repo}/actions/variables', { name, value: String(value) }); }
}
let busNo = 0;
const busNumber = async () => busNo || (busNo = (await gh('GET', '/repos/{repo}/issues?labels=bus&state=open&per_page=1'))[0].number);
const postBus = async (body) => gh('POST', `/repos/{repo}/issues/${await busNumber()}/comments`, { body });
const need = (e) => (/ (401|403) /.test(e.message) ? 'This token is not allowed to do that. The phone token needs write access to Actions, Variables and Issues on the mclite repo.' : String(e.message || e));
const loadFill = async () => { ctl.fill = await getVar(FILL); ctl.before = await getVar(BEFORE); for (const n of ACCOUNTS) ctl.acct[n] = await getVar(ACCT_PATH(n)); };
async function applyAcct(name, n) {                                       // n null = remove the switch (that account follows roles.json again)
  try { if (n != null) n = Controls.clampFill(n); await setVar(ACCT_PATH(name), 'FILL_WORKERS_' + name.toUpperCase(), n); await postBus(Controls.busAcctLine(name, n)); ctl.acct[name] = n == null ? null : String(n); ctl.msg = n == null ? `${name}: back to roles.json.` : `${name} fill set to ${n}. The brain tops up on its next bus message.`; } catch (e) { ctl.msg = need(e); }
}
const acctTimers = {};
function stepAcct(name, d) {
  const cur = ctl.acctPending[name] != null ? ctl.acctPending[name] : (ctl.acct[name] == null || ctl.acct[name] === '' ? 0 : Controls.clampFill(ctl.acct[name]));
  ctl.acctPending[name] = Controls.clampFill(cur + d); drawControls(); clearTimeout(acctTimers[name]);
  acctTimers[name] = setTimeout(async () => { const n = ctl.acctPending[name]; ctl.acctPending[name] = null; await applyAcct(name, n); if (route.at === 'controls') drawControls(); }, 900);
}
async function applyFill(n) {
  n = Controls.clampFill(n);
  try { await setVar(FILL, 'FILL_WORKERS', n); await postBus(Controls.busFillLine(n)); ctl.fill = String(n); ctl.msg = `Fill set to ${n}. The brain tops up on its next bus message.`; } catch (e) { ctl.msg = need(e); }
}
let fillTimer = null;
function step(d) {                                                      // one tap = one step; the write follows 0.9 s after the last tap
  const cur = ctl.pending != null ? ctl.pending : (Controls.fillLabel(ctl.fill) === 'auto' ? 5 : Controls.clampFill(ctl.fill));
  ctl.pending = Controls.clampFill(cur + d); drawControls(); clearTimeout(fillTimer);
  fillTimer = setTimeout(async () => { const n = ctl.pending; ctl.pending = null; await applyFill(n); if (route.at === 'controls') drawControls(); }, 900);
}
async function pauseResume() {
  try {
    await loadFill(); const p = Controls.pausePlan(ctl.fill, ctl.before);
    if (p.paused) { await setVar(FILL, 'FILL_WORKERS', p.resumeTo === 'auto' ? null : p.resumeTo); await setVar(BEFORE, 'FILL_WORKERS_BEFORE_PAUSE', null); await postBus(Controls.busFillLine(p.resumeTo)); ctl.msg = `Resumed: the fill is back to ${p.resumeTo}.`; }
    else { await setVar(BEFORE, 'FILL_WORKERS_BEFORE_PAUSE', p.saveBefore); await setVar(FILL, 'FILL_WORKERS', p.setTo); await postBus(Controls.busFillLine(0)); ctl.msg = 'Paused: no new workers start. Running ones finish their issue.'; }
    await loadFill();
  } catch (e) { ctl.msg = need(e); }
  drawControls();
}
async function startRole(role) {                                        // a session costs usage: the first tap arms the button, the second starts it
  if (ctl.armed !== role) { ctl.armed = role; drawControls(); setTimeout(() => { if (ctl.armed === role) { ctl.armed = ''; if (route.at === 'controls') drawControls(); } }, 4000); return; }
  ctl.armed = '';
  try { await gh('POST', '/repos/{repo}/actions/workflows/brain.yml/dispatches', { ref: 'master', inputs: { role, reason: 'started from the phone by Dan' } }); ctl.msg = `The ${role} is starting (about a minute). It will show under Runs.`; } catch (e) { ctl.msg = need(e); }
  drawControls();
}
async function drawControls() {
  if (route.at !== 'controls') return;
  const shown = ctl.pending != null ? String(ctl.pending) : Controls.fillLabel(ctl.fill), paused = shown === '0';
  $(`<div class="card"><div class="fillrow"><button class="alt step" id="minus" aria-label="one fewer worker">&minus;</button><div class="big"><span id="fillN">${E(shown)}</span><small>${shown === 'auto' ? 'the brain decides' : ACCOUNTS.some((n) => ctl.acct[n] != null) ? 'master switch (0 stops all)' : 'workers wanted'}</small></div><button class="alt step" id="plus" aria-label="one more worker">+</button></div>
    <button class="alt" id="pause">${paused ? `Resume the fill${ctl.before ? ` (back to ${E(ctl.before)})` : ''}` : 'Pause the fill'}</button></div>
    <h2>Workers per account</h2><div class="card">${ACCOUNTS.map((n) => { const v = ctl.acctPending[n] != null ? String(ctl.acctPending[n]) : ctl.acct[n] == null || ctl.acct[n] === '' ? 'not set' : String(ctl.acct[n]); return `<div class="fillrow"><button class="alt step" id="m-${n}" aria-label="one fewer ${n} worker">&minus;</button><div class="big"><span>${E(v)}</span><small>${n[0].toUpperCase() + n.slice(1)}${v === 'not set' ? ' (roles.json decides)' : ''}${v !== 'not set' && home.factor !== 1 ? ` \u00b7 now runs ${Math.ceil(Number(v) * home.factor)}` : ''}</small></div><button class="alt step" id="p-${n}" aria-label="one more ${n} worker">+</button></div><button class="alt" id="c-${n}"${ctl.acct[n] == null ? ' disabled' : ''}>${n[0].toUpperCase() + n.slice(1)}: back to roles.json</button>`; }).join('')}</div>
    <h2>Start a session</h2><div class="card"><button class="${ctl.armed === 'commander' ? 'warn' : ''}" id="s-commander">${ctl.armed === 'commander' ? 'Tap again to start the commander' : 'Start the commander'}</button>
    <button class="${ctl.armed === 'fixer' ? 'warn' : ''}" id="s-fixer">${ctl.armed === 'fixer' ? 'Tap again to start the fixer' : 'Start the fixer'}</button></div>
    <p id="cmsg" class="${/not allowed|GitHub \d/.test(ctl.msg) ? 'bad' : 'ok'}">${E(ctl.msg)}</p>`);
  document.getElementById('minus').onclick = () => step(-1); document.getElementById('plus').onclick = () => step(1);
  document.getElementById('pause').onclick = pauseResume;
  for (const n of ACCOUNTS) { document.getElementById('m-' + n).onclick = () => stepAcct(n, -1); document.getElementById('p-' + n).onclick = () => stepAcct(n, 1); document.getElementById('c-' + n).onclick = async () => { await applyAcct(n, null); drawControls(); }; }
  document.getElementById('s-commander').onclick = () => startRole('commander'); document.getElementById('s-fixer').onclick = () => startRole('fixer');
}
async function showControls() { ctl.msg = ''; $('<div class="card"><p>Loading&hellip;</p></div>'); try { await loadFill(); await loadHome().catch(() => {}); } catch (e) { ctl.msg = need(e); } drawControls(); }
// ---- questions to Dan: button cards; the icon badge is how many are open
function setBadge() {
  const n = Controls.badgeCount(ctl.qs), t = document.getElementById('qn'); if (t) t.textContent = n ? ` (${n})` : '';
  try { if (n && navigator.setAppBadge) navigator.setAppBadge(n); else if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch { /* the Badging API is optional */ }
}
async function loadQuestions() {
  const l = await gh('GET', '/repos/{repo}/issues?labels=dan-questions&state=open&per_page=1');
  ctl.qs = l.length ? Controls.openQuestions(await gh('GET', `/repos/{repo}/issues/${l[0].number}/comments?per_page=100&since=${encodeURIComponent(new Date(Date.now() - 14 * 864e5).toISOString())}`)) : [];
  ctl.qLoaded = Date.now(); setBadge();
}
function drawQuestions() {
  if (route.at !== 'questions') return;
  $(`${ctl.qMsg ? `<p class="${/not allowed|GitHub \d/.test(ctl.qMsg) ? 'bad' : 'ok'}">${E(ctl.qMsg)}</p>` : ''}${ctl.qs.map((q, i) => `<div class="card q"><small>from ${E(q.from)} &middot; ${new Date(q.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>
      <div class="qtext">${E(q.text).replace(/\n/g, '<br>')}</div>${q.options.map((o, j) => `<button class="alt opt" data-q="${i}" data-o="${j}">${E(o)}</button>`).join('')}</div>`).join('') || '<p class="empty">No questions waiting for you.</p>'}`);
  document.querySelectorAll('button.opt').forEach((b) => { b.onclick = () => answerQ(Number(b.dataset.q), Number(b.dataset.o)); });
}
async function answerQ(i, j) {
  const q = ctl.qs[i], c = q && q.options[j]; if (!c) return;
  try { await postBus(Controls.answerMessage(q, c)); try { await gh('PATCH', `/repos/{repo}/issues/comments/${q.mirrorId}`, { body: Controls.answeredBody(q, c) }); } catch { /* answered on the bus is what counts */ } ctl.qs.splice(i, 1); ctl.qMsg = `Sent: ${c}`; } catch (e) { ctl.qMsg = need(e); }
  setBadge(); drawQuestions();
}
async function showQuestions() { ctl.qMsg = ''; if (!ctl.qLoaded) $('<div class="card"><p>Loading&hellip;</p></div>'); try { await loadQuestions(); } catch (e) { ctl.qMsg = need(e); } drawQuestions(); }
async function pollQuestions() { if (!tok() || document.hidden) return; try { await loadQuestions(); if (route.at === 'questions' && !document.activeElement.classList.contains('opt')) drawQuestions(); } catch { /* the next poll tries again */ } }
// ---- Requests tab (#7685, Dan 15 Oct): any request in words; the handler's comments appear as they are written; dashboards, results and Undo buttons render from fenced blocks (requests.js has the contract)
const RQ_MS = Number(localStorage.getItem('rq-poll-ms')) || 10000;   // only phonerequestscheck shortens it
const rq = { list: [], last: {}, at: 0, open: 0, issue: null, comments: [], sig: '', msg: '', bad: false, text: '', reply: '', busy: false, seen: (() => { try { return JSON.parse(localStorage.getItem('req-seen') || '{}'); } catch { return {}; } })() };
const rqSeen = (n, upd) => { rq.seen[n] = Math.max(Date.now(), Date.parse(upd) || 0); try { localStorage.setItem('req-seen', JSON.stringify(rq.seen)); } catch { /* optional */ } };
function setReqBadge() { const n = Requests.unseenCount(rq.list.filter((r) => r.n), rq.seen), t = document.getElementById('rn'); if (t) t.textContent = n ? ` (${n})` : ''; }
async function loadRequests() {
  const l = (await gh('GET', '/repos/{repo}/issues?labels=request&state=all&per_page=50&sort=updated&direction=desc')).filter((i) => !i.pull_request);
  const pend = rq.list.filter((r) => !r.n), real = Requests.sortList(l.map(Requests.parseIssue));
  rq.list = pend.concat(real); rq.at = Date.now(); setReqBadge();
  for (const r of real.slice(0, 12)) {                                       // the newest comment of each card, fetched only when the request changed
    if (rq.last[r.n] && rq.last[r.n].upd === r.updated) continue;
    try { rq.last[r.n] = { upd: r.updated, text: Requests.latest(await gh('GET', `/repos/{repo}/issues/${r.n}/comments?per_page=100`)) }; } catch { /* next poll */ }
  }
}
const rqCard = (r) => `<a class="rq" href="#/requests/${r.n}"><div class="top"><span class="chip ${r.status || 'waiting'}">${E(r.pending ? 'Sending' : Requests.STATUS[r.status] || 'Request')}</span>${Requests.unseenCount([r], rq.seen) && r.n ? '<span class="dot" aria-label="new"></span>' : ''}<span class="age">${r.updated ? E(Home.ago(r.updated, Date.now())) : ''}</span></div><div class="what">${E(r.title)}</div>${rq.last[r.n] && rq.last[r.n].text ? `<div class="last">${E(rq.last[r.n].text)}</div>` : ''}</a>`;
function drawRequests() {
  if (route.at !== 'requests' || rq.open) return;
  $(`<div class="card"><textarea id="rqt" placeholder="Ask for anything, in words" aria-label="New request">${E(rq.text)}</textarea><button id="rqsend"${rq.busy ? ' disabled' : ''}>Send request</button><p id="rqmsg" class="${rq.bad ? 'bad' : 'ok'}">${E(rq.msg)}</p></div>
    ${rq.list.map(rqCard).join('') || '<p class="empty">No requests yet.</p>'}`);
  const ta = document.getElementById('rqt'); ta.oninput = () => { rq.text = ta.value; };
  document.getElementById('rqsend').onclick = sendRequest;
}
async function sendRequest() {
  const c = Requests.composeIssue(rq.text);
  if (!c) { rq.msg = 'Write your request first.'; rq.bad = true; return drawRequests(); }
  const card = { n: 0, pending: true, title: c.title, status: 'waiting', updated: new Date().toISOString() }; rq.list.unshift(card); rq.text = ''; rq.msg = ''; rq.busy = true; drawRequests();
  try {
    const iss = await gh('POST', '/repos/{repo}/issues', c); rqSeen(iss.number, iss.updated_at);
    rq.list = rq.list.filter((r) => r !== card); rq.list.unshift(Requests.parseIssue(iss));
    try { await postBus(Requests.busMail(iss.number)); rq.msg = 'Sent. The handler has been woken.'; rq.bad = false; } catch (e) { rq.msg = 'Saved as #' + iss.number + ' but the handler was not woken: ' + need(e); rq.bad = true; }
  } catch (e) { rq.list = rq.list.filter((r) => r !== card); rq.text = c.body.replace(/\n<!-- request -->$/, ''); rq.msg = need(e); rq.bad = true; }
  rq.busy = false; drawRequests();
}
async function loadThread(n) {
  const [iss, cs] = await Promise.all([gh('GET', `/repos/{repo}/issues/${n}`), gh('GET', `/repos/{repo}/issues/${n}/comments?per_page=100`)]);
  rq.issue = Requests.parseIssue(iss); rq.comments = cs; rqSeen(n, iss.updated_at); setReqBadge();
}
const threadSig = () => rq.comments.map((c) => c.id + ':' + (c.updated_at || '')).join() + '|' + (rq.issue ? rq.issue.status : '');
function commentsHtml() {
  const done = Requests.undone(rq.comments);
  return Requests.thread(rq.comments).map((c) => `<div class="msg ${c.from === 'dan' ? 'dan' : ''}"><div class="who"><b>${E(c.from)}</b> &middot; ${E(Home.ago(c.at, Date.now()))}</div>${c.text ? `<div class="t">${Requests.md(c.text)}</div>` : ''}${c.blocks.map((b) =>
    b.type === 'result' ? `<div class="result">${Requests.md(b.body)}</div>`
    : b.type === 'undo' ? `<div class="undo"><b>${E(b.undo.what)}</b><small>${E(b.undo.undo || '')}</small>${done.has(b.undo.id) ? '<p class="ok">undo requested</p>' : `<button class="alt" data-undo="${E(b.undo.id)}">Undo</button>`}</div>`
    : (Requests.dashboardFrame(b.body) ? `<div class="dashbox">${Requests.dashboardFrame(b.body)}<button class="alt fsb">Full screen</button></div>` : '<p class="bad">A dashboard was too big to show (over 60,000 characters).</p>')).join('')}</div>`).join('');
}
function wireThread() {
  document.querySelectorAll('button[data-undo]').forEach((b) => { b.onclick = () => sendThread(Requests.undoComment(b.dataset.undo), 'undo requested'); });
  document.querySelectorAll('button.fsb').forEach((b) => { b.onclick = () => { const bx = b.closest('.dashbox'), on = bx.classList.toggle('fs'); b.textContent = on ? 'Close' : 'Full screen'; }; });
}
function drawThread(keep) {
  if (route.at !== 'requests' || !rq.open || !rq.issue) return;
  const near = innerHeight + scrollY >= document.body.scrollHeight - 80, box = document.getElementById('rqc');
  if (box && keep) { box.innerHTML = commentsHtml(); document.getElementById('rqchip').textContent = Requests.STATUS[rq.issue.status] || 'Request'; document.getElementById('rqchip').className = 'chip ' + (rq.issue.status || 'waiting'); wireThread(); if (near) scrollTo(0, document.body.scrollHeight); return; }
  $(`<p><a href="#/requests">&larr; Requests</a></p><div class="card"><div class="top"><span id="rqchip" class="chip ${rq.issue.status || 'waiting'}">${E(Requests.STATUS[rq.issue.status] || 'Request')}</span><span class="age">#${rq.issue.n}</span></div><div class="what">${Requests.md(rq.issue.text)}</div></div>
    <div id="rqc">${commentsHtml()}</div><div class="card"><textarea id="rqr" placeholder="Reply, or ask for a change" aria-label="Reply">${E(rq.reply)}</textarea><button id="rqrsend">Send</button><p id="rqmsg" class="${rq.bad ? 'bad' : 'ok'}">${E(rq.msg)}</p></div>`);
  document.getElementById('rqr').oninput = (e) => { rq.reply = e.target.value; };
  document.getElementById('rqrsend').onclick = () => sendThread(Requests.followUp(rq.reply), 'Sent.');
  wireThread(); scrollTo(0, document.body.scrollHeight);
}
async function sendThread(body, ok) {
  if (!body) { rq.msg = 'Write a reply first.'; rq.bad = true; const p = document.getElementById('rqmsg'); if (p) { p.className = 'bad'; p.textContent = rq.msg; } return; }
  const n = rq.open; rq.busy = true;
  try { await gh('POST', `/repos/{repo}/issues/${n}/comments`, { body }); if (/^from: dan\n\n(?!undo )/.test(body)) rq.reply = '';
    try { await postBus(Requests.busMail(n)); rq.msg = ok; rq.bad = false; } catch (e) { rq.msg = 'Saved, but the handler was not woken: ' + need(e); rq.bad = true; }
    await loadThread(n); } catch (e) { rq.msg = need(e); rq.bad = true; }
  rq.busy = false; rq.sig = threadSig(); drawThread(false);
}
async function showRequests(n) {
  rq.open = n ? Number(n) : 0; rq.msg = ''; rq.bad = false;
  if (!rq.open) { if (!rq.at) $('<div class="card"><p>Loading&hellip;</p></div>'); try { await loadRequests(); } catch (e) { rq.msg = need(e); rq.bad = true; } return drawRequests(); }
  $('<div class="card"><p>Loading&hellip;</p></div>');
  try { await loadThread(rq.open); } catch (e) { rq.issue = null; return $(`<p><a href="#/requests">&larr; Requests</a></p><p class="bad">${E(need(e))}</p>`); }
  rq.sig = threadSig(); drawThread(false);
}
async function pollRequests() {
  if (!tok() || document.hidden || rq.busy) return;
  try {
    if (route.at === 'requests' && rq.open) { await loadThread(rq.open); const s = threadSig(); if (s !== rq.sig) { rq.sig = s; drawThread(true); } }
    else if (route.at === 'requests' || Date.now() - rq.at > RQ_MS * 3) { await loadRequests(); if (route.at === 'requests' && !rq.open && document.activeElement.id !== 'rqt') drawRequests(); }
  } catch { /* the next poll tries again */ }
}
// ---- Stats tab (Dan, 10 Oct): usage and run statistics from the bus's 'run ended' lines (last 24 h) plus the project tiles
const stat = { at: 0, list: [], err: '' };
async function loadStats() {
  const bus = await busNumber(), since = encodeURIComponent(new Date(Date.now() - 24 * 3600e3).toISOString()), out = [];
  for (let p = 1; p <= 6; p++) {
    const page = await gh('GET', `/repos/{repo}/issues/${bus}/comments?per_page=100&page=${p}&since=${since}`); out.push(...page);
    if (page.length < 100) break;
  }
  stat.list = Runs.ended(out, Date.now(), 24 * 3600e3); stat.at = Date.now();
}
const money = (x) => '$' + (x >= 10 ? x.toFixed(0) : x.toFixed(2));
const rowHtml = (name, g) => `<div class="srow"><b>${E(name)}</b><span>${g.runs} runs (${g.ok} ok)</span><span>${money(g.cost)}</span><span>${Runs.fmtTok(g.tokens)} tok</span><span>${g.turns} turns</span><span>${g.perTurn ? '$' + g.perTurn.toFixed(3) + '/turn' : ''}</span></div>`;
function drawStats() {
  if (route.at !== 'stats') return;
  const S = Runs.stats(stat.list, true), now = Date.now();
  const usage = home.usage.length ? home.usage.map((a) => `<div class="acc${a.stale ? ' stale' : ''}"><div class="who"><b>${E(a.key)}</b><small>${a.stale ? 'reading is old' : E(a.email)}</small></div>
      ${meter('Week', a.week, a.weekResets ? 'resets in ' + Home.resetsIn(a.weekResets, now) : '')}${meter('5 hours', a.win, a.winResets ? 'resets in ' + Home.resetsIn(a.winResets, now) : '')}</div>`).join('') : '<p class="empty">Usage is not available yet.</p>';
  const red = home.reds ? home.reds.length : '?', q = home.queue ? home.queue.length : '?', runTxt = home.runners ? `${home.runners.online}/${home.runners.total}` : '?';
  const models = Object.entries(S.byModel).sort((x, y) => y[1].cost - x[1].cost), roles = Object.entries(S.byRole).sort((x, y) => y[1].cost - x[1].cost);
  $(`<p class="nav"><button class="alt rf" id="rf">&#8635; Refresh</button><a href="#/settings">Alerts &amp; token</a></p><h2>Usage</h2><div class="card">${usage}</div>
    <h2>Last 24 hours</h2><div class="tiles">
      <div class="tile"><b>${S.runs}</b><span>runs ended (${S.ok} ok)</span></div><div class="tile"><b>${money(S.cost)}</b><span>API-equivalent cost</span></div>
      <div class="tile"><b>${Runs.fmtTok(S.tokens)}</b><span>tokens (${Runs.fmtTok(S.out)} out)</span></div><div class="tile"><b>${S.perTurn ? '$' + S.perTurn.toFixed(3) : '?'}</b><span>per turn (${S.turns} turns)</span></div>
    </div><p class="sub">${S.junk.runs ? `${S.junk.runs} small runs (under 7 turns and $0.10, or no numbers; ${money(S.junk.cost)}) are left out. ` : ''}Cost is what the tokens would cost on the API, not your plan's meter; the meters above are the real limit.${stat.err ? ` <span class="bad">${E(stat.err)}</span>` : ''}</p>
    <h2>By model</h2><div class="card">${models.map(([m, g]) => rowHtml(Runs.modelName(m) || m, g)).join('') || '<p class="empty">No finished runs with numbers yet.</p>'}</div>
    <h2>By kind of run</h2><div class="card">${roles.map(([r, g]) => rowHtml(r, g)).join('') || '<p class="empty">Nothing yet.</p>'}</div>
    <h2>Project</h2><div class="tiles">
      <a class="tile ${red ? 'bad' : red === 0 ? 'ok' : ''}" href="https://github.com/${REPO}/issues?q=is%3Aopen+RED+label%3Asevere"><b>${red}</b><span>red on master</span></a>
      <a class="tile" href="https://github.com/${REPO}/pulls?q=is%3Aopen+label%3Aland"><b>${q}</b><span>waiting to land</span></a>
      <a class="tile" href="#/controls"><b>${E(Home.fillSummary(home.acct, home.fill, home.factor).big)}</b><span>${E(Home.fillSummary(home.acct, home.fill, home.factor).small)}</span></a><div class="tile"><b>${runTxt}</b><span>runners online</span></div>
      <div class="tile wide"><b>${home.commitAt ? E(Home.ago(home.commitAt, now)) : '?'}</b><span>last change landed on master</span></div></div>
    <p class="sub">Updated ${stat.at ? new Date(stat.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'never'}.</p>`);
  wireRefresh(async () => { stat.err = ''; try { await loadStats(); } catch (e) { stat.err = need(e); } await loadHome(true).catch(() => {}); drawStats(); });
}
async function showStats() {
  if (!stat.at) $('<div class="card"><p>Loading&hellip;</p></div>');
  try { stat.err = ''; await loadStats(); } catch (e) { stat.err = need(e); }
  drawStats(); loadHome(true).then(drawStats).catch(() => {});
}
function tabs() {
  const t = document.getElementById('tabs'); if (!t) return; t.hidden = !tok();
  t.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.t === (route.at === 'run' ? 'home' : route.at)));
}
function route() {
  const h = location.hash;
  if (h === '#/settings') { route.at = 'settings'; tabs(); return settings(); }
  if (h === '#/bus') { route.at = 'bus'; tabs(); return showBus(); }
  if (h === '#/stats') { route.at = 'stats'; tabs(); return showStats(); }
  if (h === '#/controls') { route.at = 'controls'; tabs(); return showControls(); }
  if (h === '#/questions') { route.at = 'questions'; tabs(); return showQuestions(); }
  const rm = /^#\/requests(?:\/(\d+))?$/.exec(h);
  if (rm) { route.at = 'requests'; tabs(); return showRequests(rm[1]); }
  const m = /^#\/run\/(\d+)$/.exec(h);
  if (m) { route.at = 'run'; tabs(); return detail(m[1]); }
  route.at = 'home'; tabs(); drawRuns(); refresh(); pollQuestions(); pollRequests();
}
addEventListener('hashchange', () => { if (tok()) route(); });
setInterval(refresh, Number(localStorage.getItem('gh-refresh-ms')) || 15000);
setInterval(pollBus, 10000);
setInterval(pollRequests, RQ_MS);   // #7685: the open thread every 10 s, the list and the badge every 30 s (also from another screen)
setInterval(pollQuestions, (Number(localStorage.getItem('gh-refresh-ms')) || 15000) * 2);   // the badge follows the open questions even from another screen                                                  // the 15 s auto-refresh (the app only; the build never waits on it)
setInterval(() => { document.querySelectorAll('[data-since]').forEach((e) => { e.textContent = Runs.elapsed(e.dataset.since, Date.now()); }); }, 1000);   // the live timers: no network
document.addEventListener('visibilitychange', () => { if (!document.hidden && tok()) refresh(); });
let pullFrom = null;
addEventListener('touchstart', (e) => { pullFrom = scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
addEventListener('touchend', (e) => { if (pullFrom != null && e.changedTouches[0].clientY - pullFrom > 90) refresh(); pullFrom = null; });
function start() {
  if (tok()) return route();
  { const t = document.getElementById('tabs'); if (t) t.hidden = true; }
  $(`<div class="card"><p>Paste your GitHub token once. It stays on this phone.</p><input id="t" type="password" autocomplete="off" placeholder="GitHub token">
    <button id="go">Save</button><p id="msg" class="bad"></p></div>`);
  document.getElementById('go').onclick = async () => {
    localStorage.setItem('gh-token', document.getElementById('t').value.trim());
    try { await gh('GET', '/repos/{repo}'); route(); } catch { localStorage.removeItem('gh-token'); document.getElementById('msg').textContent = 'That token cannot read the repo. Check it and try again.'; }
  };
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
start();
