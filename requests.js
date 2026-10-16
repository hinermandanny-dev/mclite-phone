// requests.js - the phone's Requests tab (#7685): pure helpers shared by the app (browser) and phonerequestscheck (node). Nothing here touches the network or the DOM.
// THE CONTRACT (identical in #7685 and #7686; do not drift): a request is a GitHub issue labelled `request` + exactly one of req:waiting|req:working|req:done; title = the first line of
// Dan's words (max 80), body = his words then a last line `<!-- request -->`. The handler talks in issue comments that start `from: <who>`; fenced ```dashboard / ```result / ```undo blocks are rendered.
// Starting or continuing = the issue/comment + a bus mail `to: requests\nfrom: dan\ntype: info\n\n#<n>`. Undo = a comment `from: dan\n\nundo <id>` + the same mail.
(function (root) {
  const MARK = '<!-- request -->', SANDBOX = 'allow-scripts', MAX_DASH = 60000, STATUS = { waiting: 'Waiting', working: 'Working', done: 'Done' };
  const ms = (t) => Date.parse(t) || 0;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const labelsOf = (i) => (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  /** done beats working beats waiting, so a request that briefly carries two status labels still reads sensibly */
  function statusOf(i) { const L = labelsOf(i); return L.includes('req:done') ? 'done' : L.includes('req:working') ? 'working' : L.includes('req:waiting') ? 'waiting' : ''; }
  const titleOf = (text) => clip(String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '', 80).replace(/\s+/g, ' ');
  function composeIssue(text) { const t = String(text || '').trim(); return t ? { title: titleOf(t), body: t + '\n' + MARK, labels: ['request', 'req:waiting'] } : null; }
  const busMail = (n) => `to: requests\nfrom: dan\ntype: info\n\n#${n}`;
  const followUp = (text) => { const t = String(text || '').trim(); return t ? `from: dan\n\n${t}` : null; };
  const undoComment = (id) => `from: dan\n\nundo ${id}`;
  const textOf = (i) => String(i.body || '').replace(/\n?<!-- request -->\s*$/, '').trim();
  const parseIssue = (i) => ({ n: i.number, title: i.title || '', status: statusOf(i), text: textOf(i), updated: i.updated_at, comments: i.comments || 0, url: i.html_url || '' });
  /** open requests first (newest activity first), then the done ones (newest activity first) */
  function sortList(list) { const by = (a, b) => ms(b.updated) - ms(a.updated), open = list.filter((r) => r.status !== 'done').sort(by); return open.concat(list.filter((r) => r.status === 'done').sort(by)); }
  /** one comment -> {id, at, from, text, blocks:[{type, body, undo?}]}; the brain's own run markers are not part of the conversation (null) */
  function parseComment(c) {
    let b = String(c.body || '').replace(/\r/g, '');
    if (b.startsWith('<!-- brain-run')) return null;
    const m = /^from:[ \t]*(.+)\n?/.exec(b); b = m ? b.slice(m[0].length) : b;
    const blocks = [];
    const text = b.replace(/^```(dashboard|result|undo)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (_, type, body) => {
      if (type === 'undo') { try { const u = JSON.parse(body); if (u && typeof u.id === 'string' && typeof u.what === 'string') { blocks.push({ type, body, undo: u }); return ''; } } catch { /* shown as plain text */ } return _; }
      blocks.push({ type, body }); return '';
    }).replace(/<!--[\s\S]*?-->/g, '').trim();
    return { id: c.id, at: c.created_at, from: m ? m[1].trim() : 'unknown', text, blocks };
  }
  const thread = (comments) => (comments || []).map(parseComment).filter(Boolean).sort((a, b) => ms(a.at) - ms(b.at));
  /** the ids Dan has asked to undo ("undo u1" comments) */
  const undone = (comments) => new Set((comments || []).map((c) => /^from:[ \t]*dan\s*\n+undo (\S+)/i.exec(String(c.body || '').replace(/\r/g, ''))).filter(Boolean).map((m) => m[1]));
  /** what a list card shows: the newest result block, else the last line of the newest comment that is not Dan's */
  function latest(comments) {
    const th = thread(comments).filter((c) => c.from !== 'dan');
    for (let i = th.length - 1; i >= 0; i--) { const r = th[i].blocks.find((x) => x.type === 'result'); if (r) return clip(r.body.replace(/\s+/g, ' ').trim(), 160); }
    for (let i = th.length - 1; i >= 0; i--) { const l = th[i].text.split('\n').map((x) => x.trim()).filter((x) => x && !/^```/.test(x)).pop(); if (l) return clip(l, 160); }
    return '';
  }
  const unseenCount = (list, seen) => (list || []).filter((r) => ms(r.updated) > ((seen || {})[r.n] || 0)).length;
  /** the dashboard is ONE self-contained HTML document in a sandboxed iframe: scripts may run, but with no same-origin it cannot read the token or call GitHub */
  const dashboardFrame = (html) => (String(html).length > MAX_DASH ? '' : `<iframe class="dash" sandbox="${SANDBOX}" srcdoc="${esc(html)}" title="dashboard"></iframe>`);
  /** a very small Markdown: escape first, then **bold**, `code`, line breaks */
  const md = (t) => esc(t).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
  root.Requests = { MARK, SANDBOX, MAX_DASH, STATUS, statusOf, titleOf, composeIssue, busMail, followUp, undoComment, textOf, parseIssue, sortList, parseComment, thread, undone, latest, unseenCount, dashboardFrame, md, esc, clip };
  if (typeof module !== 'undefined') module.exports = root.Requests;
})(typeof self !== 'undefined' ? self : globalThis);
