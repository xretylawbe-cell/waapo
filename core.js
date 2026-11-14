// core.js — WhatsApp engine, data layer, posting, jobs. UI lives in index.js
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { makeCacheableSignalKeyStore, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, generateWAMessage } from '@whiskeysockets/baileys';

const E = process.env;
for (const k of ['error', 'warn', 'info', 'log']) { const o = console[k].bind(console); console[k] = (...a) => { if (/Bad MAC|Failed to decrypt message with any known session|Session error|Closing open session|Closing session|Opening session|Removing old closed session/i.test(String(a[0]))) { core_bad.n++; return; } o(...a); }; }
const core_bad = { n: 0 };
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#')) E[m[1]] ??= m[2];
}
const BASE = {
  token: E.BOT_TOKEN, admin: String(E.ADMIN_ID || ''), tz: Number(E.TZ_OFFSET ?? 1),
  limit: Number(E.DEFAULT_DAILY_LIMIT ?? 10), batch: Number(E.BATCH_SIZE ?? 200),
  require: E.REQUIRE_PLAN === '1', trial: Number(E.TRIAL_DAYS ?? 3),
  payLink: E.PAY_LINK || '', bank: (E.BANK_DETAILS || '').replace(/\\n/g, '\n'), maxAud: Number(E.MAX_AUDIENCE ?? 2500)
};
export const CFG = new Proxy(BASE, { get: (t, k) => { try { const o = load('_g', 'settings', {}); if (k in o) return o[k]; } catch {} return t[k]; } });
export function setCfg(k, v) { const o = load('_g', 'settings', {}); o[k] = v; save('_g', 'settings', o); }
export const adminList = () => [BASE.admin, ...load('_g', 'admins', [])].filter(Boolean);
export const isAdmin = u => adminList().includes(String(u));
export const isOwner = u => String(u) === BASE.admin;
export const setAdmins = a => save('_g', 'admins', a);
const TZ = BASE.tz, DAY = 864e5;
export const DATA = 'data';
fs.mkdirSync(`${DATA}/deleted`, { recursive: true });
export const sleep = ms => new Promise(r => {
  const timer = setTimeout(r, ms);
  timer.unref?.();
});
export const rnd = (a, b) => a + Math.random() * (b - a);
export const hooks = { note() {}, opened() {}, qr() {}, code() {}, expired() {}, report() {}, backup() {}, progress() {} };

