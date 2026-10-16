// runs.js - what the phone's home screen shows: the brain's live runs. Pure functions, shared by the app (browser) and phonerunscheck (node).
// Inputs are GitHub API objects (workflow runs, issue comments); nothing here touches the network or the DOM.
(function (root) {
  const MARK = '<!-- brain-run ';
  const COLOURS = { worker: '#4caf50', tester: '#26a69a', fixer: '#ffb74d', commander: '#ba68c8', chore: '#a1887f', waker: '#78909c', land: '#42a5f5', 'full-suite': '#ef5350', mail: '#9fa8da', other: '#90a4ae' };
  const NAMES = { worker: 'Worker', tester: 'Tester', fixer: 'Fixer', commander: 'Commander', chore: 'Chore', waker: 'Waker', land: 'Lander', 'full-suite': 'Full suite', mail: 'Mail run', other: 'Run' };
  const ms = (t) => Date.parse(t) || 0;
  /** which kind of run: brain.yml's run-name carries the role ('brain worker @max'); a bus-woken run is 'brain issue_comment'. */
  function roleOf(run) {
    const t = (run && (run.display_title || run.name)) || '', n = (run && run.name) || '';
    const m = /^brain (commander|fixer|worker|tester|chore|waker)\b/.exec(t);
    if (m) return m[1];
    if (/^brain issue_comment/.test(t)) return 'mail';
    if (/full[- ]?suite/i.test(n) || /full[- ]?suite/i.test(t)) return 'full-suite';
    if (/^land\b/i.test(n) || /\bland\b/i.test(t)) return 'land';
    return 'other';
  }
  const accountOf = (run) => ((/ @(\w+)/.exec((run && run.display_title) || '') || [])[1]) || '';
  /** the text of a bus/issue comment without its mail header ('to:', 'from:', ...) and without html comments */
  const bodyText = (b) => String(b || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => !/^(to|from|re|about|reply|id|at):\s/.test(l.trim())).join(' ').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  /** the launcher tags a worker's issue with a marker comment: <!-- brain-run RUNID role #ISSUE -->\n<issue title> */
  function parseMarkers(comments) {
    const out = {};
    for (const c of comments || []) {
      const b = String(c.body || '');
      if (!b.startsWith(MARK)) continue;
      const m = /^<!-- brain-run (\d+) (\w[\w-]*)(?: #(\d+))?(?: model=([\w.:\/-]+))? -->\n?([^\n]*)/.exec(b);
      if (m) out[m[1]] = { role: m[2], issue: m[3] ? Number(m[3]) : 0, title: m[5].trim(), model: m[4] || '', url: c.html_url || '' };
    }
    return out;
  }
  const markerBody = (runId, role, issue, title, model) => `${MARK}${runId} ${role}${issue ? ` #${issue}` : ''}${model ? ` model=${model}` : ''} -->\n${String(title || '').replace(/\s+/g, ' ').trim()}`;
  /** newest line this run posted: a comment after it started that names its issue (workers) or opens with '<role>:' (testers...) */
  function lastLine(comments, card) {
    const since = ms(card.startedAt);
    let best = null;
    for (const c of comments || []) {
      const b = String(c.body || '');
      if (b.startsWith(MARK) || ms(c.created_at) < since) continue;
      const t = bodyText(b);
      if (/run ended \(/.test(t)) continue;                      // that is another run finishing, not this one talking
      const mine = card.issue ? new RegExp(`#${card.issue}\\b`).test(t) : new RegExp(`^${card.role}:`, 'i').test(t);
      if (mine && (!best || ms(c.created_at) > ms(best.created_at))) best = c;
    }
    return best ? { text: clip(bodyText(best.body), 160), at: best.created_at } : null;
  }
  /** one card per running/queued run: running first (oldest first), then queued */
  function cards(running, queued, comments, markers) {
    const mk = markers || parseMarkers(comments), mapRun = (r, state) => {
      const role = roleOf(r), mark = mk[String(r.id)] || null;
      const c = { id: r.id, state, role, name: NAMES[role], colour: COLOURS[role], account: accountOf(r), startedAt: r.run_started_at || r.created_at, url: r.html_url, issue: mark ? mark.issue : 0, title: mark ? mark.title : '', model: mark ? mark.model || '' : '', runTitle: r.display_title || r.name || '', runner: '' };
      c.last = state === 'running' ? lastLine(comments, c) : null;
      return c;
    }, byAge = (x, y) => ms(x.startedAt) - ms(y.startedAt);
    return (running || []).map((r) => mapRun(r, 'running')).sort(byAge).concat((queued || []).map((r) => mapRun(r, 'queued')).sort(byAge));
  }
  /** the brain's 'run ended' lines within `win` ms (default the last hour): [{role, ok, at, text, model, tin, tout, cw, cr, cost, turns, minutes, acct, from5h, to5h}] newest first.
   *  The usage bracket the launcher writes - [usage <model> in N out N cw N cr N $X; total ...; N min; <acct> 5h a->b%, ...] - is parsed when present. */
  function ended(comments, now, win) {
    const out = [], span = win || 3600e3;
    for (const c of comments || []) {
      if (now - ms(c.created_at) > span) continue;
      const t = bodyText(c.body), m = /^brain: (\w+) run ended \((ok|[^,)]+)([^)]*)\)(?:\s*\[([^\]]*)\])?\s*-?\s*(.*)$/.exec(t);
      if (!m) continue;
      const br = m[4] || '', u = /usage (\S+) in (\d+) out (\d+) cw (\d+) cr (\d+) \$([\d.]+)/.exec(br), tn = /(\d+) turns/.exec(m[3] || ''), mi = /; (\d+) min;/.exec(br), pc = /(\w+) 5h (\d+)->(\d+)%/.exec(br), ac = /,\s*(\w+)\s*$/.exec(m[3] || '');
      out.push({ role: m[1], ok: m[2] === 'ok', at: c.created_at, text: clip(m[5] || (m[2] === 'ok' ? 'finished' : m[2]), 140),
        model: u ? u[1] : '', tin: u ? +u[2] : 0, tout: u ? +u[3] : 0, cw: u ? +u[4] : 0, cr: u ? +u[5] : 0, cost: u ? parseFloat(u[6]) : 0,
        turns: tn ? +tn[1] : 0, minutes: mi ? +mi[1] : 0, acct: ac ? ac[1] : '', from5h: pc ? +pc[2] : null, to5h: pc ? +pc[3] : null });
    }
    return out.sort((x, y) => ms(y.at) - ms(x.at));
  }
  /** totals + per-model + per-role over a list from ended(): {runs, ok, cost, turns, tokens, perTurn, byModel, byRole}. Tokens = in + out + cache write + cache read. */
  /** #5031: a junk run did no work worth counting: no usage numbers, or under 7 turns AND under $0.10 (hook-blocked, test-message replies, no-code re-queues) */
  const isJunk = (e) => !e.model || (e.turns < 7 && e.cost < 0.10);
  function stats(list, dropJunk) {
    const blank = () => ({ runs: 0, ok: 0, cost: 0, turns: 0, tokens: 0, out: 0 }), T = blank(), byModel = {}, byRole = {}, junk = { runs: 0, cost: 0 };
    for (const e of list || []) {
      if (dropJunk && isJunk(e)) { junk.runs++; junk.cost += e.cost; continue; }
      const tok = e.tin + e.tout + e.cw + e.cr;
      for (const g of [T, byModel[e.model || 'unknown'] || (byModel[e.model || 'unknown'] = blank()), byRole[e.role] || (byRole[e.role] = blank())]) {
        g.runs++; g.ok += e.ok ? 1 : 0; g.cost += e.cost; g.turns += e.turns; g.tokens += tok; g.out += e.tout;
      }
    }
    for (const g of [T, ...Object.values(byModel), ...Object.values(byRole)]) g.perTurn = g.turns ? g.cost / g.turns : 0;
    return { ...T, byModel, byRole, junk };
  }
  /** 1234 -> '1.2k', 559669 -> '560k', 2300000 -> '2.3M' */
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
  /** 'claude-haiku-5-5' -> 'Haiku 5.5' (unknown names pass through) */
  const modelName = (m) => { const x = /^claude-(\w+)-(\d+)-(\d+)/.exec(m || ''); return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : (m || ''); };
  /** '7s', '12m 03s', '1h 02m' */
  function elapsed(since, now) {
    const s = Math.max(0, Math.floor((now - ms(since)) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  root.Runs = { MARK, COLOURS, NAMES, roleOf, accountOf, bodyText, parseMarkers, markerBody, lastLine, cards, ended, stats, isJunk, fmtTok, modelName, elapsed, esc, clip };
  if (typeof module !== 'undefined') module.exports = root.Runs;
})(typeof self !== 'undefined' ? self : globalThis);
