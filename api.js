// api.js — the small, secure web API behind the Telegram Mini App.
// No extra packages. Every request must carry Telegram's signed login data (initData), so nobody can read
// or change anybody else's account. Only started when MINIAPP_ORIGIN is set in .env.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

// Telegram signs initData with a key derived from the bot token. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken, maxAgeSec = 86400, now = Date.now()) {
  const params = new URLSearchParams(String(initData || '')), hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'))) return null;
  const age = now / 1000 - Number(params.get('auth_date') || 0);
  if (!(age >= -300 && age <= maxAgeSec)) return null;                  // too old (or from the future)
  try { const u = JSON.parse(params.get('user') || '{}'); return u && u.id ? u : null; } catch { return null; }
}

export function startApi({ port = 3000, origins = [], token, W, canSee, isAdm, build = '', bot = {} }) {
  const allow = new Set(origins), hits = new Map();
  const limited = (key, max) => { const t = Date.now(), w = (hits.get(key) || []).filter(x => t - x < 60000); w.push(t); hits.set(key, w); return w.length > max; };
  setInterval(() => { const t = Date.now(); for (const [k, w] of hits) if (!w.some(x => t - x < 60000)) hits.delete(k); }, 120000).unref();
  const send = (res, code, body, cors) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((ok, bad) => {
    let n = 0, b = '', big = false;
    req.on('data', c => { n += c.length; if (n > 1e6) req.destroy(); else if (n > 20000) { big = true; b = ''; } else if (!big) b += c; });   // read past the limit (up to 1 MB) so we can answer politely
    req.on('end', () => { if (big) return bad(Object.assign(new Error('That request is too large. Send fewer items at a time.'), { code: 413 })); try { ok(b ? JSON.parse(b) : {}); } catch { bad(Object.assign(new Error('Invalid request.'), { code: 400 })); } });
    req.on('error', bad);
  });
  const E = (code, message) => Object.assign(new Error(message), { code });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const need = (uid, label) => { if (!canSee(uid, label)) throw E(403, 'That part is not switched on for your account.'); };
  const targetInfo = t => ({ kind: t?.kind, count: t?.kind === 'numbers' ? (t.numbers || []).length : (t?.ids || []).length, name: t?.name });

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const futureAt = v => { const at = Number(v); if (!(at > Date.now() + 30000)) throw E(400, 'Pick a time in the future.'); if (at > Date.now() + 90 * 864e5) throw E(400, 'Pick a time within 90 days.'); return at; };
  const parseNumbers = input => {                                   // "+234 801 111 1111" is ONE number; "2348011111111 2348022222222" on one line is two
    const tokens = (Array.isArray(input) ? input.map(String) : String(input || '').split(/[\n,;]+/)).map(x => x.trim()).filter(Boolean), good = []; let bad = 0;
    const take = s => { const d = s.replace(/\D/g, ''); if (d.length >= 7 && d.length <= 15) { good.push(d); return true; } return false; };
    for (const t of tokens) { if (take(t)) continue; const parts = t.split(/\s+/).filter(Boolean); if (parts.length > 1) { for (const p of parts) if (!take(p)) bad++; } else bad++; }
    return { items: [...new Set(good)], skipped: bad };
  };
  const cleanTarget = (uid, t = {}) => {                              // never trust the target the page sends
    if (t.kind === 'numbers') {
      const numbers = parseNumbers(t.numbers).items;
      if (!numbers.length) throw E(400, 'Add at least one valid number with country code.'); return { kind: 'numbers', numbers };
    }
    if (t.kind === 'list') { if (!has(W.load(uid, 'lists', {}), t.name)) throw E(400, 'That list does not exist.'); return { kind: 'list', name: String(t.name) }; }
    if (t.kind === 'grouplist') { if (!has(W.load(uid, 'grouplists', {}), t.name)) throw E(400, 'That group list does not exist.'); return { kind: 'grouplist', name: String(t.name) }; }
    if (t.kind === 'groups' || t.kind === 'channels') {
      const store = W.load(uid, t.kind === 'groups' ? 'groups' : 'channels', {}), ids = [...new Set((Array.isArray(t.ids) ? t.ids : []).map(String).filter(id => has(store, id)))];
      if (!ids.length) throw E(400, t.kind === 'groups' ? 'Pick at least one group.' : 'Pick at least one channel.'); return { kind: t.kind, ids };
    }
    throw E(400, 'Choose who should receive it.');
  };
  const applyEdit = (uid, item, body, maxText) => {                  // change the wording and/or the time of a scheduled item
    if (body.text !== undefined) {
      const text = String(body.text).trim(); if (item.type === 'text' && !text) throw E(400, 'The text cannot be empty.'); if (text.length > maxText) throw E(400, `Keep it under ${maxText} characters.`);
      const probe = item.type === 'text' ? { ...item, text } : { ...item, caption: text }, sg = W.checkSpam(uid, probe); if (!sg.ok) throw E(400, `This ${item.type === 'text' ? 'text' : 'caption'} ${sg.reason}.`);
      if (item.type === 'text') item.text = text; else item.caption = text;
    }
    if (body.at !== undefined) { item.at = futureAt(body.at); delete item.retryAt; delete item.notifiedDown; delete item.lastErr; }
  };
  // ---- uploads: the page sends the raw file, we check it really is that kind of file, keep it, and hand back a one-time token ----
  const pend = new Map(), UP = { image: { max: 6e6, ext: 'jpg' }, video: { max: 16e6, ext: 'mp4' }, audio: { max: 8e6 } };
  setInterval(() => { const t = Date.now(); for (const [k, v] of pend) if (t - v.at > 36e5) pend.delete(k); }, 6e5).unref();
  const sniff = (b, type) => {
    if (type === 'image') return b[0] === 0xFF && b[1] === 0xD8 ? 'jpg' : b.subarray(1, 4).toString() === 'PNG' ? 'png' : null;
    if (type === 'video') return b.subarray(4, 8).toString() === 'ftyp' ? 'mp4' : null;
    return b.subarray(0, 4).toString() === 'OggS' ? 'ogg' : (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) ? 'mp3' : null;
  };
  const upload = async (uid, req, q) => {
    need(uid, '✍️ Post'); const type = String(q.get('type') || ''); if (!has(UP, type)) throw E(400, 'Unknown file type.');
    if (limited('up:' + uid, 60)) throw E(429, 'Too many uploads. Please wait a minute.');
    if (Number(req.headers['content-length'] || 0) > UP[type].max) throw E(413, `That file is too big. The limit is ${UP[type].max / 1e6} MB.`);
    const chunks = []; let n = 0;
    await new Promise((ok, bad) => { req.on('data', c => { n += c.length; if (n > UP[type].max) { bad(E(413, `That file is too big. The limit is ${UP[type].max / 1e6} MB.`)); req.destroy(); } else chunks.push(c); }); req.on('end', ok); req.on('error', () => bad(E(400, 'The upload was interrupted.'))); });
    const buf = Buffer.concat(chunks), ext = n > 12 ? sniff(buf, type) : null;
    if (!ext) throw E(400, type === 'audio' ? 'Use an MP3 or OGG audio file.' : type === 'video' ? 'Use an MP4 video.' : 'Use a JPG or PNG photo.');
    const dir = `${W.udir(uid)}/media`; fs.mkdirSync(dir, { recursive: true }); const file = `${dir}/${Date.now()}.${ext}`; fs.writeFileSync(file, buf);
    const token = crypto.randomBytes(8).toString('hex'); pend.set(uid + ':' + token, { file, type, at: Date.now() }); return { token, size: n };
  };
  const takeUpload = (uid, token, type) => {
    const k = uid + ':' + String(token || ''), u = pend.get(k); if (!u || u.type !== type || !fs.existsSync(u.file)) throw E(400, 'Upload the file again. It expired.');
    return u.file;
  };
  const launch = async (uid, p, body) => {                           // post now, or schedule: shared by new posts and templates
    if (!W.linked(uid)) throw E(400, 'Link WhatsApp first.');
    if (body.when === 'later') {
      const at = futureAt(body.at), P = W.load(uid, 'posts', []); P.push({ ...p, at, repeat: 'none', status: 'scheduled' }); W.save(uid, 'posts', P); W.logActivity(uid, 'app-schedule-post', p.id);
      return { scheduled: true, at };
    }
    if (!W.isUp(uid)) throw E(400, 'WhatsApp is not connected right now.');
    const run = W.runPost(uid, p); W.logActivity(uid, 'app-post-now', p.id);
    const early = await Promise.race([run.then(() => null, e => e), sleep(800)]);   // report instant failures (limit, plan, spam) straight away
    if (early instanceof Error) throw E(400, early.message);
    run.catch(() => {}); return { started: true };
  };
  const unsending = new Set(), checking = new Set(), GRP = /^[A-Za-z0-9]{18,26}$/;
  const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`, toCsv = rows => '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const sendFile = async (uid, text, name, cap) => { try { await bot.sendFile(uid, text, name, cap); } catch { throw E(502, 'Could not send the file to your chat. Open the bot and send /start first.'); } };
  const fmtD = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '';
  const chatLinks = uid => { const G = W.load(uid, 'groups', {}); return Object.entries(W.load(uid, 'links_seen', {})).map(([code, l]) => ({ code, url: l.url || 'https://chat.whatsapp.com/' + code, where: l.group ? (G[l.group]?.subject || 'A group') : 'A private chat', at: l.at || 0 })).sort((a, b) => b.at - a.at); };
  const deadLinks = uid => Object.entries(W.load(uid, 'dead_links', {})).map(([code, d]) => ({ code, url: d.url || 'https://chat.whatsapp.com/' + code, where: d.groupName || '', at: d.detectedAt || 0 })).sort((a, b) => b.at - a.at);
  const RESERVED = /^(__proto__|constructor|prototype|tostring|hasownproperty|valueof)$/i, CAP = { numbers: 5000, groups: 500 };
  const kindOf = k => { if (k !== 'numbers' && k !== 'groups') throw E(400, 'Unknown list type.'); return k; };
  const fileOf = kind => (kind === 'groups' ? 'grouplists' : 'lists');
  const listNeed = (uid, kind) => need(uid, kind === 'groups' ? '📚 Group lists' : '🏷 Lists');
  const listName = raw => { const n = String(raw ?? '').replace(/[\u0000-\u001f]/g, '').trim(); if (!n || n.length > 30) throw E(400, 'Give the list a name of 1 to 30 characters.'); if (RESERVED.test(n)) throw E(400, 'Please choose a different name.'); return n; };
  const cleanItems = (uid, kind, items) => {                         // returns only valid entries, plus how many were rejected
    if (kind === 'numbers') {
      return parseNumbers(items);
    }
    const G = W.load(uid, 'groups', {}), raw = (Array.isArray(items) ? items : []).map(String), good = raw.filter(id => has(G, id)); return { items: [...new Set(good)], skipped: raw.length - good.length };
  };
  const getList = (uid, kind, rawName) => { const store = W.load(uid, fileOf(kind), {}), name = String(rawName ?? ''); if (!has(store, name)) throw E(404, 'That list no longer exists.'); return { store, name }; };
  const routes = {
    'GET /api/me': uid => {
      const p = W.prof(uid), C = Object.values(W.load(uid, 'contacts', {})), me = W.waMe(uid), now = Date.now();
      return {
        id: uid, name: p.name || '', role: W.isOwner(uid) ? 'owner' : isAdm(uid) ? 'admin' : 'user', build,
        wa: { linked: W.linked(uid), up: W.isUp(uid), number: me?.number || '', name: me?.name || '' },
        plan: { name: p.plan || '', expires: p.expires || null, expired: W.expired(p), paused: !!p.paused, daysLeft: p.expires ? Math.ceil((p.expires - now) / 864e5) : null },
        usage: { today: p.sent?.n || 0, limit: p.limit, total: p.total || 0 },
        counts: {
          contacts: C.filter(x => !x.out).length, groups: Object.keys(W.load(uid, 'groups', {})).length,
          scheduledPosts: W.load(uid, 'posts', []).filter(x => x.status === 'scheduled').length, scheduledMessages: W.load(uid, 'msgs', []).filter(x => x.status === 'scheduled').length,
          lists: Object.keys(W.load(uid, 'lists', {})).length + Object.keys(W.load(uid, 'grouplists', {})).length
        },
        features: { post: canSee(uid, '✍️ Post'), schedule: canSee(uid, '🗓 Schedule a post'), messages: canSee(uid, '✉️ Messages'), sending: canSee(uid, '📡 Sending now'), lists: canSee(uid, '🏷 Lists'), glists: canSee(uid, '📚 Group lists'), inbox: canSee(uid, '📩 Inbox'), tpl: canSee(uid, '📋 My templates'), links: canSee(uid, '🔗 Group links'), deadl: canSee(uid, '🧾 Review dead links'), clean: canSee(uid, '🧹 Clean dead links'), exportn: canSee(uid, '📤 Export numbers'), dedupe: canSee(uid, '🧹 Fix duplicates'), admin: canSee(uid, '🛠 Admin'), au: canSee(uid, '📋 List users'), ap: canSee(uid, '🕒 Pending'), contacts: canSee(uid, '📈 Summary'), reach: canSee(uid, '📊 Reach-out stats'), queue: canSee(uid, '🗂 Queue many'), col: canSee(uid, '⭐ Saved colours'), unsend: canSee(uid, '🗑 Delete a sent post'), media: canSee(uid, '🖼 Image'), ref: canSee(uid, '🎁 Refer a friend'), groups: canSee(uid, '👪 Groups & links'), excl: canSee(uid, '🚫 Exclusions'), plan: canSee(uid, '💳 Plan'), insights: canSee(uid, '📊 Insights') }
      };
    },
    'GET /api/posts': uid => {
      need(uid, '🗓 Schedule a post');
      return { posts: W.load(uid, 'posts', []).filter(p => p.status === 'scheduled').sort((a, b) => a.at - b.at).slice(0, 100).map(p => ({ id: p.id, type: p.type, text: p.type === 'text' ? p.text || '' : p.caption || '', at: p.at, repeat: p.repeat || 'none', bg: p.bg || null })) };
    },
    'DELETE /api/posts/:id': (uid, { id }) => {
      need(uid, '🗓 Schedule a post');
      const P = W.load(uid, 'posts', []), p = P.find(x => String(x.id) === id && x.status === 'scheduled'); if (!p) throw E(404, 'That post is no longer scheduled.');
      p.status = 'cancelled'; W.save(uid, 'posts', P); W.logActivity(uid, 'app-cancel-post', id); return { ok: true };
    },
    'POST /api/posts': async (uid, _p, body) => {
      need(uid, '✍️ Post'); const kind = has(UP, body.type) ? body.type : 'text', pf = W.prof(uid), id = Date.now(); let p;
      if (kind === 'text') {
        const text = String(body.text ?? '').trim(); if (!text) throw E(400, 'Write something first.'); if (text.length > 700) throw E(400, 'Keep it under 700 characters.');
        p = { type: 'text', text, bg: /^#[0-9a-f]{6}$/i.test(body.bg || '') ? body.bg.toUpperCase() : pf.color, tc: pf.textColor, font: pf.font, aud: 'all', id };
      } else {
        const caption = String(body.caption ?? '').trim(); if (caption.length > 700) throw E(400, 'Keep the caption under 700 characters.');
        p = { type: kind, file: takeUpload(uid, body.upload, kind), ...(kind !== 'audio' && caption ? { caption } : {}), bg: pf.color, tc: pf.textColor, font: pf.font, aud: 'all', id };
      }
      const sg = W.checkSpam(uid, p); if (!sg.ok) throw E(400, `This post ${sg.reason}.`);
      const name = String(body.saveAs ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 30);
      if (name && canSee(uid, '📄 Templates')) { const T = W.load(uid, 'templates', []); if (T.length < 30) { T.push({ name, p: { ...p, id: undefined } }); W.save(uid, 'templates', T); } }
      const out = await launch(uid, p, body); if (kind !== 'text') pend.delete(uid + ':' + body.upload); return out;
    },
    'POST /api/queue': async (uid, _p, b) => {                          // many files, one every N hours: same as the bot's Queue many
      need(uid, '🗂 Queue many'); if (!W.linked(uid)) throw E(400, 'Link WhatsApp first.');
      const items = Array.isArray(b.items) ? b.items : []; if (!items.length) throw E(400, 'Add at least one file.'); if (items.length > 50) throw E(400, 'The queue limit is 50 files.');
      const gap = [1, 6, 12, 24].includes(Number(b.gap)) ? Number(b.gap) * 36e5 : null; if (!gap) throw E(400, 'Pick how often to post.');
      const at = futureAt(b.at), pf = W.prof(uid), base = Date.now(), made = [];
      items.forEach((it, i) => {
        const type = has(UP, it?.type) ? it.type : null; if (!type) throw E(400, `File ${i + 1} has an unknown type.`);
        const caption = String(it.caption ?? '').trim(); if (caption.length > 700) throw E(400, `Caption ${i + 1} is over 700 characters.`);
        const p = { type, file: takeUpload(uid, it.upload, type), ...(type !== 'audio' && caption ? { caption } : {}), bg: pf.color, tc: pf.textColor, font: pf.font, aud: 'all', exclude: [], excludeLists: [], excludeGroups: [], id: base + i, at: at + i * gap, repeat: 'none', status: 'scheduled' };
        const sg = W.checkSpam(uid, p); if (!sg.ok) throw E(400, `Post ${i + 1} ${sg.reason}.`); made.push(p);
      });
      const P = W.load(uid, 'posts', []); P.push(...made); W.save(uid, 'posts', P); items.forEach(it => pend.delete(uid + ':' + it.upload)); W.logActivity(uid, 'app-queue-many', made.length);
      return { scheduled: made.length, first: at, last: made.at(-1).at };
    },
    'GET /api/contacts': uid => {
      need(uid, '📈 Summary'); const E = Object.entries(W.load(uid, 'contacts', {})), act = E.filter(([, c]) => !c.out), by = k => act.filter(([, c]) => c.src === k).length;
      return { total: act.length, phonebook: by('phonebook'), chats: by('chat'), viewers: by('viewer'), groupOnly: by('group'), multi: act.filter(([, c]) => (c.gc || 0) > 1).length, removed: E.length - act.length };
    },
    'GET /api/contacts/views': uid => {
      need(uid, '👁 Who views me'); const C = W.load(uid, 'contacts', {}), V = W.load(uid, 'views', { log: [] }), H = W.load(uid, 'history', []);
      const list = Object.entries(C).filter(([, c]) => c.v > 0).sort((a, b) => b[1].v - a[1].v), last = {};
      for (let i = (V.log || []).length - 1; i >= 0; i--) if (!(V.log[i].who in last)) last[V.log[i].who] = V.log[i];
      return { total: list.length, people: list.slice(0, 200).map(([n, c]) => ({ number: n, name: c.name || '', views: c.v, last: c.lastView || 0, post: H.find(h => h.id === last[n]?.post)?.preview || '' })) };
    },
    'GET /api/contacts/posts': uid => {
      need(uid, '👁 Post viewers');
      return { posts: W.load(uid, 'history', []).slice(-10).reverse().map(h => ({ id: h.id, at: h.at, preview: String(h.preview || ''), views: h.viewers?.length || 0 })) };
    },
    'GET /api/contacts/posts/:id': (uid, { id }) => {
      need(uid, '👁 Post viewers'); const h = W.load(uid, 'history', []).find(x => String(x.id) === id); if (!h) throw E(404, 'That post was not found.');
      const C = W.load(uid, 'contacts', {}), v = h.viewers || [];
      return { preview: String(h.preview || ''), at: h.at, total: v.length, viewers: v.slice(0, 200).map(n => ({ number: n, name: C[n]?.name || '' })) };
    },
    'GET /api/contacts/inactive': uid => {
      need(uid, '😴 Inactive 6m'); const r = W.inactiveReport(uid), C = W.load(uid, 'contacts', {});
      if (!r.ok) return { ok: false, tracked: r.tracked, posts: r.posts };
      return { ok: true, total: r.list.length, list: r.list.slice(0, 200).map(n => ({ number: n, name: C[n]?.name || '', views: C[n]?.v || 0, last: C[n]?.lastView || 0 })) };
    },
    'POST /api/contacts/prune': uid => { need(uid, '😴 Inactive 6m'); const n = W.prune(uid); W.logActivity(uid, 'app-prune-inactive', n); return { ok: true, removed: n }; },
    'GET /api/reach': uid => {
      need(uid, '📊 Reach-out stats'); const r = W.reachState(uid), C = Object.values(W.load(uid, 'contacts', {})), max = bot.reachMax?.() ?? 10;
      return { on: !!r.on, perDay: Math.min(r.perDay, max), max, today: r.n || 0, total: r.total || 0, replies: r.replies || 0, minDays: r.minDays,
        viewed: C.filter(c => c.reachedAt && c.lastView > c.reachedAt).length, optOut: C.filter(c => c.optOut).length,
        msgs: r.msgs?.length ? r.msgs : W.REACH_DEFAULT, custom: !!r.msgs?.length, can: { toggle: canSee(uid, '🔛 Reach-out on/off'), msgs: canSee(uid, '✏️ Reach-out messages'), per: canSee(uid, '🔢 Reach-out per day') } };
    },
    'POST /api/reach/toggle': (uid, _p, b) => {
      need(uid, '🔛 Reach-out on/off'); const r = W.reachState(uid);
      if (b.on) { r.on = true; r.nextAt = Date.now() + 5 * 60e3; } else r.on = false;
      W.save(uid, 'profile', W.prof(uid)); W.logActivity(uid, 'app-reach-' + (r.on ? 'on' : 'off')); return { ok: true, on: r.on };
    },
    'POST /api/reach/settings': (uid, _p, b) => {
      const r = W.reachState(uid), max = bot.reachMax?.() ?? 10;
      if (b.perDay !== undefined) { need(uid, '🔢 Reach-out per day'); const n = Number(b.perDay); if (!Number.isInteger(n) || n < 1 || n > max) throw E(400, `Pick a whole number from 1 to ${max}.`); r.perDay = n; }
      if (b.msgs !== undefined) {
        need(uid, '✏️ Reach-out messages'); const m = (Array.isArray(b.msgs) ? b.msgs : []).map(x => String(x).trim()).filter(x => x.length >= 8 && x.length <= 300).slice(0, 5);
        if (Array.isArray(b.msgs) && b.msgs.some(x => String(x).trim()) && !m.length) throw E(400, 'Each message needs 8 to 300 characters.'); r.msgs = m;
      }
      W.save(uid, 'profile', W.prof(uid)); return { ok: true };
    },
    // ---- admin: every route re-checks the admin's own permission, exactly like the bot's menus ----
    'GET /api/admin/users': uid => {
      need(uid, '📋 List users'); const all = W.users();
      const users = all.slice(-300).reverse().map(id => { const p = W.prof(id); return { id, name: p.name || '', linked: W.linked(id), up: W.isUp(id), status: p.paused ? 'paused' : W.expired(p) ? 'expired' : 'active' }; });
      return { total: all.length, users };
    },
    'GET /api/admin/users/:id': (uid, { id }) => {
      need(uid, 'ℹ️ User info'); if (!/^\d{1,20}$/.test(id) || !W.users().includes(id)) throw E(404, 'That user was not found.');
      const p = W.prof(id), L = a => canSee(uid, a);
      return { id, name: p.name || '', username: p.username || '', linked: W.linked(id), up: W.isUp(id), status: p.paused ? 'paused' : W.expired(p) ? 'expired' : 'active', limit: p.limit, today: p.sent?.n || 0, expires: p.expires || null, plan: p.plan || '', role: W.isOwner(id) ? 'owner' : isAdm(id) ? 'admin' : 'user', health: String(W.healthSummary(id) || ''),
        can: { pause: L('⏸ Pause'), resume: L('▶️ Resume'), limit: L('🔢 Set limit'), days: L('⏳ Add days'), repair: L('🧽 Repair user'), unlink: L('🔌 Force unlink'), remove: L('🗑 Remove user') } };
    },
    'POST /api/admin/users/:id/action': async (uid, { id }, b) => {
      const LAB = { pause: '⏸ Pause', resume: '▶️ Resume', limit: '🔢 Set limit', days: '⏳ Add days', repair: '🧽 Repair user', unlink: '🔌 Force unlink', remove: '🗑 Remove user' };
      if (!has(LAB, b.action)) throw E(400, 'Unknown action.'); need(uid, LAB[b.action]);
      if (!/^\d{1,20}$/.test(id) || !W.users().includes(id)) throw E(404, 'That user was not found.');
      if (W.isOwner(id) && !W.isOwner(uid)) throw E(403, 'Only the owner can change the owner account.');
      if (b.action === 'remove' && id === uid) throw E(400, 'You cannot remove your own account here.');
      W.logActivity(uid, `user:${b.action}`, id, String(b.value ?? '')); const p = W.prof(id), n = Number(b.value);
      switch (b.action) {
        case 'pause': case 'resume': p.paused = b.action === 'pause'; W.save(id, 'profile', p); return { ok: true };
        case 'limit': if (!Number.isInteger(n) || n < 1 || n > 10000) throw E(400, 'The limit must be a whole number from 1 to 10000.'); p.limit = n; W.save(id, 'profile', p); return { ok: true };
        case 'days': if (!Number.isInteger(n) || n < 1 || n > 3650) throw E(400, 'Enter a whole number of days from 1 to 3650.'); p.expires = Math.max(Date.now(), p.expires || 0) + n * 864e5; W.save(id, 'profile', p); return { ok: true };
        case 'repair': return { ok: true, cleared: await W.repairSession(id) };
        case 'unlink': await W.unlink(id); return { ok: true };
        case 'remove': await W.unlink(id); W.dropUser(id); return { ok: true };
      }
    },
    'GET /api/admin/payments': uid => {
      need(uid, '🕒 Pending');
      return { pending: W.load('_g', 'pending_payments', []).filter(x => x.status === 'pending').slice(-50).reverse().map(x => ({ uid: String(x.uid), at: x.at, plan: x.planName || '', price: x.price || '', days: x.days || null })) };
    },
    'POST /api/admin/payments/decide': async (uid, _p, b) => {
      const ok = b.action === 'approve'; if (!ok && b.action !== 'decline') throw E(400, 'Unknown action.'); need(uid, ok ? '✅ Approve' : '❌ Decline');
      const all = W.load('_g', 'pending_payments', []), item = [...all].reverse().find(x => String(x.uid) === String(b.uid) && x.status === 'pending');
      if (!item) throw E(404, 'That receipt was already handled.');
      if (!ok) { item.status = 'declined'; item.reviewedAt = Date.now(); W.save('_g', 'pending_payments', all); W.logActivity(uid, 'payment-declined', String(item.uid)); bot.declinedNotice?.(item.uid); return { ok: true }; }
      const n = Number(b.days ?? item.days); if (!Number.isInteger(n) || n < 1 || n > 3650) throw E(400, 'Enter a whole number of days from 1 to 3650.');
      const t = String(item.uid), p = W.prof(t); p.expires = Math.max(Date.now(), p.expires || 0) + n * 864e5; p.expNotified = false; if (item.planName) p.plan = item.planName; delete p.pendingPlan; W.save(t, 'profile', p);
      W.rewardReferrer(t); item.status = 'approved'; item.reviewedAt = Date.now(); item.daysGranted = n; W.logActivity(uid, 'payment-approved', t, `${item.planName || ''} ${n}d`);
      W.save('_g', 'pending_payments', all); bot.approvedNotice?.(t, item.planName, n); return { ok: true, days: n };
    },
    'POST /api/contacts/export': async uid => {
      need(uid, '📤 Export numbers'); const rows = Object.entries(W.load(uid, 'contacts', {})).filter(([n]) => /^\d{7,15}$/.test(n)); if (!rows.length) throw E(400, 'No contacts yet.');
      await sendFile(uid, toCsv([['Name', 'Phone', 'Source', 'Groups in', 'Status views', 'In audience'], ...rows.map(([n, c]) => [c.name || '', '+' + n, c.src || '', c.gc || 0, c.v || 0, c.out ? 'no' : 'yes'])]), 'contacts.csv', `📤 ${rows.length} unique contacts. Opens in Excel or Sheets.`);
      await sendFile(uid, rows.map(([n, c]) => `BEGIN:VCARD\nVERSION:3.0\nFN:${(c.name || '+' + n).replace(/[\r\n]/g, ' ')}\nTEL;TYPE=CELL:+${n}\nEND:VCARD`).join('\n'), 'contacts.vcf', 'Imports straight into your phone contacts.');
      W.logActivity(uid, 'app-export-contacts', rows.length); return { ok: true, total: rows.length };
    },
    'POST /api/contacts/dedupe': async uid => { need(uid, '🧹 Fix duplicates'); const r = await W.cleanContacts(uid); W.logActivity(uid, 'app-fix-duplicates', r.merged); return r; },
    'GET /api/links/chat': (uid, _p, _b, q) => {
      need(uid, '🔗 Group links'); const s = String(q.get('q') || '').toLowerCase().slice(0, 60); let all = chatLinks(uid); if (s) all = all.filter(x => x.url.toLowerCase().includes(s) || x.where.toLowerCase().includes(s));
      const per = 20, pages = Math.max(1, Math.ceil(all.length / per)), page = Math.min(Math.max(1, Number(q.get('page')) || 1), pages);
      return { total: all.length, page, pages, items: all.slice((page - 1) * per, page * per) };
    },
    'POST /api/links/info': async (uid, _p, b) => {
      need(uid, '🔗 Group links'); const code = String(b.code || ''); if (!GRP.test(code)) throw E(400, 'That is not a valid group link.');
      try { return await W.linkInfo(uid, code); } catch (e) { throw E(400, e.message); }
    },
    'POST /api/links/join': async (uid, _p, b) => {
      need(uid, '🔗 Group links'); const code = String(b.code || ''); if (!GRP.test(code)) throw E(400, 'That is not a valid group link.');
      try { await W.joinLink(uid, code); } catch (e) { throw E(400, e.message); } W.logActivity(uid, 'app-join-group', code); return { ok: true };
    },
    'GET /api/links/dead': uid => { need(uid, '🧾 Review dead links'); return { items: deadLinks(uid).slice(0, 200), total: deadLinks(uid).length, checking: checking.has(uid) }; },
    'POST /api/links/dead/delete': (uid, _p, b) => {
      need(uid, '🧾 Review dead links'); const D = W.load(uid, 'dead_links', {}), code = String(b.code || ''); if (!has(D, code)) throw E(404, 'That link was already removed.');
      delete D[code]; W.save(uid, 'dead_links', D); return { ok: true };
    },
    'POST /api/links/check': async uid => {
      need(uid, '🧹 Clean dead links'); if (checking.has(uid)) throw E(400, 'Already checking your links.'); if (!W.isUp(uid)) throw E(400, 'WhatsApp is not connected right now.');
      checking.add(uid); W.checkLinks(uid).then(n => W.logActivity(uid, 'app-check-links', n), () => {}).finally(() => checking.delete(uid)); return { started: true };
    },
    'POST /api/links/export': async (uid, _p, b) => {
      need(uid, '🔗 Group links'); const kind = String(b.kind || ''); let rows, head, name;
      if (kind === 'chat') { head = ['Link', 'Found in', 'Found on']; name = 'chat-links.csv'; rows = chatLinks(uid).map(x => [x.url, x.where, fmtD(x.at)]); }
      else if (kind === 'groups') { head = ['Group', 'Link', 'Members']; name = 'group-links.csv'; rows = Object.values(W.load(uid, 'groups', {})).filter(g => g.link).map(g => [g.subject || '', g.link, g.size || 0]); }
      else if (kind === 'dead') { need(uid, '🧾 Review dead links'); head = ['Link', 'Group', 'Found dead on']; name = 'dead-links.csv'; rows = deadLinks(uid).map(x => [x.url, x.where, fmtD(x.at)]); }
      else throw E(400, 'Unknown list.'); if (!rows.length) throw E(400, 'There is nothing to send yet.');
      await sendFile(uid, toCsv([head, ...rows]), name, `🔗 ${rows.length} links`); return { ok: true, total: rows.length };
    },
    'GET /api/templates': uid => {
      need(uid, '📋 My templates');
      return { templates: W.load(uid, 'templates', []).map((t, i) => ({ i, name: t.name, type: t.p?.type || 'text', preview: String(t.p?.text || t.p?.caption || '').slice(0, 80), bg: t.p?.bg || null })) };
    },
    'POST /api/templates/use': async (uid, _p, b) => {
      need(uid, '📋 My templates'); need(uid, '✍️ Post'); const t = W.load(uid, 'templates', [])[Number(b.index)]; if (!t) throw E(404, 'That template no longer exists.');
      const p = structuredClone(t.p); p.id = Date.now(); if (p.file && !fs.existsSync(p.file)) throw E(400, 'The file for this template is gone. Make the post again.');
      const sg = W.checkSpam(uid, p); if (!sg.ok) throw E(400, `This post ${sg.reason}.`); return launch(uid, p, b);
    },
    'POST /api/templates/delete': (uid, _p, b) => {
      need(uid, '🗑 Delete template'); const T = W.load(uid, 'templates', []), i = Number(b.index); if (!T[i]) throw E(404, 'That template no longer exists.');
      T.splice(i, 1); W.save(uid, 'templates', T); return { ok: true };
    },
    'GET /api/colours': uid => { need(uid, '⭐ Saved colours'); return { colors: (W.prof(uid).colors || []).map(c => ({ name: c.name, hex: c.hex })) }; },
    'POST /api/colours': (uid, _p, b) => {
      need(uid, '➕ Save a colour'); const hex = String(b.hex || '').trim(), name = String(b.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
      if (!/^#[0-9a-f]{6}$/i.test(hex)) throw E(400, 'Pick a valid colour.'); if (!name) throw E(400, 'Give the colour a name.');
      const pf = W.prof(uid); pf.colors = (pf.colors || []).filter(c => c.name !== name); if (pf.colors.length >= 30) throw E(400, 'You can save up to 30 colours.'); pf.colors.push({ name, hex: hex.toUpperCase() }); W.save(uid, 'profile', pf); return { ok: true };
    },
    'POST /api/colours/delete': (uid, _p, b) => {
      need(uid, '⭐ Saved colours'); const pf = W.prof(uid), n = (pf.colors || []).length; pf.colors = (pf.colors || []).filter(c => c.name !== String(b.name)); W.save(uid, 'profile', pf); return { ok: true, removed: n - pf.colors.length };
    },
    'GET /api/history': uid => {
      need(uid, '🗑 Delete a sent post');
      return { posts: W.load(uid, 'history', []).filter(h => h.msgId && !h.deleted && Date.now() - h.at < 24 * 36e5).slice(-10).reverse().map(h => ({ id: h.id, at: h.at, preview: String(h.preview || ''), people: Math.max(0, (h.n || 1) - 1), removing: unsending.has(uid + ':' + h.id) })) };
    },
    'POST /api/history/delete': async (uid, _p, b) => {
      need(uid, '🗑 Delete a sent post'); const h = W.load(uid, 'history', []).find(x => String(x.id) === String(b.id) && x.msgId && !x.deleted && Date.now() - x.at < 24 * 36e5);
      if (!h) throw E(404, 'That post can no longer be deleted.'); const k = uid + ':' + h.id; if (unsending.has(k)) throw E(400, 'It is already being removed.');
      if (!W.isUp(uid)) throw E(400, 'WhatsApp is not connected right now.');
      unsending.add(k); const run = W.deleteSentPost(uid, h.id); run.then(() => W.logActivity(uid, 'app-delete-sent-post', h.id), () => {}).finally(() => unsending.delete(k));
      const early = await Promise.race([run.then(() => null, e => e), sleep(1200)]); if (early instanceof Error) throw E(400, early.message); return { started: true };
    },
    'GET /api/messages': uid => {
      need(uid, '✉️ Messages');
      return { messages: W.load(uid, 'msgs', []).filter(m => m.status === 'scheduled').sort((a, b) => a.at - b.at).slice(0, 100).map(m => ({ id: m.id, type: m.type, text: m.type === 'text' ? m.text || '' : m.caption || '', at: m.at, repeat: m.repeat || 'none', target: targetInfo(m.target) })) };
    },
    'DELETE /api/messages/:id': (uid, { id }) => {
      need(uid, '✉️ Messages');
      const M = W.load(uid, 'msgs', []), m = M.find(x => String(x.id) === id && x.status === 'scheduled'); if (!m) throw E(404, 'That message is no longer scheduled.');
      m.status = 'cancelled'; W.save(uid, 'msgs', M); W.logActivity(uid, 'app-cancel-message', id); return { ok: true };
    },
    'GET /api/list': (uid, _p, _b, q) => {
      const kind = kindOf(q.get('kind')); listNeed(uid, kind); const { store, name } = getList(uid, kind, q.get('name')), ids = store[name];
      const used = W.load(uid, 'msgs', []).filter(m => m.status === 'scheduled' && m.target?.kind === (kind === 'groups' ? 'grouplist' : 'list') && m.target.name === name).length;
      if (kind === 'numbers') { const C = W.load(uid, 'contacts', {}); return { kind, name, total: ids.length, used, members: ids.slice(0, 200).map(n => ({ number: n, name: C[n]?.name || '' })) }; }
      const G = W.load(uid, 'groups', {});
      return { kind, name, total: ids.length, used, members: ids.slice(0, 200).map(id => has(G, id) ? { id, name: G[id].subject || '(no name)', size: G[id].size || 0 } : { id, name: 'A group you have left', size: 0, gone: true }) };
    },
    'POST /api/lists': (uid, _p, b) => {
      const kind = kindOf(b.kind); listNeed(uid, kind); const name = listName(b.name), store = W.load(uid, fileOf(kind), {});
      if (has(store, name)) throw E(400, 'You already have a list with that name.'); if (Object.keys(store).length >= 50) throw E(400, 'You can keep up to 50 lists of each kind.');
      const c = cleanItems(uid, kind, b.items); if (c.items.length > CAP[kind]) throw E(400, `A list can hold up to ${CAP[kind]}.`);
      store[name] = c.items; W.save(uid, fileOf(kind), store); W.logActivity(uid, 'app-create-list', name, kind); return { ok: true, name, total: c.items.length, skipped: c.skipped };
    },
    'POST /api/lists/add': (uid, _p, b) => {
      const kind = kindOf(b.kind); listNeed(uid, kind); const { store, name } = getList(uid, kind, b.name), c = cleanItems(uid, kind, b.items), before = new Set(store[name]);
      const merged = [...new Set([...store[name], ...c.items])]; if (merged.length > CAP[kind]) throw E(400, `A list can hold up to ${CAP[kind]}.`);
      store[name] = merged; W.save(uid, fileOf(kind), store); W.logActivity(uid, 'app-add-to-list', name, String(c.items.length));
      return { ok: true, added: c.items.filter(x => !before.has(x)).length, skipped: c.skipped, total: merged.length };
    },
    'POST /api/lists/remove': (uid, _p, b) => {
      const kind = kindOf(b.kind); listNeed(uid, kind); const { store, name } = getList(uid, kind, b.name), drop = new Set((Array.isArray(b.items) ? b.items : []).map(String)), before = store[name].length;
      store[name] = store[name].filter(x => !drop.has(x)); W.save(uid, fileOf(kind), store); W.logActivity(uid, 'app-remove-from-list', name, String(before - store[name].length));
      return { ok: true, removed: before - store[name].length, total: store[name].length };
    },
    'POST /api/lists/delete': (uid, _p, b) => {
      const kind = kindOf(b.kind); listNeed(uid, kind); const { store, name } = getList(uid, kind, b.name);
      delete store[name]; W.save(uid, fileOf(kind), store); W.logActivity(uid, 'app-delete-list', name, kind); return { ok: true };
    },
    'GET /api/groups': (uid, _p, _b, q) => {
      need(uid, '✉️ Messages');
      const term = String(q.get('q') || '').trim().toLowerCase().slice(0, 40), G = W.load(uid, 'groups', {});
      const groups = Object.entries(G).filter(([, g]) => !term || String(g.subject || '').toLowerCase().includes(term)).sort((a, b) => String(a[1].subject || '').localeCompare(String(b[1].subject || ''))).slice(0, 40)
        .map(([id, g]) => ({ id, name: g.subject || '(no name)', size: g.size || 0, admin: g.role === 'admin' }));
      return { groups, total: Object.keys(G).length };
    },
    'GET /api/channels': uid => { need(uid, '✉️ Messages'); const H = W.load(uid, 'channels', {}); return { channels: Object.entries(H).map(([id, c]) => ({ id, name: c.name, role: c.role || '' })) }; },
    'POST /api/messages': async (uid, _p, body) => {
      need(uid, '✉️ Messages');
      if (!W.linked(uid)) throw E(400, 'Link WhatsApp in the bot first.');
      const text = String(body.text ?? '').trim(); if (!text) throw E(400, 'Write the message first.'); if (text.length > 2000) throw E(400, 'Keep it under 2000 characters.');
      const target = cleanTarget(uid, body.target), n = W.targetCount(uid, target); if (!n) throw E(400, 'Nobody to send this to. Check who you picked.');
      const { max } = W.msgUsage(uid); if (!isAdm(uid) && n > max) throw E(400, `Too many recipients (${n}). The limit is ${max} per message.`);
      const m = { type: 'text', text, target, id: Date.now() }, sg = W.checkSpam(uid, m); if (!sg.ok) throw E(400, `This message ${sg.reason}.`);
      if (body.when === 'later') {
        const at = futureAt(body.at), M = W.load(uid, 'msgs', []); M.push({ ...m, at, repeat: 'none', status: 'scheduled' }); W.save(uid, 'msgs', M); W.logActivity(uid, 'app-schedule-message', m.id);
        return { scheduled: true, at, recipients: n };
      }
      if (!W.isUp(uid)) throw E(400, 'WhatsApp is not connected right now.');
      const run = W.runMessage(uid, m); W.logActivity(uid, 'app-send-message', m.id);
      const early = await Promise.race([run.then(() => null, e => e), sleep(800)]);
      if (early instanceof Error) throw E(400, early.message);
      run.catch(() => {}); return { started: true, recipients: n };
    },
    'POST /api/posts/:id/edit': (uid, { id }, body) => {
      need(uid, '🗓 Schedule a post');
      const P = W.load(uid, 'posts', []), p = P.find(x => String(x.id) === id && x.status === 'scheduled'); if (!p) throw E(404, 'That post is no longer scheduled.');
      applyEdit(uid, p, body, 700); W.save(uid, 'posts', P); W.logActivity(uid, 'app-edit-post', id); return { ok: true, at: p.at };
    },
    'POST /api/messages/:id/edit': (uid, { id }, body) => {
      need(uid, '✉️ Messages');
      const M = W.load(uid, 'msgs', []), m = M.find(x => String(x.id) === id && x.status === 'scheduled'); if (!m) throw E(404, 'That message is no longer scheduled.');
      applyEdit(uid, m, body, 2000); W.save(uid, 'msgs', M); W.logActivity(uid, 'app-edit-message', id); return { ok: true, at: m.at };
    },
    'GET /api/plans': uid => {
      need(uid, '💳 Plan');
      const pf = W.prof(uid), online = W.onlinePayOn(), general = { link: W.CFG.payLink || '', bank: W.CFG.bank || '' };
      return { online, email: pf.email || '', general, plans: W.load('_g', 'plans', []).map(p => ({ id: p.id, name: p.name, price: p.price, days: p.days, payable: online && !!W.parsePrice(p.price), manual: { link: p.link || general.link, bank: p.bank || general.bank } })) };
    },
    'POST /api/pay': async (uid, _p, body) => {
      need(uid, '💳 Plan');
      if (!W.onlinePayOn()) throw E(400, 'Online payment is not switched on. Use the bank details instead.');
      const plan = W.load('_g', 'plans', []).find(x => String(x.id) === String(body.planId)); if (!plan) throw E(404, 'That plan no longer exists.');
      const pf = W.prof(uid); let email = String(body.email || pf.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw E(400, 'Enter a valid email address for the receipt.');
      if (email !== pf.email) { pf.email = email; W.save(uid, 'profile', pf); }
      pf.pendingPlan = plan.id; W.save(uid, 'profile', pf);
      try { const r = await W.startOnlinePayment(uid, plan, email); W.logActivity(uid, 'app-pay-start', r.ref, plan.name); return { url: r.url }; }
      catch (e) { throw E(400, e.message || 'Could not start the payment.'); }
    },
    'GET /api/insights': uid => {
      need(uid, '📊 Insights');
      const V = W.load(uid, 'views', { log: [] }), C = W.load(uid, 'contacts', {}), H = W.load(uid, 'history', []), hours = Array(24).fill(0);
      for (const x of V.log || []) if (x.h >= 0 && x.h < 24) hours[x.h]++;
      const since = Date.now() - 7 * 864e5, last7 = (V.log || []).filter(x => x.t >= since), vs = Object.entries(C).filter(([, c]) => c.v > 0);
      return {
        hours, views7: last7.length, viewers7: new Set(last7.map(x => x.who)).size, posts7: H.filter(h => h.at >= since).length,
        totals: { posts: H.length, viewers: vs.length, views: vs.reduce((s, [, c]) => s + c.v, 0) },
        topViewers: vs.sort((a, b) => b[1].v - a[1].v).slice(0, 10).map(([n, c]) => ({ name: c.name || '', number: n, views: c.v, last: c.lastView || 0 })),
        bestPosts: [...H].sort((a, b) => (b.viewers?.length || 0) - (a.viewers?.length || 0)).slice(0, 5).map(h => ({ preview: h.preview, at: h.at, views: h.viewers?.length || 0, sent: Math.max(0, (h.n || 1) - 1) }))
      };
    },
    'GET /api/jobs': uid => { need(uid, '📡 Sending now'); return { jobs: W.activeJobs(uid).map(j => ({ id: j.id, type: j.type, preview: j.preview, total: j.total, sent: j.sent, started: j.started, stopping: !!j.cancel })) }; },
    'POST /api/jobs/:id/stop': (uid, { id }) => { need(uid, '📡 Sending now'); const n = W.cancelJobs(uid, id); if (!n) throw E(404, 'That send already finished.'); W.logActivity(uid, 'app-stop-send', id); return { ok: true }; },
    'GET /api/account': uid => {
      const p = W.prof(uid), me = W.waMe(uid), ls = W.linkState[uid];
      return {
        wa: { linked: W.linked(uid), up: W.isUp(uid), number: me?.number || '' }, alerts: !!p.alerts, weekly: !!p.weekly, autoPrune: !!p.autoPrune,
        can: { alerts: canSee(uid, '🔔 Toggle alerts'), weekly: canSee(uid, '📰 Toggle weekly report'), prune: canSee(uid, '🧹 Toggle auto-prune'), repair: canSee(uid, '🧽 Repair session') },
        health: W.load(uid, 'health', { events: [] }).events.slice(-8).reverse().map(e => ({ t: e.t, kind: e.kind, detail: e.detail || '' })),
        code: ls && Date.now() - ls.t < 170000 ? ls.code : null
      };
    },
    'POST /api/account/toggle': (uid, _p, b) => {
      const map = { alerts: '🔔 Toggle alerts', weekly: '📰 Toggle weekly report', autoPrune: '🧹 Toggle auto-prune' };
      if (!has(map, b.key)) throw E(400, 'Unknown setting.'); need(uid, map[b.key]);
      const p = W.prof(uid); p[b.key] = !p[b.key]; W.save(uid, 'profile', p); return { ok: true, value: p[b.key] };
    },
    'POST /api/link': async (uid, _p, b) => {                          // same pairing-code flow as the bot's Phone code button
      if (W.isUp(uid)) throw E(400, 'WhatsApp is already connected.');
      const n = parseNumbers(b.phone).items[0]; if (!n) throw E(400, 'Enter your WhatsApp number with country code.');
      delete W.linkState[uid];
      const run = W.connect(uid, 'code', n); run.catch(() => {});
      try { await Promise.race([run, sleep(1500)]); } catch (e) { throw E(400, e.message || 'Could not start linking.'); }
      return { ok: true };
    },
    'POST /api/repair': async uid => {
      need(uid, '🧽 Repair session'); if (!W.linked(uid)) throw E(400, 'WhatsApp is not linked.');
      try { return { ok: true, cleared: await W.repairSession(uid) }; } catch { throw E(500, 'Could not repair the session. Try linking again.'); }
    },
    'POST /api/unlink': async uid => { await W.unlink(uid); return { ok: true }; },
    'GET /api/groups/all': uid => {
      need(uid, '👪 Groups & links'); const G = Object.entries(W.load(uid, 'groups', {})), t = Date.now() - 45 * 864e5;
      const groups = G.map(([id, g]) => ({ id, name: g.subject || '', size: g.size || 0, admin: g.role === 'admin', link: g.link || '', quiet: !g.subject || !g.lastMsg || g.lastMsg < t }))
        .sort((a, b) => (b.quiet - a.quiet) || a.name.localeCompare(b.name)).slice(0, 1000);
      return { groups, total: G.length };
    },
    'POST /api/groups/refresh': async uid => {
      need(uid, '👪 Groups & links');
      if (Date.now() - (W.prof(uid).linkedAt || 0) < 60 * 60e3) throw E(400, 'Wait about an hour after linking before refreshing groups. WhatsApp can remove a brand-new device that does this too early.');
      try { const n = await W.refreshGroups(uid), p = W.prof(uid); p.groupsSyncedAt = Date.now(); W.save(uid, 'profile', p); return { ok: true, total: n }; }
      catch { throw E(400, 'WhatsApp is not connected. Repair or link your session first.'); }
    },
    'GET /api/exclusions': uid => { need(uid, '🚫 Exclusions'); return { numbers: W.load(uid, 'exclude', []) }; },
    'POST /api/exclusions': (uid, _p, b) => {
      need(uid, '🚫 Exclusions'); const cur = W.load(uid, 'exclude', []), n = parseNumbers(b.numbers).items;
      if (!n.length) throw E(400, 'Enter at least one valid number with country code.');
      const next = b.action === 'remove' ? cur.filter(x => !n.includes(x)) : [...new Set([...cur, ...n])];
      if (next.length > 5000) throw E(400, 'You can exclude up to 5000 numbers.'); W.save(uid, 'exclude', next); return { ok: true, total: next.length };
    },
    'GET /api/inbox': uid => {
      need(uid, '📌 Notices'); const mine = W.load('_g', 'admin_inbox', []).filter(m => String(m.uid) === String(uid)).slice(-5).reverse();
      return { notices: W.load('_g', 'notices', []).slice(-10).reverse().map(n => ({ text: String(n.text || ''), at: n.at || n.t || null })), canMessage: !!bot.hasAdmin?.(), mine: mine.map(m => ({ text: m.text, at: m.at, replied: !!m.replied })) };
    },
    'POST /api/inbox/message': async (uid, _p, b) => {
      need(uid, '✉️ Message admin'); if (!bot.hasAdmin?.()) throw E(400, 'There is no admin contact configured.');
      const text = String(b.text ?? '').trim(); if (!text) throw E(400, 'Write a message first.'); if (text.length > 4000) throw E(400, 'Keep it under 4000 characters.');
      const inbox = W.load('_g', 'admin_inbox', []); if (inbox.filter(m => String(m.uid) === String(uid) && Date.now() - m.at < 36e5).length >= 5) throw E(429, 'You can send 5 messages an hour. Please wait a little.');
      inbox.push({ uid: Number(uid), text, at: Date.now(), replied: false }); W.save('_g', 'admin_inbox', inbox.slice(-500));
      let notified = true; try { await bot.notifyAdmin(`✉️ Message from ${uid}:\n${bot.esc(text)}`); } catch { notified = false; }
      return { ok: true, notified };
    },
    'GET /api/referral': uid => {
      need(uid, '🎁 Refer a friend'); const p = W.prof(uid), days = bot.refDays?.() ?? 0;
      return { active: days > 0 && !!bot.refLink?.(uid), days, link: bot.refLink?.(uid) || '', joined: p.refJoined || 0, paid: p.refPaid || 0, earned: p.refDaysEarned || 0 };
    },
    'GET /api/lists': uid => {
      need(uid, '🏷 Lists');
      const row = ([name, v]) => ({ name, count: v.length });
      return { numbers: Object.entries(W.load(uid, 'lists', {})).map(row), groups: Object.entries(W.load(uid, 'grouplists', {})).map(row) };
    }
  };
  const compiled = Object.entries(routes).map(([k, fn]) => { const [method, pattern] = k.split(' '); return { method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn }; });

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && allow.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Max-Age': '600' } : {};
    try {
      const key = process.env.MINIAPP_PROXY_KEY;                      // when set, only your proxy (which knows the key) may call this API
      if (key) { const got = Buffer.from(String(req.headers['x-proxy-key'] || '')), want = Buffer.from(key); if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(res, 403, { error: 'Forbidden.' }, {}); }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited('ip:' + ip, 300)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' }, cors);
      if (path === '/api/health') return send(res, 200, { ok: true, build }, cors);
      const m = /^tma (.+)$/s.exec(req.headers.authorization || ''), user = m && verifyInitData(m[1], token);
      if (!user) return send(res, 401, { error: 'Open this app from the bot in Telegram.' }, cors);
      const uid = String(user.id);
      if (limited('u:' + uid, 120)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' }, cors);
      if (!W.users().includes(uid)) return send(res, 403, { error: 'Open the bot and send /start first.' }, cors);
      if (req.method === 'POST' && path === '/api/upload') return send(res, 200, await upload(uid, req, new URL(req.url, 'http://x').searchParams), cors);
      for (const r of compiled) {
        if (r.method !== req.method) continue; const hit = r.re.exec(path); if (!hit) continue;
        const body = req.method === 'POST' ? await readBody(req) : {};
        return send(res, 200, await r.fn(uid, hit.groups || {}, body, new URL(req.url, 'http://x').searchParams), cors);
      }
      return send(res, 404, { error: 'Not found.' }, cors);
    } catch (e) {
      const code = Number(e?.code) >= 400 && Number(e?.code) < 600 ? Number(e.code) : 500;
      if (code === 500) console.error('api error', e?.message);
      send(res, code, { error: code === 500 ? 'Something went wrong on the server.' : e.message }, cors);
    }
  });
  server.listen(port, '0.0.0.0', () => console.log(`Mini App API listening on ${port} for ${[...allow].join(', ') || '(no origin set)'}`));
  return server;
}