// ---------- cached JSON store (debounced writes) ----------
const C = {}, dirty = new Set();
let schedulerTimer;
const schedulerBusy = new Set();
export const udir = id => { const d = `${DATA}/${id}`; fs.mkdirSync(d, { recursive: true }); return d; };
export function load(id, f, def) {
  const k = `${id}/${f}`;
  if (!(k in C)) { try { C[k] = JSON.parse(fs.readFileSync(`${udir(id)}/${f}.json`)); } catch { C[k] = def; } }
  return C[k];
}
export function save(id, f, v) { C[`${id}/${f}`] = v; dirty.add(`${id}/${f}`); }
export function flush() { for (const k of dirty) { const [id, f] = k.split('/'); try { fs.writeFileSync(`${udir(id)}/${f}.json`, JSON.stringify(C[k])); } catch {} } dirty.clear(); }
const flushTimer = setInterval(flush, 3000);
export function shutdown() {
  clearInterval(flushTimer);
  if (schedulerTimer) clearInterval(schedulerTimer);
  for (const uid of Object.keys(socks)) {
    gen[uid] = (gen[uid] || 0) + 1;
    up[uid] = false;
    try { socks[uid]?.end?.(undefined); } catch {}
    delete socks[uid];
  }
  flush();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
export const users = () => fs.readdirSync(DATA).filter(x => /^\d+$/.test(x));

// ---------- helpers ----------
export const hr = h => `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`;
export const fmt = ts => { const d = new Date(ts + TZ * 36e5); let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap}`; };
export const dayKey = () => new Date(Date.now() + TZ * 36e5).toISOString().slice(0, 10);
const D0 = () => ({ paused: false, limit: CFG.limit, expires: CFG.require ? Date.now() + CFG.trial * DAY : null, sent: { day: '', n: 0 }, total: 0, alerts: true, weekly: true, autoPrune: false, tagN: 5, tagMode: 'shuffle', color: '#128C7E', textColor: '#FFFFFF', font: 1, colors: [], created: Date.now() });
export function prof(id) { const p = load(id, 'profile', D0()); for (const [k, v] of Object.entries(D0())) p[k] ??= v; return p; }
export const expired = p => CFG.require ? (!p.expires || Date.now() > p.expires) : !!(p.expires && Date.now() > p.expires);
const argb = h => parseInt('FF' + h.replace('#', ''), 16);

// ---------- WhatsApp sessions ----------
const socks = {}, gen = {}, tries = {}, up = {}, alerted = {}, repairs = {}, sentMsgs = new Map(), pendingCode = {}, lastCodeReq = {}, loggedOutOnce = {}, stableT = {};
export const isUp = u => !!up[u];
const isPairedCreds = c => !!(c?.me && (c.account || (Array.isArray(c.signalIdentities) && c.signalIdentities.length)));   // set by pair-success only
export const linked = u => { try { return isPairedCreds(JSON.parse(fs.readFileSync(`${DATA}/${u}/auth/creds.json`))); } catch { return false; } };
const wipe = u => { fs.rmSync(`${DATA}/${u}/auth`, { recursive: true, force: true }); try { const p = prof(u); p.welcomed = false; save(u, 'profile', p); } catch {} };

const badBuf = {}, lastAuto = {}, closes = {};
export function logHealth(uid, kind, detail) { const h = load(uid, 'health', { events: [] }); h.events.push({ t: Date.now(), kind, detail: String(detail ?? '').slice(0, 80) }); h.events = h.events.slice(-30); save(uid, 'health', h); }
export function healthSummary(uid) {
  const ev = load(uid, 'health', { events: [] }).events.slice(-6).reverse();
  return ev.length ? ev.map(e => `${fmt(e.t)} — ${e.kind}${e.detail ? ' ' + e.detail : ''}`).join('\n') : 'No problems recorded.';
}
function autoRepair(uid, why) {
  if (CFG.autoRepair === false) return;                            // admin turned automatic repair off
  if (Date.now() - (prof(uid).linkedAt || 0) < 6 * 36e5) return;    // a freshly linked device cannot decrypt old messages — that is normal, not damage
  if (Date.now() - (lastAuto[uid] || 0) < 6 * 36e5) return;       // at most once every 6 hours
  lastAuto[uid] = Date.now(); badBuf[uid] = []; logHealth(uid, 'auto-repair', why);
  repairSession(uid).then(n => hooks.note(uid, `🧽 Your WhatsApp session was repaired automatically (${n} stale files cleared).`)).catch(() => {});
}
function noteBad(uid, jid) {                                      // one contact failing = normal; many contacts failing = broken local session
  const now = Date.now(), b = (badBuf[uid] || []).filter(x => now - x.t < 6e5); b.push({ t: now, j: jid }); badBuf[uid] = b;
  if (b.length >= 60 && new Set(b.map(x => x.j)).size >= 15) autoRepair(uid, 'decrypt failures from many contacts');
}
function makeLogger(uid) {
  const sink = { write(line) { try { if (!/decrypt|Bad MAC|No matching sessions|No session/i.test(line)) return; const o = JSON.parse(line); if (/decrypt|Bad MAC|No matching|No session/i.test(`${o.msg || ''} ${o.err?.message || o.err || ''}`)) noteBad(uid, o.key?.participant || o.key?.remoteJid || '?'); } catch {} } };
  return pino({ level: 'error' }, sink);
}
const lidCache = new Map();
async function lookupPN(sock, lid) {                              // LID -> real phone number, cached (misses expire after 30 min)
  const hit = lidCache.get(lid); if (hit && (hit.v || Date.now() - hit.t < 18e5)) return hit.v;
  let v = null; try { v = (await sock.signalRepository?.lidMapping?.getPNForLID?.(lid)) || null; } catch {}
  lidCache.set(lid, { v, t: Date.now() }); if (lidCache.size > 60000) lidCache.delete(lidCache.keys().next().value);
  return v;
}
const digitsOf = id => { const d = String(id || '').split('@')[0].split(':')[0]; return /^\d{7,15}$/.test(d) ? d : null; };
async function toPhone(sock, id) {
  if (!id || typeof id !== 'string') return null;
  const [user, domain = 's.whatsapp.net'] = id.split('@'), base = user.split(':')[0];
  if (domain === 'lid' || domain === 'hosted.lid') { const pn = await lookupPN(sock, base + '@lid'); return pn ? digitsOf(pn) : null; }
  if (domain !== 's.whatsapp.net' && domain !== 'c.us') return null;
  const pn = await lookupPN(sock, base + '@lid');                 // guard: these digits may really be a LID
  if (pn && digitsOf(pn) && digitsOf(pn) !== base) return digitsOf(pn);
  return digitsOf(base);
}
async function addC(uid, sock, arr, src, group) {
  const c = load(uid, 'contacts', {}), got = []; let ch = false;
  for (const x of arr || []) {
    const id = x.phoneNumber || x.id; if (!id || /@(g\.us|broadcast|newsletter)/.test(id)) continue;
    const n = await toPhone(sock, id); if (!n) continue;
    const o = c[n] ??= { name: '', src, added: Date.now(), v: 0, lastView: 0 };
    const nm = x.name || x.verifiedName || x.notify || x.pushName; if (nm && !o.name) o.name = nm;
    if (src === 'phonebook' && x.name) o.src = 'phonebook';
    if (src === 'chat' && o.src === 'group') o.src = 'chat';
    if (group) o.g = 1; if (x.active) o.lastMsg = Date.now(); ch = true; got.push(n);
  }
  if (ch) save(uid, 'contacts', c);
  return got;
}

const maxSessions = () => { const mb = (process.constrainedMemory?.() || os.totalmem()) / 1048576; return Number(E.MAX_SESSIONS) || Math.max(5, Math.floor((mb - 250) / 60)); };   // ≈60 MB per live session
export const sessionCapacity = () => ({ live: Object.keys(up).filter(k => up[k]).length, max: maxSessions() });
export async function connect(uid, mode = 'resume', phone = '') {
  if (mode === 'resume' && !linked(uid)) return;                     // never "resume" a half-finished pairing
  if (mode !== 'resume' && linked(uid)) throw new Error('This account is already linked. Unlink it first if you want to link a different number.');   // never overwrite a live session
  const digits = String(phone || '').replace(/\D/g, '');
  if (mode === 'code') {
    const pc = pendingCode[uid];
    if (pc && pc.phone === digits && Date.now() - pc.at < 170000 && socks[uid] && !linked(uid)) { hooks.code(uid, pc.code); return; }   // same live code: do NOT restart (that kills it)
    if (Date.now() - (lastCodeReq[uid] || 0) < 45000) throw new Error('Please wait a few seconds before asking for another code.');
    lastCodeReq[uid] = Date.now();
  }
  if (mode !== 'resume' && !linked(uid)) {
    if (Object.keys(up).filter(k => up[k]).length >= maxSessions()) throw new Error('The server is full right now. Please try again a little later.');
    wipe(uid);                                                       // leftovers of an earlier half-finished attempt must not leak into this one
  }
  const my = gen[uid] = (gen[uid] || 0) + 1;
  try { socks[uid]?.end?.(undefined); } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(`${udir(uid)}/auth`);
  const { version } = await fetchLatestBaileysVersion();
  if (gen[uid] !== my) return;                                  // a newer connect() took over: never run two sockets on one session
  const log = makeLogger(uid);
  const sock = makeWASocket({
    version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) }, logger: log,
    getMessage: async k => sentMsgs.get(k.id), browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
    qrTimeout: 120000, keepAliveIntervalMs: 25000, connectTimeoutMs: 90000, defaultQueryTimeoutMs: 120000
  });
  socks[uid] = sock;
  let codeAsked = false;
  sock.ev.on('creds.update', saveCreds);
  // WhatsApp now sends contacts' statuses as a top-level <status> stanza that Baileys never acknowledges; ~50 min later the server drops the stream (500 "Stream Errored (ack)"). Acknowledge it ourselves (Baileys issue #2858).
  sock.ws?.on?.('CB:status', node => {
    try {
      const a = node?.attrs || {}; if (!a.id) return;
      const ack = { tag: 'ack', attrs: { id: a.id, class: 'status' } };
      if (a.from) ack.attrs.to = a.from; if (a.participant) ack.attrs.participant = a.participant; if (a.recipient) ack.attrs.recipient = a.recipient; if (a.type) ack.attrs.type = a.type;
      sock.sendNode(ack).catch(() => {});
    } catch {}
  });

  const paired = () => isPairedCreds(state.creds) || linked(uid);
  sock.ev.on('connection.update', async u => {
    if (gen[uid] !== my) return;
    const { connection, lastDisconnect, qr } = u;
    if (qr && !paired()) {
      if (mode === 'qr') hooks.qr(uid, await QRCode.toBuffer(qr, { width: 440, margin: 2 }));
      if (mode === 'code' && !codeAsked) {                         // ask once, when the socket is truly ready
        codeAsked = true;
        try { const code = await sock.requestPairingCode(digits); pendingCode[uid] = { code, phone: digits, at: Date.now() }; hooks.code(uid, code); }
        catch { hooks.note(uid, '❌ Could not get a code. Check the number (with country code) and try again.'); }
      }
    }
    if (connection === 'open') {
      up[uid] = true; tries[uid] = 0; mode = 'resume'; delete pendingCode[uid]; loggedOutOnce[uid] = 0;
      clearTimeout(stableT[uid]); stableT[uid] = setTimeout(() => { repairs[uid] = 0; }, 15 * 60e3); stableT[uid].unref?.();   // a stable session earns a clean slate
      const pf = prof(uid);
      if (pf.welcomed === undefined && Date.now() - (pf.created || 0) > 15 * 60e3) { pf.welcomed = true; save(uid, 'profile', pf); }   // existing users: no surprise message
      else if (!pf.welcomed) { pf.welcomed = true; pf.linkedAt = Date.now(); save(uid, 'profile', pf); hooks.opened(uid); }      // first open after a real link
      else if (alerted[uid]) { alerted[uid] = false; hooks.note(uid, '🟢 WhatsApp reconnected.'); }
      scheduleGroupSync(uid, 20000);                              // every open: sync if never synced or older than 24 h
    }
    if (connection === 'close') {
      up[uid] = false;
      const err = lastDisconnect?.error, code = err?.output?.statusCode, msg = String(err?.message || '');
      const isAck = /\(ack\)/i.test(msg);                          // the known 50-minute status-ack drop: harmless, just reconnect
      logHealth(uid, isAck ? 'reconnect' : 'disconnected', `code ${code ?? '?'} ${msg}${err?.data ? ' ' + JSON.stringify(err.data).slice(0, 60) : ''}`);
      if (!paired()) {                                             // the link itself did not finish: remove anything half-done
        delete pendingCode[uid]; delete socks[uid]; wipe(uid);
        return hooks.note(uid, '⌛ The link did not finish. Tap 📲 Link WhatsApp and try again — tap it once, then enter the new code straight away.');
      }
      if (code === 515) { try { await saveCreds(); } catch {} return connect(uid, 'resume').catch(() => {}); }    // restart required right after pairing (save first!)
      if (isAck) { await sleep(400); if (gen[uid] === my) connect(uid, 'resume').catch(() => {}); return; }
      const cl = closes[uid] = (closes[uid] || []).filter(t => Date.now() - t < 6e5).concat(Date.now());
      if (cl.length >= 6) autoRepair(uid, 'reconnect loop');
      if (code === 500 && CFG.autoRepair !== false && (repairs[uid] = (repairs[uid] || 0) + 1) <= 2) {   // other bad-session errors: repair twice, then plain retries (never give up)
        repair(uid); logHealth(uid, 'repair', 'stale sessions cleared'); await sleep(1500); if (gen[uid] === my) connect(uid, 'resume').catch(() => {}); return;
      }
      if ([401, 411].includes(code)) {
        if (!loggedOutOnce[uid] || Date.now() - loggedOutOnce[uid] > 120000) { loggedOutOnce[uid] = Date.now(); await sleep(4000); if (gen[uid] === my) connect(uid, 'resume').catch(() => {}); return; }   // one quiet retry before giving up
        loggedOutOnce[uid] = 0; wipe(uid); delete socks[uid];
        return hooks.note(uid, '⚠️ WhatsApp ended this session (it was removed from Linked devices, or WhatsApp logged it out). Tap 📲 Link WhatsApp to link again.', true);
      }
      if (code === 403) { delete socks[uid]; return hooks.note(uid, '🚫 WhatsApp refused this connection (possible restriction).', true); }
      if (code === 440) { delete socks[uid]; return hooks.note(uid, '⚠️ Another session replaced this one. Re-link if needed.', true); }
      tries[uid] = (tries[uid] || 0) + 1;                          // 428/408/503 etc: back off, then keep trying quietly
      if (tries[uid] === 4 && prof(uid).alerts && !alerted[uid]) { alerted[uid] = true; hooks.note(uid, '🔴 WhatsApp is disconnected. I keep retrying; tell me if it persists.', true); }
      await sleep(Math.min(60000, 1500 * tries[uid]) + Math.random() * 1500);        // jitter: thousands of sessions must never retry in lockstep
      if (gen[uid] === my) connect(uid, 'resume').catch(() => {});
    }
  });

  sock.ev.on('contacts.upsert', a => gen[uid] === my && addC(uid, sock, a, 'phonebook'));
  sock.ev.on('messaging-history.set', ({ contacts }) => contacts && addC(uid, sock, contacts, 'phonebook'));
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (gen[uid] !== my) return;
    for (const m of messages) {
      if (m.key.remoteJid === 'status@broadcast') continue;
      if (m.key.fromMe) {                                          // remember who I wrote to (reach-out skips them)
        if (!m.key.remoteJid?.endsWith('@g.us')) {
          const n = await toPhone(sock, [m.key.remoteJidAlt, m.key.remoteJid].find(x => typeof x === 'string' && x.endsWith('@s.whatsapp.net')) || m.key.remoteJid);
          const C = load(uid, 'contacts', {}); if (n && C[n]) { C[n].lastOut = Date.now(); save(uid, 'contacts', C); }
        }
        continue;
      }
      const isG = m.key.remoteJid?.endsWith('@g.us');
      const alt = [m.key.participantAlt, m.key.remoteJidAlt, m.key.participantPn, m.key.remoteJidPn, m.key.senderPn].find(x => typeof x === 'string' && x.endsWith('@s.whatsapp.net'));
      const who = alt || (isG ? m.key.participant : m.key.remoteJid);
      if (m.messageStubType === 2 || m.messageStubType === 'CIPHERTEXT') noteBad(uid, who || '?');
      if (isG) { const G = load(uid, 'groups', {}); if (G[m.key.remoteJid]) { G[m.key.remoteJid].lastMsg = Date.now(); save(uid, 'groups', G); } }
      const got = await addC(uid, sock, [{ id: who, pushName: m.pushName, active: true }], isG ? 'group' : 'chat', isG);
      const t = m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || '';
      if (!isG && got[0]) {                                        // STOP = never message again; replies to reach-out are counted
        const C = load(uid, 'contacts', {}), x = C[got[0]];
        if (x) {
          if (/^\s*(stop|unsubscribe|opt[- ]?out)\s*[.!]?\s*$/i.test(t)) x.optOut = true;
          if (x.reachedAt && !x.replied && Date.now() - x.reachedAt < 3 * DAY) { x.replied = true; const pf = prof(uid); if (pf.reach) { pf.reach.replies = (pf.reach.replies || 0) + 1; save(uid, 'profile', pf); } }
          save(uid, 'contacts', C);
        }
      }
      for (const x of t.matchAll(/chat\.whatsapp\.com\/([A-Za-z0-9]{18,26})/g)) {
        const L = load(uid, 'links_seen', {}); L[x[1]] ??= { url: 'https://chat.whatsapp.com/' + x[1], group: isG ? m.key.remoteJid : null, at: Date.now() }; save(uid, 'links_seen', L);
      }
    }
  });
  sock.ev.on('groups.upsert', () => refreshGroups(uid).catch(() => {}));
  sock.ev.on('message-receipt.update', async ups => {       // who viewed my status
    if (gen[uid] !== my) return;
    const V = load(uid, 'views', { log: [] }), c = load(uid, 'contacts', {}), H = load(uid, 'history', []);
    for (const { key, receipt } of ups) {
      if (key.remoteJid !== 'status@broadcast' || !(receipt.readTimestamp || receipt.playedTimestamp)) continue;
      const n = await toPhone(sock, receipt.userJid || receipt.userPn); if (!n) continue;
      const h = H.find(x => x.msgId === key.id);
      if (h) { h.viewers ??= []; if (h.viewers.includes(n)) continue; h.viewers.push(n); }
      const o = c[n] ??= { name: '', src: 'viewer', added: Date.now(), v: 0, lastView: 0 };
      o.v++; o.lastView = Date.now(); o.out = false;
      V.log.push({ who: n, t: Date.now(), h: new Date(Date.now() + TZ * 36e5).getUTCHours(), post: h?.id });
    }
    if (V.log.length > 8000) V.log = V.log.slice(-8000);
    save(uid, 'views', V); save(uid, 'contacts', c); save(uid, 'history', H);
  });
}
export async function unlink(uid) {
  gen[uid] = (gen[uid] || 0) + 1;
  try { await socks[uid]?.logout(); } catch {} try { socks[uid]?.end?.(undefined); } catch {}
  wipe(uid); delete socks[uid]; up[uid] = false;
}
export function dropUser(uid) {
  flush(); for (const k of Object.keys(C)) if (k.startsWith(uid + '/')) delete C[k];
  if (fs.existsSync(`${DATA}/${uid}`)) fs.renameSync(`${DATA}/${uid}`, `${DATA}/deleted/${uid}_${Date.now()}`);
}

// ---------- groups & links ----------
const syncing = new Set();
export function scheduleGroupSync(uid, delay = 20000, attempt = 0) {   // retries with back-off; failures are logged, never silent
  if (syncing.has(uid)) return;
  const pf = prof(uid);
  if (attempt === 0 && pf.groupsSyncedAt && Date.now() - pf.groupsSyncedAt < 24 * 36e5) return;
  syncing.add(uid);
  const t = setTimeout(async () => {
    try {
      if (!up[uid]) throw new Error('WhatsApp not connected');
      const n = await refreshGroups(uid), p = prof(uid); p.groupsSyncedAt = Date.now(); save(uid, 'profile', p);
      logHealth(uid, 'groups synced', `${n} groups`); syncing.delete(uid);
    } catch (e) {
      syncing.delete(uid); logHealth(uid, 'groups sync failed', e?.message);
      if (attempt < 3) scheduleGroupSync(uid, [120e3, 600e3, 1800e3][attempt], attempt + 1);
    }
  }, delay); t.unref?.();
}
export async function refreshGroups(uid) {
  const sock = socks[uid]; if (!sock?.user) throw new Error('WhatsApp is not connected');
  const g = await sock.groupFetchAllParticipating(), G = load(uid, 'groups', {}), C = load(uid, 'contacts', {});
  const me = new Set([sock.user.id, sock.user.lid].filter(Boolean).map(i => i.split(':')[0].split('@')[0]));
  const isMe = p => [p.id, p.phoneNumber, p.lid].filter(Boolean).some(i => me.has(i.split(':')[0].split('@')[0]));
  Object.values(C).forEach(x => { x.gc = 0; });
  for (const id of Object.keys(G)) if (!g[id]) delete G[id];       // groups you left
  for (const x of Object.values(g)) {
    const nums = await addC(uid, sock, x.participants, 'group', true);
    new Set(nums).forEach(n => { if (C[n]) C[n].gc = (C[n].gc || 0) + 1; });   // each person counted once per group
    const o = G[x.id] ??= {}; o.subject = x.subject || ''; o.size = x.participants.length;
    o.role = x.participants.find(isMe)?.admin ? 'admin' : 'member'; o.community = !!(x.isCommunity || x.linkedParent);
    if (x.creation) o.created = x.creation * 1000;
    if (!o.link) { try { const code = await sock.groupInviteCode(x.id); if (code) o.link = 'https://chat.whatsapp.com/' + code; } catch {} await sleep(250); }
  }
  save(uid, 'groups', G); save(uid, 'contacts', C);
  await cleanContacts(uid).catch(() => {});
  return Object.keys(G).length;
}
// merge duplicates (e.g. the same person stored as a LID id and as a phone number) and drop invalid entries
export async function cleanContacts(uid) {
  const sock = socks[uid], C = load(uid, 'contacts', {}), rank = { phonebook: 3, chat: 2, viewer: 1, group: 0 }, map = {}; let merged = 0, removed = 0, i = 0;
  for (const k of Object.keys(C)) {
    if (++i % 400 === 0) await sleep(0);
    let nk = k.replace(/\D/g, '');
    if (sock?.user) nk = (await toPhone(sock, nk + '@s.whatsapp.net')) || nk;
    if (!/^\d{7,15}$/.test(nk)) { delete C[k]; removed++; continue; }
    if (nk === k) continue;
    map[k] = nk; const a = C[k], b = C[nk]; delete C[k];
    if (!b) { C[nk] = a; continue; }
    b.v = (b.v || 0) + (a.v || 0); b.lastView = Math.max(b.lastView || 0, a.lastView || 0); b.lastMsg = Math.max(b.lastMsg || 0, a.lastMsg || 0);
    b.added = Math.min(b.added || Date.now(), a.added || Date.now()); b.name ||= a.name; b.g = b.g || a.g; b.gc = Math.max(b.gc || 0, a.gc || 0);
    if ((rank[a.src] ?? 0) > (rank[b.src] ?? 0)) b.src = a.src; b.out = !!(b.out && a.out); merged++;
  }
  const L = load(uid, 'lists', {}); for (const n of Object.keys(L)) L[n] = [...new Set(L[n].map(x => map[x] || x))];
  save(uid, 'exclude', [...new Set(load(uid, 'exclude', []).map(x => map[x] || x))]);
  save(uid, 'contacts', C); save(uid, 'lists', L); return { merged, removed };
}
export async function checkLinks(uid) {
  const sock = socks[uid];
  if (!sock?.user) throw new Error('WhatsApp is not connected');
  const G = load(uid, 'groups', {}), L = load(uid, 'links_seen', {}), D = load(uid, 'dead_links', {});
  let moved = 0;
  const dead = e => /gone|revoked|not-found|invalid|expired|bad-request/i.test(String(e?.message)) || [400, 404, 410].includes(e?.output?.statusCode);
  const archive = (code, url, source, groupName = '') => {
    if (!D[code]) {
      D[code] = { url, source, groupName, detectedAt: Date.now() };
      moved++;
    } else if (groupName && !D[code].groupName) D[code].groupName = groupName;
  };
  for (const [id, group] of Object.entries(G)) if (group.link) {
    const code = group.link.split('/').pop();
    try { await sock.groupGetInviteInfo(code); }
    catch (e) {
      if (dead(e)) { archive(code, group.link, 'group', group.subject || id); delete group.link; }
    }
    await sleep(600);
  }
  for (const code of Object.keys(L)) {
    try { await sock.groupGetInviteInfo(code); }
    catch (e) {
      if (dead(e)) { archive(code, L[code].url || `https://chat.whatsapp.com/${code}`, 'seen'); delete L[code]; }
    }
    await sleep(600);
  }
  save(uid, 'groups', G); save(uid, 'links_seen', L); save(uid, 'dead_links', D);
  return moved;
}

