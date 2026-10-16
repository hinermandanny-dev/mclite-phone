// home.js - the phone's Home screen and the talk-to-runners box (#4979). Pure functions shared by the app (browser) and phonehomecheck (node).
// No network, no DOM. Inputs are GitHub API objects; the app does the fetching.
(function (root) {
  const ms = (t) => Date.parse(t) || 0;
  const CELLS = 20, STALE_MS = 15 * 60e3;
  /** '3 min ago', '2 h ago', '4 d ago' */
  function ago(iso, now) {
    const s = Math.max(0, Math.floor((now - ms(iso)) / 1000));
    if (!ms(iso)) return 'never';
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  /** 'resets in 2h 53m' / '5d 11h' / '' when GitHub gave no time */
  function resetsIn(iso, now) {
    if (!iso || !ms(iso)) return '';
    const m = Math.floor((ms(iso) - now) / 60000);
    if (m <= 0) return 'resetting now';
    if (m < 60) return `${m}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  }
  /** how many of CELLS squares are filled for a percentage (0 stays empty, anything above 0 shows at least one) */
  const cells = (pct) => { const p = Math.min(100, Math.max(0, Number(pct) || 0)); return p === 0 ? 0 : Math.max(1, Math.round((p / 100) * CELLS)); };
  /** colour word for a meter: ok below 70, warn below 90, bad from 90 */
  const tone = (pct) => (Number(pct) >= 90 ? 'bad' : Number(pct) >= 70 ? 'warn' : 'ok');
  /** the MCLITE_USAGE repo variable (a JSON string) -> [{key, email, ok, stale, week, weekResets, win, winResets}] with max and pro first */
  function parseUsage(value, now) {
    let u = null; try { u = typeof value === 'string' ? JSON.parse(value) : value; } catch { u = null; }
    if (!u || !u.accounts) return [];
    const order = ['max', 'pro', 'default'];
    return Object.keys(u.accounts).sort((a, b) => (order.indexOf(a) < 0 ? 9 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 9 : order.indexOf(b))).map((k) => {
      const a = u.accounts[k] || {}, read = ms(a.readAt) || ms(u.at);
      return { key: k, email: a.email || '', ok: a.ok !== false && !!a.week, stale: !read || now - read > STALE_MS,
        week: a.week ? Number(a.week.pct) || 0 : null, weekResets: a.week ? a.week.resets_at : null, win: a.window ? Number(a.window.pct) || 0 : null, winResets: a.window ? a.window.resets_at : null };
    }).filter((a) => a.key !== 'default' || a.ok);
  }
  /** open `severe` issues whose title starts 'RED <check>:' -> ['mountcheck', ...] */
  const redChecks = (issues) => (issues || []).filter((i) => !i.pull_request).map((i) => (/^RED (\w+):/.exec(i.title || '') || [])[1]).filter(Boolean);
  /** PRs waiting in the lander: open and labelled `land` */
  const landQueue = (prs) => (prs || []).filter((p) => (p.labels || []).some((l) => (l.name || l) === 'land'));
  /** runner list from /actions/runners -> {online, total}; null when the token may not read it */
  const runnerCount = (res) => (res && Array.isArray(res.runners) ? { online: res.runners.filter((r) => r.status === 'online').length, total: res.runners.length } : null);
  /** one plain sentence for the top of Home */
  function headline({ live, red, queue, fill }) {
    const parts = [];
    parts.push(live === 0 ? 'Nothing is running' : live === 1 ? '1 session running' : `${live} sessions running`);
    if (red != null) parts.push(red === 0 ? 'master is green' : `master is red (${red})`);
    if (queue) parts.push(`${queue} waiting to land`);
    if (fill != null && fill !== '' && Number(fill) === 0) parts.push('the fill is paused');
    return parts.join(', ') + '.';
  }
  /** #5045/#5110: the quiet-hours factor from roles.json fill.quiet ({tz, from, to, factor}) at `now`; 1 outside the window or when unknown (route.mjs quietState) */
  function quietFactor(q, now) {
    try {
      if (!q || !q.tz || !q.factor) return 1;
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: q.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)), g = (t) => Number(p.find((x) => x.type === t).value);
      const m = g('hour') * 60 + g('minute'), hm = (s) => { const [h, mi] = String(s).split(':').map(Number); return h * 60 + (mi || 0); };
      return m >= hm(q.from) && m < hm(q.to) ? Number(q.factor) : 1;
    } catch { return 1; }
  }
  /** the per-account fill (repo variables FILL_WORKERS_MAX / FILL_WORKERS_PRO): [{name, set, target}]; set = null when the variable is missing or not a number (route.mjs acctSwitch), target = set x factor rounded up */
  function acctFill(vars, factor) {
    return ['max', 'pro'].map((name) => {
      const s = String((vars || {})[name] ?? '').trim(), set = /^\d+$/.test(s) ? Math.min(10, Number(s)) : null;
      return { name, set, target: set === null ? null : Math.ceil(set * (factor || 1)) };
    });
  }
  /** the Home fill tile: per-account targets when any switch is set, else the old single number */
  function fillSummary(acct, master, factor) {
    const on = (acct || []).filter((a) => a.set !== null);
    if (!on.length) return { big: master == null || master === '' ? 'auto' : String(master), small: 'fill (workers wanted)' };
    const cap = (n) => n[0].toUpperCase() + n.slice(1);
    return { big: on.map((a) => `${cap(a.name)} ${a.target}`).join(' \u00b7 '), small: `fill per account (set ${on.map((a) => a.set).join(' / ')}${factor && factor !== 1 ? `, x${factor} quiet hours` : ''})` };
  }
  // ---- the bus: every comment that carries a `to:` and a `from:` header
  const field = (b, k) => ((String(b).match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1] || '').trim();
  const bodyOf = (b) => String(b || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => !/^(to|from|re|about|reply|id|at|options|type):\s/.test(l.trim())).join('\n').trim();
  /** bus messages, newest first; the brain's repeated identical log lines are folded into one with a count */
  function parseBus(comments) {
    const out = [];
    for (const c of comments || []) {
      const b = String(c.body || ''), to = field(b, 'to'), from = field(b, 'from');
      if (!to || !from || b.startsWith('<!-- brain-run ') || b.startsWith('<!-- dan-q ')) continue;
      out.push({ id: c.id, at: c.created_at, to, from, type: field(b, 'type').toLowerCase(), text: bodyOf(b), n: 1 });
    }
    out.sort((x, y) => ms(y.at) - ms(x.at));
    const folded = [];
    for (const m of out) {
      const p = folded[folded.length - 1];
      if (p && p.from === m.from && p.to === m.to && p.text === m.text) p.n++; else folded.push({ ...m });
    }
    return folded;
  }
  /** who Dan can talk to: the standing addresses, then the issues of the sessions running now */
  function addresses(cards) {
    const list = [{ to: 'commander', label: 'Commander', hint: 'wakes a commander within about a minute' }, { to: 'fixer', label: 'Fixer', hint: 'wakes a fixer within about a minute' }, { to: 'all', label: 'Everyone', hint: 'news for every session' }];
    const seen = new Set();
    for (const c of cards || []) if (c.issue && c.state === 'running' && !seen.has(c.issue)) { seen.add(c.issue); list.push({ to: `#${c.issue}`, label: `#${c.issue} ${c.title || c.name}`.trim(), hint: 'the session working on that issue reads it at its next step' }); }
    return list;
  }
  const MAXLEN = 2000;
  /** message types (tools/infra/bus.mjs): how hard a message interrupts the session it is sent to */
  const TYPES = [
    { type: 'reply', label: 'Needs a reply', hint: 'Stops every step it takes until it answers.' },
    { type: 'urgent', label: 'Drop everything', hint: 'Stops every step and says to drop what it is doing and answer first.' },
    { type: 'announce', label: 'Announcement', hint: 'Shown to it once on its next step. No answer needed.' },
    { type: 'info', label: 'FYI', hint: 'Goes on the bus and never interrupts.' }];
  const typeInfo = (t) => TYPES.find((x) => x.type === t) || TYPES[0];
  /** the bus message the sessions expect. Returns null when there is nothing to send. */
  function compose(to, text, type) {
    const t = String(text || '').replace(/\r/g, '').trim().slice(0, MAXLEN), a = String(to || '').trim().toLowerCase().replace(/\s+/g, '');
    const ty = type == null ? 'reply' : String(type);
    if (!t || !/^(#\d+|[a-z][a-z-]*)$/.test(a) || !TYPES.some((x) => x.type === ty)) return null;
    return `to: ${a}\nfrom: dan\ntype: ${ty}\n\n${t}`;
  }
  /** the address a message from a run's detail screen goes to: its issue, else its role */
  const addressForRun = (card) => (card && card.issue ? `#${card.issue}` : card && ['commander', 'fixer'].includes(card.role) ? card.role : 'all');
  root.Home = { CELLS, STALE_MS, MAXLEN, TYPES, typeInfo, ago, resetsIn, cells, tone, parseUsage, redChecks, landQueue, runnerCount, quietFactor, acctFill, fillSummary, headline, parseBus, addresses, compose, addressForRun, field, bodyOf };
  if (typeof module !== 'undefined') module.exports = root.Home;
})(typeof self !== 'undefined' ? self : globalThis);
