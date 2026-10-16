// subs.js - how a device's push subscription is stored: one comment per device on the private `push-subs` issue, keyed by endpoint.
// Shared by the app (browser) and phonewebcheck (node). Body: a marker line + the PushSubscription JSON.
(function (root) {
  const MARK = '<!-- push-sub ';
  const key = (endpoint) => { let h = 5381; for (let i = 0; i < endpoint.length; i++) h = ((h * 33) ^ endpoint.charCodeAt(i)) >>> 0; return h.toString(36); };
  const body = (sub) => `${MARK}${key(sub.endpoint)} -->\n${JSON.stringify(sub)}`;
  // what to write for this subscription given the issue's comments: PATCH the device's own comment, else POST a new one
  const upsert = (comments, sub) => { const mine = comments.find((c) => (c.body || '').startsWith(`${MARK}${key(sub.endpoint)} -->`)); return mine ? { method: 'PATCH', id: mine.id, body: body(sub) } : { method: 'POST', body: body(sub) }; };
  // the brain's read: every comment that holds a subscription -> { id, sub }
  const parse = (comments) => comments.filter((c) => (c.body || '').startsWith(MARK)).flatMap((c) => { try { return [{ id: c.id, sub: JSON.parse(c.body.slice(c.body.indexOf('\n') + 1)) }]; } catch { return []; } });
  root.Subs = { key, body, upsert, parse };
  if (typeof module !== 'undefined') module.exports = root.Subs;
})(typeof self !== 'undefined' ? self : globalThis);