// ---------- audience & tags ----------
async function exclusionNumbers(uid, sock, p) {
  const lists = load(uid, 'lists', {});
  const excluded = new Set([
    ...load(uid, 'exclude', []),
    ...(p.exclude || []),
    ...(p.excludeLists || []).flatMap(name => lists[name] || [])
  ]);
  for (const groupId of p.excludeGroups || []) {
    const metadata = await sock.groupMetadata(groupId);
    const members = await Promise.all(metadata.participants.map(x => toPhone(sock, x.phoneNumber || x.id)));
    members.filter(Boolean).forEach(n => excluded.add(n));
  }
  return excluded;
}
async function buildAudience(uid, p) {
  const sock = socks[uid], c = load(uid, 'contacts', {}), ex = await exclusionNumbers(uid, sock, p), lists = load(uid, 'lists', {}), a = p.aud || 'all';
  let pool = Object.keys(c);
  if (a === 'personal') pool = pool.filter(n => c[n].src !== 'group'); else if (a === 'groups') pool = pool.filter(n => c[n].g); else if (a.startsWith('list:')) pool = lists[a.slice(5)] || [];
  pool = [...new Set(pool)].filter(n => !ex.has(n) && !c[n]?.out);
  const act = n => Math.max(c[n]?.lastView || 0, c[n]?.lastMsg || 0), cap = CFG.maxAud;
  pool.sort((x, y) => act(y) - act(x));                              // most active people first
  if (pool.length > cap) {                                           // too many: send to an accommodating amount
    const rot = Math.floor(cap * 0.25), top = pool.slice(0, cap - rot), set = new Set(top);
    const rest = pool.filter(n => !set.has(n)).sort((x, y) => (c[x]?.lastSent || 0) - (c[y]?.lastSent || 0)).slice(0, rot); // 25% rotates so everyone is reached over time
    pool = [...top, ...rest];
  }
  return pool.map(n => n + '@s.whatsapp.net');
}
async function pickTags(uid, sock, p) {
  const c = load(uid, 'contacts', {}), th = load(uid, 'tags', {}), pf = prof(uid), me = sock.user.id.split(':')[0];
  let pool = Object.keys(c);
  if (p.tag?.group) {
    const md = await sock.groupMetadata(p.tag.group);
    pool = (await Promise.all(md.participants.map(x => toPhone(sock, x.phoneNumber || x.id)))).filter(Boolean);
  } else if (p.tag?.list) pool = load(uid, 'lists', {})[p.tag.list] || [];
  else if (Array.isArray(p.tag?.numbers)) pool = p.tag.numbers;
  const ex = await exclusionNumbers(uid, sock, p);
  pool = pool.filter(n => n !== me && !ex.has(n) && !c[n]?.out).sort(() => Math.random() - 0.5);
  if (pf.tagMode === 'new') pool.sort((a, b) => (th[a] || 0) - (th[b] || 0));
  if (pf.tagMode === 'viewed') pool.sort((a, b) => (c[b]?.v || 0) - (c[a]?.v || 0));
  const pick = pool.slice(0, pf.tagN); pick.forEach(n => th[n] = Date.now()); save(uid, 'tags', th); return pick;
}

