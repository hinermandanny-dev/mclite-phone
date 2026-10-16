// controls.js - the phone's one-tap controls (#4176): the fill stepper, pause/resume, and the multiple-choice questions to Dan.
// Pure functions shared by the app (browser) and phonecontrolscheck (node). No network, no DOM.
//  Questions: the brain mirrors every `to: dan` bus message that carries an `options:` line onto the issue labelled `dan-questions`
//  (<!-- dan-q BUSID -->\n<the bus body>), so a question stays findable for days however busy the bus is. Answering = a bus message in the
//  format the sessions expect ("to: <asker>\nfrom: dan\nabout: <id>") plus marking the mirror answered.
(function (root) {
  const QMARK = '<!-- dan-q ';
  const field = (b, k) => ((String(b).match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1] || '').trim();
  const firstLine = (s) => String(s).split('\n').map((l) => l.trim()).find(Boolean) || '';
  const mirrorBody = (busId, body) => `${QMARK}${busId} -->\n${String(body)}`;
  /** every mirrored question: {busId, mirrorId, from, text, options[], answered, at, raw} - open ones first, oldest first */
  function parseQuestions(comments) {
    const out = [];
    for (const c of comments || []) {
      const m = /^<!-- dan-q (\d+)( answered)? -->\n?([\s\S]*)$/.exec(String(c.body || ''));
      if (!m) continue;
      const inner = m[3], opt = /^options:\s*(.+)$/m.exec(inner);
      const text = inner.split('\n').filter((l) => !/^(to|from|re|about|reply|options):\s/.test(l.trim())).join('\n').trim();
      out.push({ busId: m[1], mirrorId: c.id, from: field(inner, 'from') || 'commander', text, options: opt ? opt[1].split('|').map((x) => x.trim()).filter(Boolean) : [], answered: !!m[2], at: c.created_at, raw: inner });
    }
    return out.sort((a, b) => (a.answered - b.answered) || (Date.parse(a.at) - Date.parse(b.at)));
  }
  const openQuestions = (comments) => parseQuestions(comments).filter((q) => !q.answered && q.options.length);
  /** the bus message that answers a question - the format the sessions expect (`about:` = the question's bus id) */
  const answerMessage = (q, choice) => `to: ${String(q.from || 'commander').toLowerCase()}\nfrom: dan\nabout: ${q.busId}\n\n${choice}\n\n(Dan's answer to: ${firstLine(q.text)})`;
  const answeredBody = (q, choice) => `${QMARK}${q.busId} answered -->\n${q.raw}\n\n[answered from the phone: ${choice}]`;
  const clampFill = (n) => Math.min(10, Math.max(0, Math.round(Number(n)) || 0));
  const fillLabel = (v) => (v == null || v === '' ? 'auto' : String(v));
  const busFillLine = (n) => `to: log\nfrom: dan\n\nrestarting the fill (phone: fill set to ${n})`;
  /** one account's own worker count (FILL_WORKERS_MAX / FILL_WORKERS_PRO), set from the phone */
  const busAcctLine = (name, n) => `to: log\nfrom: dan\n\nrestarting the fill (phone: ${name} fill set to ${n == null ? 'auto' : n})`;
  /** pause keeps the count it replaced so resume can put it back; 'auto' = the variable did not exist (roles.json decides) */
  function pausePlan(current, before) {
    const cur = fillLabel(current);
    if (cur === '0') return { paused: true, resumeTo: before == null || before === '' ? 'auto' : before };
    return { paused: false, saveBefore: cur, setTo: '0' };
  }
  const badgeCount = (qs) => (qs || []).length;
  root.Controls = { QMARK, field, firstLine, mirrorBody, parseQuestions, openQuestions, answerMessage, answeredBody, clampFill, fillLabel, busFillLine, busAcctLine, pausePlan, badgeCount };
  if (typeof module !== 'undefined') module.exports = root.Controls;
})(typeof self !== 'undefined' ? self : globalThis);