// ---------- posting (adaptive batches: fast first, shrink on timeout) ----------
const jobs = {};                                                   // uid -> Map(postId -> live job)
export const activeJobs = uid => [...(jobs[String(uid)]?.values() || [])];
export const allJobs = () => Object.entries(jobs).flatMap(([uid, m]) => [...m.values()].map(j => ({ ...j, uid })));
export function cancelJobs(uid, id) { let n = 0; for (const j of jobs[String(uid)]?.values() || []) if (id === undefined || String(j.id) === String(id)) { j.cancel = true; n++; } return n; }
export function waMe(uid) {                                         // WhatsApp number + name of the linked account
  try { const me = socks[uid]?.user || JSON.parse(fs.readFileSync(`${DATA}/${uid}/auth/creds.json`)).me; return me ? { number: String(me.id).split(':')[0].split('@')[0], name: me.name || me.verifiedName || '' } : null; } catch { return null; }
}
export async function runPost(uid, p, prog = () => {}) {
  const sock = socks[uid], pf = prof(uid), adm = isAdmin(uid);
  if (!sock?.user || !up[uid]) throw new Error('WhatsApp is not connected');
  if (!adm) {
    if (pf.paused) throw new Error('Your account is paused by the admin');
    if (expired(pf)) throw new Error('Your plan has expired');
    const day = dayKey(); if (pf.sent.day !== day) pf.sent = { day, n: 0 };
    if (pf.sent.n >= pf.limit) throw new Error(`Daily post limit (${pf.limit}) reached`);
  }
  const sg = checkSpam(uid, p); if (!sg.ok) throw new Error(`Blocked by the spam guard: ${sg.reason}`);
  pf.sent.n++; pf.total++; save(uid, 'profile', pf);
  let job;
  try {
    const me = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const audience = await buildAudience(uid, p);
    const tags = p.tag ? await pickTags(uid, sock, p) : [];
    const all = [...new Set([me, ...audience, ...tags.map(n => n + '@s.whatsapp.net')])];
    let content;
    if (p.type === 'text') content = { text: p.text || '' };
    else {
      const buf = fs.readFileSync(p.file);
      content = p.type === 'image' ? { image: buf, caption: p.caption || '' }
        : p.type === 'video' ? { video: buf, caption: p.caption || '' }
        : { audio: buf, mimetype: /\.ogg$/.test(p.file) ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: true };
    }
    job = { id: p.id || Date.now(), type: p.type, preview: (p.text || p.caption || p.type).slice(0, 40), started: Date.now(), total: all.length - 1, sent: 0, cancel: false };
    (jobs[String(uid)] ||= new Map()).set(job.id, job);
    prog(0, all.length);
    let msg = null, msgId = null;
    try {
      msg = await generateWAMessage('status@broadcast', content, { logger: pino({ level: 'silent' }), userJid: sock.user.id, upload: sock.waUploadToServer, backgroundColor: p.bg, font: p.font });
      const e = msg.message?.extendedTextMessage; if (e && p.tc) e.textArgb = argb(p.tc);
      msgId = msg.key.id; sentMsgs.set(msgId, msg.message); if (sentMsgs.size > 300) sentMsgs.delete(sentMsgs.keys().next().value);
    } catch { msg = null; }
    const relay = async chunk => {
      if (msg) return sock.relayMessage('status@broadcast', msg.message, { messageId: msg.key.id, statusJidList: chunk });
      const r = await sock.sendMessage('status@broadcast', content, { backgroundColor: p.bg, font: p.font, statusJidList: chunk, ...(msgId ? { messageId: msgId } : {}) }); msgId ??= r?.key?.id;
    };
    let i = 0, bs = Math.min(40, CFG.batch), errs = 0, lastErr = '', failed = 0; const done = [];
    while (i < all.length && !job.cancel) {
      const chunk = all.slice(i, i + bs);
      try { await relay(chunk); done.push(...chunk); i += chunk.length; errs = 0; job.sent = Math.max(0, done.length - 1); bs = Math.min(CFG.batch, Math.ceil(bs * 1.6)); }
      catch (e) {
        lastErr = e?.message || String(e);
        if (bs > 25) bs = Math.max(25, Math.floor(bs / 2));            // slow? send smaller groups
        else if (++errs >= 3) { if (!done.length) throw new Error(lastErr || 'Could not reach WhatsApp'); failed += chunk.length; i += chunk.length; errs = 0; }
        await sleep(2500); continue;
      }
      prog(done.length, all.length);
      if (i < all.length) for (let w = rnd(3000, 8000); w > 0 && !job.cancel; w -= 500) await sleep(500);
    }
    const c = load(uid, 'contacts', {}); done.forEach(j => { const n = j.split('@')[0]; if (c[n]) c[n].lastSent = Date.now(); }); save(uid, 'contacts', c);
    // Baileys' supported status API targets viewers via statusJidList but has no native
    // Status-mention send operation. Keep this private notification; never alter the post text.
    let tagNotified = 0;
    for (const n of tags) {
      try {
        await sock.sendMessage(`${n}@s.whatsapp.net`, { text: 'You were tagged in a WhatsApp status.' });
        tagNotified++;
      } catch {}
    }
    try { if (msgId) { const sd = `${udir(uid)}/sent`; fs.mkdirSync(sd, { recursive: true }); fs.writeFileSync(`${sd}/${msgId}.json`, JSON.stringify(done.map(j => j.split('@')[0]))); } } catch {}   // recipient list, kept 2 days, so the post can be deleted
    const H = load(uid, 'history', []);
    H.push({ id: p.id || Date.now(), msgId, type: p.type, preview: (p.text || p.caption || p.type).slice(0, 40), at: Date.now(), n: done.length, viewers: [] });
    save(uid, 'history', H.slice(-300));
    { const tx = `${p.text || ''} ${p.caption || ''}`.trim(); if (tx.length > 20) { const p2 = prof(uid); p2.spamLog = [...(p2.spamLog || []).filter(x => Date.now() - x.t < DAY), { h: hashText(tx), t: Date.now() }]; save(uid, 'profile', p2); } }
    return { count: Math.max(0, done.length - 1), total: all.length - 1, failed, tagNotified, cancelled: job.cancel, left: Math.max(0, all.length - i) };
  } catch (e) { pf.sent.n--; pf.total--; save(uid, 'profile', pf); throw e; }
  finally { if (job) jobs[String(uid)]?.delete(job.id); }
}

export function nextAt(p) {
  let t = p.at;
  const step = () => {
    if (p.repeat === 'monthly') { const d = new Date(t + TZ * 36e5), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(p.dom || d.getUTCDate(), dim), d.getUTCHours(), d.getUTCMinutes()) - TZ * 36e5; }
    if (p.repeat === 'hourly') return t + 36e5; if (p.repeat === 'daily') return t + DAY; if (p.repeat === 'weekly') return t + 7 * DAY;
    if (p.repeat === 'days' && p.days?.length) for (let i = 1; i <= 7; i++) { const x = t + i * DAY; if (p.days.includes(new Date(x + TZ * 36e5).getUTCDay())) return x; }
    return null;
  };
  let n = step(); while (n && n <= Date.now()) { t = n; n = step(); } return n;
}

export function dueScheduledPosts(posts, now = Date.now()) {
  return posts.filter(p => p.status === 'scheduled' && (p.retryAt ?? p.at) <= now);
}

export async function deleteSentPost(uid, histId, prog = () => {}) {   // removes one status from everyone who received it (statuses last 24 h)
  const sock = socks[uid]; if (!sock?.user || !up[uid]) throw new Error('WhatsApp is not connected');
  const H = load(uid, 'history', []), h = H.find(x => String(x.id) === String(histId));
  if (!h || !h.msgId) throw new Error('That post is not available.');
  if (h.deleted) throw new Error('That post was already deleted.');
  if (Date.now() - h.at > 25 * 36e5) throw new Error('Statuses disappear after 24 hours, so this one can no longer be deleted.');
  let nums; try { nums = JSON.parse(fs.readFileSync(`${udir(uid)}/sent/${h.msgId}.json`)); } catch { throw new Error('The recipient list for that post was not saved.'); }
  const jids = nums.map(n => n + '@s.whatsapp.net'), key = { remoteJid: 'status@broadcast', fromMe: true, id: h.msgId };
  let i = 0, bs = Math.min(100, CFG.batch), errs = 0, ok = 0;
  while (i < jids.length) {
    const chunk = jids.slice(i, i + bs);
    try { await sock.sendMessage('status@broadcast', { delete: key }, { statusJidList: chunk }); ok += chunk.length; i += chunk.length; errs = 0; bs = Math.min(CFG.batch, Math.ceil(bs * 1.5)); prog(ok, jids.length); }
    catch (e) { if (bs > 25) bs = Math.max(25, Math.floor(bs / 2)); else if (++errs >= 3) { if (!ok) throw new Error(e?.message || 'Could not reach WhatsApp'); i += chunk.length; errs = 0; } await sleep(2500); continue; }
    if (i < jids.length) await sleep(rnd(1500, 4000));
  }
  h.deleted = true; h.deletedAt = Date.now(); save(uid, 'history', H);
  return { count: ok, total: jids.length };
}
const GRACE = 5 * 60e3, lastKick = {};
function kick(uid) {                                               // reconnect immediately instead of waiting for the backoff timer
  if (up[uid] || !linked(uid) || Date.now() - (lastKick[uid] || 0) < 15000) return;
  lastKick[uid] = Date.now(); connect(uid, 'resume').catch(() => {});
}
function skipMissed(uid, post) {                                   // too late: a "good night" post must never go out in the morning
  const late = Math.round((Date.now() - post.at) / 60000), when = fmt(post.at);
  const next = post.repeat && post.repeat !== 'none' ? nextAt(post) : null;
  if (next) { post.at = next; post.status = 'scheduled'; } else post.status = 'missed';
  delete post.retryAt; delete post.lastScheduleError; delete post.notifiedDown;
  hooks.note(uid, `⏭ The post scheduled for ${when} was NOT sent. It could not go out within 5 minutes (${late} min late).${next ? ` Next repeat: ${fmt(next)}.` : ''}`, true);
}
async function dispatchScheduledPosts() {
  for (const uid of users()) {
    const posts = load(uid, 'posts', []); let changed = false;
    for (const p of posts) if (p.status === 'scheduled' && Date.now() - p.at > GRACE) { skipMissed(uid, p); changed = true; }
    if (changed) save(uid, 'posts', posts);
    if (schedulerBusy.size >= 2 || schedulerBusy.has(uid)) continue;
    const post = dueScheduledPosts(posts)[0];
    if (!post) continue;
    if (!up[uid]) {                                                // disconnected at send time: reconnect now, retry in 15 s
      kick(uid); post.retryAt = Date.now() + 15000;
      if (!post.notifiedDown) { post.notifiedDown = true; hooks.note(uid, `🔌 WhatsApp is disconnected. Reconnecting now to send your ${fmt(post.at)} post. I will keep trying for 5 minutes, then cancel it.`, true); }
      save(uid, 'posts', posts); continue;
    }
    schedulerBusy.add(uid);
    post.status = 'sending'; delete post.retryAt;
    save(uid, 'posts', posts);
    void sendScheduledPost(uid, posts, post);
  }
}

async function sendScheduledPost(uid, posts, post) {
  try {
    const result = await runPost(uid, post);
    delete post.notifiedDown; delete post.retryAt; delete post.lastScheduleError;
    if (post.repeat && post.repeat !== 'none') { const next = nextAt(post); if (next) { post.at = next; post.status = 'scheduled'; } else post.status = 'sent'; }
    else post.status = result.cancelled ? 'cancelled' : 'sent';
    save(uid, 'posts', posts);
    void Promise.resolve(hooks.note(uid, result.cancelled ? `🛑 Your scheduled post was stopped. ${result.count} people had already received it.` : `✅ Your scheduled WhatsApp status was posted${result.failed ? ` (${result.failed} recipients skipped)` : ''}.`, true)).catch(() => {});
  } catch (error) {
    const message = error?.message || 'Could not send the scheduled post.';
    if (/paused|expired|limit|spam guard/i.test(message)) {                   // retrying cannot help: skip this run
      const next = post.repeat && post.repeat !== 'none' ? nextAt(post) : null;
      if (next) { post.at = next; post.status = 'scheduled'; } else post.status = 'failed';
      delete post.retryAt;
      void Promise.resolve(hooks.note(uid, `⚠️ A scheduled post was not sent: ${message}.${next ? ` Next repeat: ${fmt(next)}.` : ''}`, true)).catch(() => {});
    } else {
      post.status = 'scheduled'; post.retryAt = Date.now() + 20e3;   // quick retry, the 5-minute rule above ends it
      kick(uid);
      if (post.lastScheduleError !== message) { post.lastScheduleError = message; void Promise.resolve(hooks.note(uid, `⚠️ Your scheduled post hit a problem and is retrying (up to 5 minutes after its time). Reason: ${message}`, true)).catch(() => {}); }
    }
    save(uid, 'posts', posts);
  } finally {
    schedulerBusy.delete(uid);
  }
}

export function startScheduler(intervalMs = 5000) {
  if (schedulerTimer) return;

  // Recover a post interrupted by a process restart; wait briefly before retrying it.
  for (const uid of users()) {
    const posts = load(uid, 'posts', []);
    let changed = false;
    for (const post of posts) if (post.status === 'sending') {
      post.status = 'scheduled';
      post.retryAt = Date.now() + 60 * 1000;
      changed = true;
    }
    if (changed) save(uid, 'posts', posts);
  }

  schedulerTimer = setInterval(() => {
    dispatchScheduledPosts().catch(error => console.error('Scheduled-post dispatcher failed:', error?.message || error));
  }, intervalMs);
  schedulerTimer.unref?.();
  dispatchScheduledPosts().catch(error => console.error('Scheduled-post dispatcher failed:', error?.message || error));
}

// ---------- stats ----------
export function bestHours(uid) {
  const hs = {}; load(uid, 'views', { log: [] }).log.forEach(x => hs[x.h] = (hs[x.h] || 0) + 1);
  return Object.entries(hs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => hr(+h)).join(', ') || 'not enough data yet';
}
export function report(uid, days = 7) {
  const V = load(uid, 'views', { log: [] }), H = load(uid, 'history', []), c = load(uid, 'contacts', {}), since = Date.now() - days * DAY;
  const log = V.log.filter(x => x.t >= since), by = {}; log.forEach(x => by[x.who] = (by[x.who] || 0) + 1);
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([n, k]) => `• +${n}${c[n]?.name ? ` (${esc(c[n].name)})` : ''} — ${k} view${k === 1 ? '' : 's'}`)
    .join('\n') || 'No views recorded yet.';
  const posts = H.filter(x => x.at >= since);
  const bestPosts = [...posts].sort((a, b) => (b.viewers?.length || 0) - (a.viewers?.length || 0)).slice(0, 3)
    .map(x => { const views = x.viewers?.length || 0; return `• ${esc(x.preview || x.type || 'Status')} — ${views} view${views === 1 ? '' : 's'}`; })
    .join('\n') || 'No posts in this period.';
  const unique = Object.keys(by).length;
  return [
    `📊 <b>${days}-day report</b>`,
    '',
    `👁 <b>Views:</b> ${log.length}`,
    `👥 <b>Unique viewers:</b> ${unique}`,
    `📤 <b>Posts:</b> ${posts.length}`,
    '',
    '<b>Top viewers</b>',
    top,
    '',
    '<b>Best posts</b>',
    bestPosts,
    '',
    `⏰ <b>Best hours:</b> ${esc(bestHours(uid))}`
  ].join('\n');
}

// ---- session repair + single-instance lock (added on top of your version) ----
export function repair(uid) {                                    // clears stale Signal sessions, keeps the login (creds)
  const d = `${DATA}/${uid}/auth`; let n = 0;
  try { for (const f of fs.readdirSync(d)) if (/^(session|sender-key|sender-key-memory)-/.test(f)) { fs.rmSync(`${d}/${f}`); n++; } } catch {}
  return n;
}
export async function repairSession(uid) {
  logHealth(uid, 'repair', 'stale sessions cleared');
  gen[uid] = (gen[uid] || 0) + 1; try { socks[uid]?.end?.(undefined); } catch {} up[uid] = false;
  const n = repair(uid); await sleep(1000); connect(uid, 'resume').catch(() => {}); return n;
}
export function lockOrExit() {                                   // two copies on one session cause Bad MAC and logouts
  const f = `${DATA}/.lock`;
  try {
    const old = Number(fs.readFileSync(f, 'utf8')), fresh = Date.now() - fs.statSync(f).mtimeMs < 20000; let alive = false;
    try { process.kill(old, 0); alive = true; } catch {}
    if (old && old !== process.pid && fresh && alive) { console.error('Another instance is already running on this data folder. Exiting to protect the WhatsApp session.'); process.exit(1); }
  } catch {}
  fs.writeFileSync(f, String(process.pid));
  setInterval(() => { try { fs.writeFileSync(f, String(process.pid)); } catch {} }, 5000).unref();
}

// ---- inactivity (status views only), backup and maintenance jobs ----
export function inactiveReport(uid) {
  const now = Date.now(), cut = now - 183 * DAY, pf = prof(uid), H = load(uid, 'history', []), C = load(uid, 'contacts', {});
  const tracked = Math.floor((now - (pf.created || now)) / DAY), posts = H.filter(x => x.at >= cut).length;
  if (tracked < 183 || posts < 10) return { ok: false, tracked, posts, list: [] };      // not enough data to judge fairly
  return { ok: true, tracked, posts, list: Object.entries(C).filter(([, x]) => !x.out && (x.added || now) < cut && (x.lastView || 0) < cut).map(([n]) => n) };
}
export const inactive = uid => inactiveReport(uid).list;
export function prune(uid) { const r = inactiveReport(uid), C = load(uid, 'contacts', {}); r.list.forEach(n => { C[n].out = true; }); save(uid, 'contacts', C); return r.list.length; }
export function makeBackup() {                                    // sessions only, ONE file
  flush();
  const dirs = users().filter(u => fs.existsSync(`${DATA}/${u}/auth`)).map(u => `${u}/auth`);
  if (!dirs.length) return null;
  execSync(`tar -czf ${DATA}/.b.tmp -C ${DATA} ${dirs.join(' ')}`); fs.renameSync(`${DATA}/.b.tmp`, `${DATA}/sessions-backup.tgz`);
  return `${DATA}/sessions-backup.tgz`;
}
const ran = {}; let maintTimer;
function maintenance() {
  const loc = new Date(Date.now() + TZ * 36e5), h = loc.getUTCHours(), m = loc.getUTCMinutes(), dk = dayKey();
  for (const uid of users()) {
    const pf = prof(uid);
    if (pf.expires && pf.expires > Date.now() && !isAdmin(uid)) {      // plan-ending reminders (days set in Settings, default 3 and 1)
      const rd = String(CFG.remindDays ?? '3,1').split(',').map(x => +x.trim()).filter(x => x > 0);
      if (pf.remindFor !== pf.expires) { pf.remindFor = pf.expires; pf.reminded = []; }
      const left = (pf.expires - Date.now()) / DAY, due = rd.filter(d => left <= d && !(pf.reminded || []).includes(d));
      if (due.length) {
        pf.reminded = [...(pf.reminded || []), ...due]; save(uid, 'profile', pf);
        hooks.note(uid, `⏰ <b>Your plan ends ${left < 1 ? 'in less than 24 hours' : `in ${Math.ceil(left)} day${Math.ceil(left) === 1 ? '' : 's'}`}</b> (${fmt(pf.expires)}).\nOpen 💳 Plan → 🛒 Choose a plan to renew and keep posting.`, true);
      }
    }
    if (up[uid]) scheduleGroupSync(uid, rnd(5e3, 6e5));
    if (up[uid]) reachTick(uid).catch(() => {});              // daily refresh, spread out so users never sync at once
    if (pf.expires && Date.now() > pf.expires && !pf.expNotified && !isAdmin(uid)) { pf.expNotified = true; save(uid, 'profile', pf); hooks.expired(uid); }
    if (loc.getUTCDay() === 1 && h === 9 && pf.weekly && pf.lastReport !== dk && linked(uid)) { pf.lastReport = dk; save(uid, 'profile', pf); hooks.report(uid, report(uid)); }
    if (h === 4 && m < 2 && pf.autoPrune && ran[uid + 'p'] !== dk) { ran[uid + 'p'] = dk; const n = prune(uid); if (n) hooks.note(uid, `🧹 Auto-removed ${n} contacts with no status views in 6 months.`); }
  }
  if (h === 5 && m < 2 && ran.sc !== dk) {                          // delete saved recipient lists older than 2 days
    ran.sc = dk;
    for (const uid of users()) { const d = `${DATA}/${uid}/sent`; try { for (const f of fs.readdirSync(d)) if (Date.now() - fs.statSync(`${d}/${f}`).mtimeMs > 2 * DAY) fs.rmSync(`${d}/${f}`); } catch {} }
  }
  if (h === 3 && m < 2 && ran.bk !== dk) { ran.bk = dk; try { const f = makeBackup(); if (f) hooks.backup(f); } catch {} }
}
if (!maintTimer) { maintTimer = setInterval(() => { try { maintenance(); } catch (e) { console.error('maintenance', e?.message); } }, 60000); maintTimer.unref?.(); }

// ================= activity log =================
export function logActivity(actor, action, target = '', detail = '') {
  const L = load('_g', 'activity', []); L.push({ t: Date.now(), actor: String(actor), action, target: String(target), detail: String(detail).slice(0, 120) });
  if (L.length > 1000) L.splice(0, L.length - 1000); save('_g', 'activity', L);
}
export const activityLog = (n = 60) => load('_g', 'activity', []).slice(-n).reverse();

// ================= spam guard =================
const hashText = s => { let h = 0; for (const ch of s.toLowerCase().replace(/\s+/g, ' ')) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
const LINK_RE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ng|me|co|app|link|xyz|info|biz)\b\S*)/gi;
export function checkSpam(uid, p) {                                 // what is INSIDE a post (limits already cap how many)
  if (CFG.spamGuard === false || isAdmin(uid)) return { ok: true };
  const text = `${p.text || ''} ${p.caption || ''}`.trim(), low = text.toLowerCase();
  const links = (text.match(LINK_RE) || []).length, max = Number(CFG.spamMaxLinks ?? 3);
  if (links > max) return { ok: false, reason: `has too many links (${links}; the limit is ${max})` };
  const bad = String(CFG.spamWords || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).find(w => low.includes(w));
  if (bad) return { ok: false, reason: `contains a blocked word (“${bad}”)` };
  if (text.length > 20) { const h = hashText(text); if ((prof(uid).spamLog || []).filter(x => x.h === h && Date.now() - x.t < DAY).length >= 3) return { ok: false, reason: 'is the same text already posted 3 times in the last 24 hours' }; }
  return { ok: true };
}

// ================= plans: grant + referral reward =================
export function rewardReferrer(uid) {
  const p = prof(uid); if (!p.referredBy || p.refRewarded) return;
  const rd = Number(CFG.refDays ?? 7), ref = String(p.referredBy); if (!(rd > 0) || !users().includes(ref)) return;
  p.refRewarded = true; save(uid, 'profile', p);
  const rp = prof(ref); rp.refPaid = (rp.refPaid || 0) + 1; rp.refDaysEarned = (rp.refDaysEarned || 0) + rd;
  if (rp.expires || CFG.require) { rp.expires = Math.max(Date.now(), rp.expires || 0) + rd * DAY; rp.expNotified = false; }
  save(ref, 'profile', rp); hooks.note(ref, `🎁 Your friend just paid — ${rd} free days were added to your plan!`, true);
}
export function grantPlan(uid, { days, planName, source = 'manual' }) {
  const p = prof(uid); p.expires = Math.max(Date.now(), p.expires || 0) + days * DAY; p.expNotified = false;
  if (planName) p.plan = planName; delete p.pendingPlan; save(uid, 'profile', p);
  rewardReferrer(uid); logActivity('system', 'plan-granted', uid, `${planName || ''} ${days}d via ${source}`);
  return p.expires;
}

// ================= automatic online payments (checked by polling — no public webhook needed) =================
const payKey = () => CFG.paySecret || E.PAY_SECRET_KEY || '';
export const payProvider = () => String(CFG.payProvider ?? E.PAY_PROVIDER ?? '').toLowerCase();
export const onlinePayOn = () => ['paystack', 'flutterwave'].includes(payProvider()) && !!payKey();
export function parsePrice(price) {                                 // "₦5,000" -> { amount: 5000, currency: 'NGN' }
  const s = String(price || '').trim(), m = s.match(/(\d[\d,]*(?:\.\d+)?)/); if (!m) return null;
  const amount = Number(m[1].replace(/,/g, '')); if (!(amount > 0)) return null;
  const sym = [['GH₵', 'GHS'], ['₵', 'GHS'], ['KSh', 'KES'], ['₦', 'NGN'], ['$', 'USD'], ['£', 'GBP'], ['€', 'EUR']].find(([x]) => s.includes(x));
  const code = /\b(NGN|USD|GHS|KES|ZAR|GBP|EUR)\b/i.exec(s)?.[1]?.toUpperCase();
  return { amount, currency: sym?.[1] || code || String(CFG.payCurrency || E.PAY_CURRENCY || 'NGN').toUpperCase() };
}
const apiJson = async (url, opt = {}) => { const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(20000) }); try { return await r.json(); } catch { return {}; } };
const auth = () => ({ Authorization: `Bearer ${payKey()}`, 'Content-Type': 'application/json' });
const PAY = {
  paystack: {
    async init({ email, amount, currency, ref }) {
      const j = await apiJson('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: auth(), body: JSON.stringify({ email, amount: Math.round(amount * 100), currency, reference: ref }) });
      if (!j.status || !j.data?.authorization_url) throw new Error(j.message || 'Paystack could not start the payment');
      return j.data.authorization_url;
    },
    async verify(ref) {
      const j = await apiJson(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, { headers: auth() }), d = j.data;
      if (!j.status || !d) return { state: 'pending' };
      if (d.status === 'success') return { state: 'paid', amount: d.amount / 100, currency: d.currency };
      return { state: ['failed', 'reversed'].includes(d.status) ? 'failed' : 'pending' };   // "abandoned" just means not paid yet
    }
  },
  flutterwave: {
    async init({ email, amount, currency, ref, name }) {
      const j = await apiJson('https://api.flutterwave.com/v3/payments', { method: 'POST', headers: auth(), body: JSON.stringify({ tx_ref: ref, amount, currency, redirect_url: 'https://t.me/', customer: { email, name }, customizations: { title: 'Plan payment' } }) });
      if (j.status !== 'success' || !j.data?.link) throw new Error(j.message || 'Flutterwave could not start the payment');
      return j.data.link;
    },
    async verify(ref) {
      const j = await apiJson(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref)}`, { headers: auth() }), d = j.data;
      if (j.status !== 'success' || !d) return { state: 'pending' };
      if (d.status === 'successful') return { state: 'paid', amount: Number(d.amount), currency: d.currency };
      return { state: d.status === 'failed' ? 'failed' : 'pending' };
    }
  }
};
export async function startOnlinePayment(uid, plan, email) {
  const parsed = parsePrice(plan.price); if (!parsed) throw new Error('This plan price has no readable number (for example ₦5,000).');
  const prov = payProvider(), ref = `wp${uid}x${Date.now().toString(36)}`;
  const url = await PAY[prov].init({ email, amount: parsed.amount, currency: parsed.currency, ref, name: prof(uid).name || String(uid) });
  const L = load('_g', 'online_payments', []);
  L.push({ ref, uid: String(uid), planId: plan.id, planName: plan.name, days: plan.days, amount: parsed.amount, currency: parsed.currency, provider: prov, status: 'pending', created: Date.now() });
  save('_g', 'online_payments', L.slice(-500)); return { url, ref, ...parsed };
}
let polling = false;
async function pollPayments() {
  if (polling || !onlinePayOn()) return; polling = true;
  try {
    const L = load('_g', 'online_payments', []); let ch = false;
    for (const p of L) {
      if (p.status !== 'pending') continue;
      const age = Date.now() - p.created;
      if (age > 3 * 36e5) { p.status = 'expired'; ch = true; continue; }
      if (Date.now() < (p.nextCheck || 0) || !PAY[p.provider]) continue;
      p.nextCheck = Date.now() + (age < 6e5 ? 20e3 : 120e3); ch = true;
      let r; try { r = await PAY[p.provider].verify(p.ref); } catch { continue; }
      if (r.state === 'paid') {
        if (r.amount + 1e-6 >= p.amount && String(r.currency || p.currency).toUpperCase() === p.currency) {
          p.status = 'paid'; p.paidAt = Date.now(); save('_g', 'online_payments', L);   // mark paid FIRST so it can never be granted twice
          const exp = grantPlan(p.uid, { days: p.days, planName: p.planName, source: p.provider });
          hooks.planActive?.(p.uid, `🎉 <b>Payment confirmed!</b>\n${p.planName ? p.planName + ' plan — ' : ''}${p.days} days added. Active until ${fmt(exp)}.`);
          hooks.adminNote?.(`💰 Auto-confirmed: user ${p.uid} · ${p.planName} · ${p.amount} ${p.currency} (${p.provider})`);
        } else { p.status = 'mismatch'; p.note = `got ${r.amount} ${r.currency}`; hooks.adminNote?.(`⚠️ Payment ${p.ref} for user ${p.uid} does not match (${r.amount} ${r.currency} vs ${p.amount} ${p.currency}). Nothing was granted.`); }
      } else if (r.state === 'failed') p.status = 'failed';
    }
    if (ch) save('_g', 'online_payments', L);
  } finally { polling = false; }
}
{ const payTimer = setInterval(() => { pollPayments().catch(() => {}); }, 20000); payTimer.unref?.(); }

// ================= reach-out: a few messages a day to saved contacts you haven't chatted with =================
export const REACH_DEFAULT = ['Hi {name} 👋 hope you are doing well! Just checking in — how have you been?', 'Hello {name}, wishing you a great week ahead 🌟 Do check my status for updates!'];
export function reachState(uid) { const pf = prof(uid); pf.reach ||= { on: false, perDay: 5, minDays: 60, msgs: [], day: '', n: 0, nextAt: 0, total: 0, replies: 0, errs: 0 }; return pf.reach; }
const reachEnabled = uid => isAdmin(uid) || (prof(uid).feat?.reach ?? load('_g', 'features', {}).reach ?? false);
const reachBusy = new Set();
async function reachTick(uid) {
  const pf = prof(uid), r = pf.reach;
  if (!r?.on || !up[uid] || reachBusy.has(uid) || !reachEnabled(uid) || pf.paused || (!isAdmin(uid) && expired(pf))) return;
  const h = new Date(Date.now() + TZ * 36e5).getUTCHours(), dk = dayKey();
  if (r.day !== dk) { r.day = dk; r.n = 0; }
  if (h < 9 || h >= 19 || r.n >= Math.min(r.perDay, Number(CFG.reachMax ?? 10)) || Date.now() < (r.nextAt || 0)) return;
  reachBusy.add(uid);
  try {
    const sock = socks[uid], C = load(uid, 'contacts', {}), now = Date.now();
    const all = Object.entries(C).filter(([n, c]) => c.src === 'phonebook' && !c.out && !c.optOut && /^\d{7,15}$/.test(n) && (c.lastMsg || 0) < now - r.minDays * DAY && (c.lastOut || 0) < now - 90 * DAY && (c.reachedAt || 0) < now - 90 * DAY);
    if (!all.length) { r.nextAt = now + 6 * 36e5; save(uid, 'profile', pf); return; }
    const never = all.filter(([, c]) => !(c.v > 0)), pool = never.length ? never : all, [n, c] = pool[Math.floor(Math.random() * pool.length)], jid = n + '@s.whatsapp.net';
    const tpl = r.msgs?.length ? r.msgs : REACH_DEFAULT;
    let text = tpl[Math.floor(Math.random() * tpl.length)].replace(/\{name\}/g, (c.name || '').split(/\s+/)[0] || 'there');
    try {
      await sock.sendPresenceUpdate('composing', jid); await sleep(rnd(2500, 6000)); await sock.sendMessage(jid, { text }); await sock.sendPresenceUpdate('paused', jid);
      c.reachedAt = now; c.lastOut = now; r.n++; r.total = (r.total || 0) + 1; r.errs = 0; r.nextAt = now + rnd(25, 70) * 60e3;
    } catch {
      c.reachedAt = now; r.errs = (r.errs || 0) + 1; r.nextAt = now + 10 * 60e3;
      if (r.errs >= 5) { r.on = false; hooks.note(uid, '📣 Reach-out was switched off after repeated send errors.', true); }
    }
    save(uid, 'contacts', C); save(uid, 'profile', pf);
  } finally { reachBusy.delete(uid); }
}

// ================= direct messages: numbers, saved lists, WhatsApp groups, channels =================
const pace = (a, b) => E.MSG_FAST === '1' ? 5 : rnd(a, b);                 // MSG_FAST is only used by automated tests
const msgCap = uid => Number(prof(uid).msgCap ?? CFG.msgDailyCap ?? 100);
const msgMax = () => Number(CFG.msgMaxRecipients ?? 200);
const msgDay = uid => { const p = prof(uid), d = dayKey(); if (p.msgSent?.day !== d) p.msgSent = { day: d, n: 0 }; return p.msgSent; };
export const msgUsage = uid => ({ n: msgDay(uid).n, cap: msgCap(uid), max: msgMax() });
export function resolveTargets(uid, t = {}) {
  const C = load(uid, 'contacts', {}), res = [];
  const addNum = n => { if (/^\d{7,15}$/.test(n) && !C[n]?.optOut) res.push({ jid: n + '@s.whatsapp.net', kind: 'user', num: n }); };   // people who asked to stop are never messaged
  if (t.kind === 'numbers') (t.numbers || []).forEach(addNum);
  else if (t.kind === 'list') (load(uid, 'lists', {})[t.name] || []).forEach(addNum);
  else if (t.kind === 'groups') { const G = load(uid, 'groups', {}); (t.ids || []).filter(id => G[id]).forEach(id => res.push({ jid: id, kind: 'group' })); }
  else if (t.kind === 'channels') { const H = load(uid, 'channels', {}); (t.ids || []).filter(id => H[id]).forEach(id => res.push({ jid: id, kind: 'channel' })); }
  const seen = new Set(); return res.filter(x => !seen.has(x.jid) && seen.add(x.jid));
}
export const targetCount = (uid, t) => resolveTargets(uid, t).length;
export async function addChannel(uid, link) {                           // channels you own or manage (experimental in Baileys)
  const sock = socks[uid]; if (!sock?.user || !up[uid]) throw new Error('WhatsApp is not connected');
  const code = (String(link).match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i) || [])[1]; if (!code) throw new Error('Send a channel link like https://whatsapp.com/channel/…');
  const md = await sock.newsletterMetadata('invite', code).catch(() => null); if (!md?.id) throw new Error('I could not open that channel. Check the link.');
  const role = String(md.viewer_metadata?.role || md.role || '').toUpperCase();
  if (role && !['OWNER', 'ADMIN'].includes(role)) throw new Error('You can only post to channels you own or manage.');
  const H = load(uid, 'channels', {}); H[md.id] = { name: md.name || md.thread_metadata?.name?.text || code, role, code }; save(uid, 'channels', H);
  return { jid: md.id, ...H[md.id] };
}
const napJob = async (ms, job) => { for (let w = ms; w > 0 && !job.cancel; w -= 500) await sleep(Math.min(500, w)); };
export async function runMessage(uid, m, prog = () => {}) {
  const sock = socks[uid], pf = prof(uid), adm = isAdmin(uid);
  if (!sock?.user || !up[uid]) throw new Error('WhatsApp is not connected');
  if (!adm) { if (pf.paused) throw new Error('Your account is paused by the admin'); if (expired(pf)) throw new Error('Your plan has expired'); }
  if (activeJobs(uid).some(j => j.type === 'message')) throw new Error('Another message is already being sent. Wait for it, or stop it in 📡 Sending now.');
  const sg = checkSpam(uid, m); if (!sg.ok) throw new Error(`Blocked by the spam guard: ${sg.reason}`);
  const targets = resolveTargets(uid, m.target);
  if (!targets.length) throw new Error('There is nobody to send this to.');
  if (!adm && targets.length > msgMax()) throw new Error(`Too many recipients (${targets.length}); the limit is ${msgMax()} per message.`);
  const day = msgDay(uid), cap = msgCap(uid);
  if (!adm && day.n + targets.length > cap) throw new Error(`Daily message limit: you can send ${Math.max(0, cap - day.n)} more today, and this needs ${targets.length}.`);
  const job = { id: m.id || Date.now(), type: 'message', preview: String((m.type === 'text' ? m.text : m.caption) || m.type).replace(/\s+/g, ' ').slice(0, 40), started: Date.now(), total: targets.length, sent: 0, cancel: false };
  (jobs[String(uid)] ||= new Map()).set(job.id, job);
  const C = load(uid, 'contacts', {}); let ok = 0, fail = 0, streak = 0, buf = null;
  try {
    if (m.type !== 'text') buf = fs.readFileSync(m.file);
    for (const t of targets) {
      if (job.cancel) break;
      try {
        const first = (C[t.num]?.name || '').split(/\s+/)[0] || 'there', fill = s => String(s || '').replace(/\{name\}/g, first);
        const cap2 = fill(m.caption) || undefined, ogg = /\.ogg$/.test(m.file || '');
        const content = m.type === 'text' ? { text: fill(m.text) }
          : m.type === 'image' ? { image: buf, caption: cap2 } : m.type === 'video' ? { video: buf, caption: cap2 }
          : m.type === 'audio' ? { audio: buf, mimetype: ogg ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: ogg }
          : { document: buf, fileName: m.fileName || 'file', mimetype: m.mime || 'application/octet-stream', caption: cap2 };
        if (t.kind === 'user') { await sock.sendPresenceUpdate?.('composing', t.jid).catch(() => {}); await sleep(pace(1500, 4000)); }
        await sock.sendMessage(t.jid, content); ok++; streak = 0;
        if (t.kind === 'user' && C[t.num]) C[t.num].lastOut = Date.now();
      } catch { fail++; if (++streak >= 5) throw new Error('Five sends failed in a row, so I stopped. WhatsApp may be limiting this number.'); }
      day.n++; job.sent = ok; prog(ok + fail, targets.length);
      await napJob(t.kind === 'user' ? pace(6000, 15000) : pace(3000, 8000), job);     // slow and human-like: this is what keeps numbers safe
    }
  } finally { jobs[String(uid)]?.delete(job.id); save(uid, 'contacts', C); save(uid, 'profile', pf); }
  return { ok, fail, total: targets.length, cancelled: job.cancel };
}
const msgBusy = new Set();
async function dispatchMessages() {
  for (const uid of users()) {
    const L = load(uid, 'msgs', []); let ch = false;
    for (const m of L) if (m.status === 'scheduled' && Date.now() - m.at > GRACE) {        // same 5-minute rule as posts: never send "good morning" at noon
      const next = m.repeat && m.repeat !== 'none' ? nextAt(m) : null;
      hooks.note(uid, `⏭ The message scheduled for ${fmt(m.at)} was NOT sent: it could not go out within 5 minutes.${next ? ` Next repeat: ${fmt(next)}.` : ''}`, true);
      if (next) { m.at = next; } else m.status = 'missed'; delete m.retryAt; delete m.notifiedDown; ch = true;
    }
    if (ch) save(uid, 'msgs', L);
    if (msgBusy.has(uid) || msgBusy.size >= 3) continue;
    const m = L.find(x => x.status === 'scheduled' && (x.retryAt ?? x.at) <= Date.now()); if (!m) continue;
    if (!up[uid]) {
      kick(uid); m.retryAt = Date.now() + 15000;
      if (!m.notifiedDown) { m.notifiedDown = true; hooks.note(uid, `🔌 WhatsApp is disconnected. Reconnecting to send your ${fmt(m.at)} message; I will try for 5 minutes.`, true); }
      save(uid, 'msgs', L); continue;
    }
    msgBusy.add(uid); m.status = 'sending'; delete m.retryAt; save(uid, 'msgs', L);
    void (async () => {
      try {
        const r = await runMessage(uid, m);
        const next = m.repeat && m.repeat !== 'none' ? nextAt(m) : null;
        if (next) { m.at = next; m.status = 'scheduled'; } else m.status = r.cancelled ? 'cancelled' : 'sent';
        delete m.notifiedDown; delete m.lastErr;
        hooks.note(uid, r.cancelled ? `🛑 Your scheduled message was stopped (${r.ok} already sent).` : `✅ Scheduled message sent: ${r.ok} delivered${r.fail ? `, ${r.fail} failed` : ''}.`, true);
      } catch (e) {
        const msg = e?.message || 'Could not send the message.';
        if (/paused|expired|limit|spam guard|nobody|too many|already being sent|five sends/i.test(msg)) {
          const next = m.repeat && m.repeat !== 'none' ? nextAt(m) : null; if (next) { m.at = next; m.status = 'scheduled'; } else m.status = 'failed'; delete m.retryAt;
          hooks.note(uid, `⚠️ A scheduled message was not sent: ${msg}${next ? ` Next repeat: ${fmt(next)}.` : ''}`, true);
        } else { m.status = 'scheduled'; m.retryAt = Date.now() + 20000; kick(uid); if (m.lastErr !== msg) { m.lastErr = msg; hooks.note(uid, `⚠️ Your scheduled message hit a problem and is retrying (up to 5 minutes after its time): ${msg}`, true); } }
      } finally { msgBusy.delete(uid); save(uid, 'msgs', load(uid, 'msgs', [])); }
    })();
  }
}
{ const t = setInterval(() => { dispatchMessages().catch(() => {}); }, 10000); t.unref?.(); }
{ const t = setTimeout(() => { for (const uid of users()) { const L = load(uid, 'msgs', []); let ch = false; for (const m of L) if (m.status === 'sending') { m.status = 'interrupted'; ch = true; hooks.note(uid, '⚠️ A message being sent when the server restarted was not finished. I did not resend it, so nobody gets it twice.', true); } if (ch) save(uid, 'msgs', L); } }, 20000); t.unref?.(); }
