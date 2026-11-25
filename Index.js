// index.js — Telegram UI (everything in the pinned bottom keyboard)
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Telegraf, Markup } from 'telegraf';
import * as W from './core.js';
import { startApi } from './api.js';
const { CFG, load, save, prof, udir, users, hooks, fmt } = W;

if (!CFG.token) throw new Error('BOT_TOKEN is required to start the Telegram bot.');
const bot = new Telegraf(CFG.token, { handlerTimeout: Infinity });
const ST = {}; const St = u => ST[u] ??= { uid: u, nav: ['home'], tmp: [] };
const isAdm = u => W.isAdmin(u);
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const STYLE_MODES = { '🤖 Auto colours': 'auto', '🔵 All blue': 'primary', '🟢 All green': 'success', '🔴 All red': 'danger', '⚪ No colours': 'off' };
function styleFor(label) {                          // Telegram Bot API button styles: primary (blue), success (green), danger (red)
  const mode = W.CFG.kbStyle || 'auto';
  if (mode === 'off' || /Back/.test(label)) return undefined;
  if (['primary', 'success', 'danger'].includes(mode)) return /Home/.test(label) ? undefined : mode;
  if (/Unlink|Delete|Remove|Cancel|Decline|Force|Pause|Clear|Stop/i.test(label)) return 'danger';
  if (/Post now|Approve|Done|Yes|Save|Link WhatsApp|Choose a plan|Send receipt|QR code|Phone code|Resume|New scheduled|Choose date|Add plan/i.test(label)) return 'success';
  if (/Home|Post$|Schedule|Audience|Insights|Plan|Inbox|Account|Admin/.test(label)) return 'primary';
  return undefined;
}
const packRows = rows => {                         // reflow into neat, short rows (max 6 small buttons, ~40 characters per row)
  const nav = rows.filter(r => r[0] === '⬅️ Back'), flat = rows.filter(r => r[0] !== '⬅️ Back').flat(), res = [];
  let cur = [], w = 0;
  for (const l of flat) { const lw = l.length + 2; if (cur.length && (cur.length >= 6 || w + lw > 40)) { res.push(cur); cur = []; w = 0; } cur.push(l); w += lw; }
  if (cur.length) res.push(cur);
  return [...res, ...nav];
};
const kb = rows => {
  const shown = packRows(rows).map(row => row.map(label => {
    if (label === '📱 Open app' && process.env.MINIAPP_URL) return { text: label, web_app: { url: process.env.MINIAPP_URL } };   // opens the Mini App inside Telegram
    const style = styleFor(label); return style ? { text: label, style } : label;
  }));
  let k = Markup.keyboard(shown).resize();
  if (W.CFG.kbPinned !== false) k = k.persistent();           // admin toggle: pinned = always open, unpinned = can be collapsed
  return k.placeholder('Use the menu ↓');
};
const normalizeButton = text => text;
const keyboardFor = u => kb(St(u).keyboardRows || MENUS.home.rows(u));
const nums = t => {                                                  // "+234 801 111 1111" is one number; two numbers on one line are split
  const good = []; const take = s => { const d = s.replace(/\D/g, ''); if (d.length >= 7 && d.length <= 15) { good.push(d); return true; } return false; };
  for (const tok of String(t).split(/[\n,;]+/).map(x => x.trim()).filter(Boolean)) { if (take(tok)) continue; const parts = tok.split(/\s+/); if (parts.length > 1) parts.forEach(take); }
  return [...new Set(good)];
};
const tg = bot.telegram;
const hasFileAttachment = m => !!(m?.document || m?.photo || m?.video || m?.audio || m?.voice || m?.video_note || m?.animation || m?.sticker);

// ---------- poll answers + reactions on admin polls/broadcasts (registered BEFORE the filter below, which drops non-message updates) ----------
const campaigns = () => load('_g', 'campaigns', []);
bot.on('poll_answer', (ctx, next) => {                            // "show who voted" polls
  const a = ctx.pollAnswer, L = campaigns(), c = L.find(x => x.pollIds && x.pollIds[a.poll_id] !== undefined);
  if (!c) return next();
  const uid = a.user?.id; if (uid === undefined) return;
  if (a.option_ids?.length) c.votes[uid] = a.option_ids; else delete c.votes[uid];
  save('_g', 'campaigns', L);
});
bot.on('poll', (ctx, next) => {                                   // anonymous polls: Telegram sends live totals per poll copy
  const p = ctx.poll, L = campaigns(), c = L.find(x => x.pollIds && x.pollIds[p.id] !== undefined);
  if (!c) return next();
  c.counts[p.id] = p.options.map(o => o.voter_count); c.totals[p.id] = p.total_voter_count; save('_g', 'campaigns', L);
});
bot.on('message_reaction', ctx => {                               // 👍❤️🔥 … on any broadcast or poll
  const r = ctx.messageReaction, chat = String(r.chat.id), L = campaigns(), c = L.find(x => String(x.msgs?.[chat]) === String(r.message_id));
  if (!c) return;
  const emojis = (r.new_reaction || []).filter(x => x.type === 'emoji').map(x => x.emoji);
  if (emojis.length) c.reacts[chat] = emojis; else delete c.reacts[chat];
  save('_g', 'campaigns', L);
});
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private' || !ctx.from || !ctx.message) return;
  const file = hasFileAttachment(ctx.message);
  const isOwnerFile = file && W.isOwner(ctx.from.id);
  const isReceiptFile = file && St(ctx.from.id).step === 'receipt';
  ctx.state.keepIncomingMessage = isOwnerFile || isReceiptFile;
  try {
    await next();
  } finally {
    if (!ctx.state.keepIncomingMessage) {
      try { await ctx.deleteMessage(); }
      catch (error) {
        console.warn('Could not delete a temporary incoming Telegram message:', error?.response?.description || error?.message || 'unknown Telegram API error');
      }
    }
  }
});

// ---------- output helpers: temp messages vanish, vital ones stay ----------
async function out(ctx, text, extra = {}, keep = false) {
  const s = St(ctx.from.id), m = await ctx.reply(text, { parse_mode: 'HTML', ...keyboardFor(ctx.from.id), ...extra });
  if (!keep) {
    s.tmp.push(m.message_id);
    const timer = setTimeout(() => tg.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 120000);
    timer.unref?.();
  }
  return m;
}
async function clean(ctx) { const s = St(ctx.from.id); for (const id of s.tmp) tg.deleteMessage(ctx.chat.id, id).catch(() => {}); s.tmp = []; }
const ask = (ctx, s, step, text, rows = []) => {
  s.step = step; s.kbFlow = true;
  s.keyboardRows = [...rows.map(r => r.filter(l => canSee(ctx.from.id, l))).filter(r => r.length), ['⬅️ Back', '🏠 Home']];
  return out(ctx, text, kb(s.keyboardRows));
};
const doc = (ctx, text, name) => ctx.replyWithDocument({ source: Buffer.from(text || '—'), filename: name });
const phone = n => '+' + n;

// ---------- menus (main → sub → sub-sub) ----------
const state = u => !W.linked(u) ? 'new' : (W.expired(prof(u)) && !isAdm(u)) ? 'expired' : 'ok';
// ---------- who can see/do what ----------
const FEATURES = {
  app: { name: 'Mini App button', def: true, labels: ['📱 Open app'] },
  profile: { name: 'Profile', def: true, labels: ['👤 Profile'] },
  post: { name: 'Posting', def: true, labels: ['✍️ Post', '📝 Text', '🖼 Image', '🎬 Video', '🎵 Audio'] },
  queue: { name: 'Queue many', def: true, labels: ['🗂 Queue many'] },
  templates: { name: 'Templates', def: true, labels: ['📄 Templates', '📋 My templates', '🗑 Delete template'] },
  colours: { name: 'Saved colours', def: true, labels: ['🎨 My colours', '⭐ Saved colours', '➕ Save a colour'] },
  schedule: { name: 'Scheduling', def: true, labels: ['🗓 Schedule a post', '📋 Manage scheduled', '➕ New scheduled post', '📅 Upcoming', '✏️ Edit / reschedule', '🗑 Cancel posts', '🧹 Cancel all', '💡 Best time'] },
  sending: { name: 'Live sending control', def: true, labels: ['📡 Sending now'] },
  audience: { name: 'Audience menu', def: true, labels: ['👥 Audience'] },
  contacts: { name: 'Contact insights', def: true, labels: ['👤 Contacts', '📈 Summary', '👁 Who views me', '👁 Post viewers', '😴 Inactive 6m'] },
  export: { name: 'Export numbers', def: false, labels: ['📤 Export numbers'] },
  dedupe: { name: 'Fix duplicates', def: false, labels: ['🧹 Fix duplicates'] },
  lists: { name: 'Lists', def: true, labels: ['🏷 Lists', '➕ New list', '➕ Add numbers', '📖 View lists', '🗑 Delete list'] },
  exclusions: { name: 'Exclusions', def: true, labels: ['🚫 Exclusions', '➕ Exclude number', '➖ Un-exclude', '📖 View excluded'] },
  groups: { name: 'Groups & links', def: false, labels: ['👪 Groups & links', '📖 My groups', '😴 Quiet groups', '🔄 Refresh groups', '🔗 Group links', '🧹 Clean dead links', '🧾 Review dead links', '🏷 Tag settings', '🔢 Tag count', '🔀 Tag mode', '👪 From a group', '👪 Group members only'] },
  insights: { name: 'Insights', def: true, labels: ['📊 Insights', '📈 Stats', '⏰ Best hours', '🏆 Best posts', '📰 Weekly report'] },
  plan: { name: 'Plans & payment', def: true, labels: ['💳 Plan', '📄 My plan', '🛒 Choose a plan', '🧾 Send receipt', '💳 Pay'] },
  inbox: { name: 'Inbox & support', def: true, labels: ['📩 Inbox', '📌 Notices', '✉️ Message admin'] },
  msgs: { name: 'Messages (numbers, lists, groups, channels)', def: false, labels: ['✉️ Messages', '✉️ New message', '📋 Scheduled messages', '📺 My channels', '📚 Group lists', '➕ New group list', '➕ Add groups to a list', '➖ Remove from a list', '📖 View group lists', '🗑 Delete group list', '📚 A group list'] },
  reach: { name: 'Reach-out messages', def: false, labels: ['📣 Reach out', '🔛 Reach-out on/off', '📊 Reach-out stats', '✏️ Reach-out messages', '🔢 Reach-out per day'] },
  unsend: { name: 'Delete sent posts', def: true, labels: ['🗑 Delete a sent post'] },
  referral: { name: 'Referrals', def: true, labels: ['🎁 Refer a friend'] },
  t_alerts: { name: 'Alerts toggle', def: false, labels: ['🔔 Toggle alerts'] },
  t_weekly: { name: 'Weekly-report toggle', def: false, labels: ['📰 Toggle weekly report'] },
  t_prune: { name: 'Auto-prune toggle', def: false, labels: ['🧹 Toggle auto-prune'] },
  repair: { name: 'Repair session', def: false, labels: ['🧽 Repair session'] }
};
const FEATURE_OF = {}; for (const [k, f] of Object.entries(FEATURES)) for (const l of f.labels) FEATURE_OF[l] = k;
const PERMS = { users: 'Users: list, pause, limits', userdata: 'Extract user data', messages: 'Messages & notices', payments: 'Payments', plans: 'Plans', settings: 'Settings', features: 'Feature access', running: 'All running posts', deleted: 'Deleted accounts', backup: 'Backups', sessions: 'Unlink / repair users', logs: 'Activity log' };
const PERM_OF = {};
for (const [p, labels] of Object.entries({
  users: ['👤 Users', '📋 List users', 'ℹ️ User info', '⏸ Pause', '▶️ Resume', '🔢 Set limit', '⏳ Add days', '🗑 Remove user'],
  userdata: ['📂 User data', '📦 User data file'],
  messages: ['📢 Messages', '📢 Broadcast', '🗳 New poll', '📊 Results', '📌 Pin notice', '📥 Admin inbox', '↩️ Reply user'],
  payments: ['💰 Payments', '🕒 Pending', '✅ Approve', '❌ Decline'],
  plans: ['🗂 Manage plans', '➕ Add plan', '✏️ Edit plan', '🗑 Remove plan', '📖 List plans'],
  settings: ['⚙️ Settings', '💳 Pay link', '🏦 Bank details', '🔢 Default limit', '👥 Max audience', '📦 Batch size', '⏳ Trial days', '🧪 Toggle plan required', '📌 Pinned keyboard', '🌈 Button colours', '🤖 Auto session repair', '⏰ Reminder days', '🎁 Referral days', '🌐 Online payments', '🔑 Payment key', '🛡 Spam guard', '🔗 Max links per post', '🚫 Spam words', '📣 Reach-out max/day', '✉️ Message daily cap', '👥 Message max recipients'],
  features: ['🧩 Features', '🌐 Default features', '🧑 User features'],
  running: ['📡 All sending'], deleted: ['🗄 Deleted accounts'], backup: ['💾 Backup now', '♻️ Restore backup'],
  sessions: ['🔌 Force unlink', '🧽 Repair user'],
  logs: ['🧾 Activity log']
})) for (const l of labels) PERM_OF[l] = p;
const OWNER_ONLY = new Set(['♻️ Restore backup', '👮 Admins', '➕ Add admin', '➖ Remove admin', '📖 List admins', '🔐 Admin access']);
const permList = id => load('_g', 'admin_perms', {})[String(id)];
const permOn = (u, k) => W.isOwner(u) || (permList(u) ?? Object.keys(PERMS)).includes(k);   // admins with no saved list keep full access
const featState = (target, k) => { const g = load('_g', 'features', {})[k] ?? FEATURES[k].def; return target ? (prof(target).feat?.[k] ?? g) : g; };
const featOn = (u, k) => isAdm(u) || featState(u, k);
function canSee(u, label) {
  if (OWNER_ONLY.has(label)) return W.isOwner(u);
  if (label === '🛠 Admin') return isAdm(u) && (W.isOwner(u) || (permList(u) ?? ['x']).length > 0);
  if (PERM_OF[label]) return isAdm(u) && permOn(u, PERM_OF[label]);
  return FEATURE_OF[label] ? featOn(u, FEATURE_OF[label]) : true;
}
const MENU_PERM = { adminUsers: 'users', adminMsg: 'messages', adminPay: 'payments', adminPlans: 'plans', settings: 'settings', features: 'features', admins: 'owner' };
const refreshMenus = () => { for (const k of Object.keys(ST)) { ST[k].keyboardRows = undefined; ST[k].nav = ['home']; } };

const MENUS = {
  home: { t: '🏠 Main menu', rows: u => {
    const s = state(u), r = [];
    if (process.env.MINIAPP_URL) r.push(['📱 Open app']);
    if (s === 'new') r.push(['📲 Link WhatsApp']);
    if (s === 'ok') r.push(['✍️ Post', '🗓 Schedule a post'], ['👥 Audience', '📊 Insights'], ['📋 Manage scheduled']);
    r.push(['💳 Plan', '📩 Inbox'], ['👤 Profile', '⚙️ Account']);
    if (isAdm(u)) r.push(['🛠 Admin']);
    return r; } },
  link: { t: '📲 Link WhatsApp — choose a method', rows: () => [['📷 QR code', '🔢 Phone code']] },
  post: { t: '✍️ New post', rows: () => [['📝 Text', '🖼 Image'], ['🎬 Video', '🎵 Audio'], ['🗂 Queue many', '📄 Templates'], ['🎨 My colours', '📡 Sending now'], ['🗑 Delete a sent post', '✉️ Messages']] },
  templates: { t: '📄 Templates', rows: () => [['📋 My templates', '🗑 Delete template']] },
  colours: { t: '🎨 Colours', rows: () => [['⭐ Saved colours', '➕ Save a colour']] },
  schedule: { t: '📋 Manage scheduled posts', rows: () => [['➕ New scheduled post'], ['📅 Upcoming', '✏️ Edit / reschedule'], ['🗑 Cancel posts', '🧹 Cancel all'], ['💡 Best time']] },
  audience: { t: '👥 Audience', rows: () => [['👤 Contacts', '🏷 Lists'], ['🚫 Exclusions', '👪 Groups & links'], ['📣 Reach out']] },
  contacts: { t: '👤 Contacts', rows: () => [['📈 Summary', '👁 Who views me'], ['👁 Post viewers', '😴 Inactive 6m'], ['📤 Export numbers', '🧹 Fix duplicates']] },
  lists: { t: '🏷 Lists', rows: () => [['➕ New list', '➕ Add numbers'], ['📖 View lists', '🗑 Delete list']] },
  messages: { t: '✉️ Messages', rows: () => [['✉️ New message', '📋 Scheduled messages'], ['📚 Group lists', '📺 My channels']] },
  grouplists: { t: '📚 Group lists', rows: () => [['➕ New group list', '➕ Add groups to a list'], ['➖ Remove from a list', '📖 View group lists'], ['🗑 Delete group list']] },
  reach: { t: '📣 Reach out', rows: () => [['🔛 Reach-out on/off', '📊 Reach-out stats'], ['✏️ Reach-out messages', '🔢 Reach-out per day']] },
  excl: { t: '🚫 Exclusions', rows: () => [['➕ Exclude number', '➖ Un-exclude'], ['📖 View excluded']] },
  groups: { t: '👪 Groups & links', rows: () => [['📖 My groups', '😴 Quiet groups'], ['🔄 Refresh groups', '🔗 Group links'], ['🧹 Clean dead links', '🧾 Review dead links'], ['🏷 Tag settings']] },
  tagset: { t: '🏷 Tag settings', rows: () => [['🔢 Tag count', '🔀 Tag mode']] },
  insights: { t: '📊 Insights', rows: () => [['📈 Stats', '⏰ Best hours'], ['🏆 Best posts', '📰 Weekly report']] },
  plan: { t: '💳 Plan', rows: () => [['📄 My plan', '🛒 Choose a plan'], ['🧾 Send receipt', '🎁 Refer a friend']] },
  inbox: { t: '📩 Inbox', rows: () => [['📌 Notices', '✉️ Message admin']] },
  account: { t: '⚙️ Account', rows: () => [['ℹ️ Status', '🔔 Toggle alerts'], ['📰 Toggle weekly report', '🧹 Toggle auto-prune'], ['🧽 Repair session'], ['🔌 Unlink', '🗑 Delete account']] },
  admin: { t: '🛠 Admin', rows: () => [['👤 Users', '📂 User data'], ['📢 Messages', '💰 Payments'], ['🗂 Manage plans', '🧩 Features'], ['⚙️ Settings', '📡 All sending'], ['🗄 Deleted accounts', '💾 Backup now'], ['♻️ Restore backup'], ['🧾 Activity log', '👮 Admins']] },
  features: { t: '🧩 Features', rows: () => [['🌐 Default features', '🧑 User features']] },
  settings: { t: '⚙️ Settings (live — no code edits)', rows: u => [['💳 Pay link', '🏦 Bank details'], ['🔢 Default limit', '👥 Max audience'], ['📦 Batch size', '⏳ Trial days'], ['🧪 Toggle plan required'], ['📌 Pinned keyboard', '🌈 Button colours'], ['🤖 Auto session repair', '⏰ Reminder days'], ['🎁 Referral days', '🌐 Online payments'], ['🔑 Payment key', '🛡 Spam guard'], ['🔗 Max links per post', '🚫 Spam words'], ['📣 Reach-out max/day', '✉️ Message daily cap'], ['👥 Message max recipients']] },
  admins: { t: '👮 Admins', rows: () => [['➕ Add admin', '➖ Remove admin'], ['🔐 Admin access', '📖 List admins']] },
  adminUsers: { t: '👤 Users', rows: () => [['📋 List users', 'ℹ️ User info'], ['⏸ Pause', '▶️ Resume'], ['🔢 Set limit', '⏳ Add days'], ['🔌 Force unlink', '🧽 Repair user'], ['📦 User data file', '🗑 Remove user']] },
  adminMsg: { t: '📢 Messages', rows: () => [['📢 Broadcast', '🗳 New poll'], ['📊 Results', '📌 Pin notice'], ['📥 Admin inbox', '↩️ Reply user']] },
  adminPay: { t: '💰 Payments', rows: () => [['🕒 Pending', '✅ Approve'], ['❌ Decline']] },
  adminPlans: { t: '🗂 Plans', rows: () => [['➕ Add plan', '✏️ Edit plan'], ['🗑 Remove plan', '📖 List plans']] }
};
for (const m of Object.values(MENUS)) { const orig = m.rows; m.rows = u => orig(u).map(r => r.filter(l => canSee(u, l))).filter(r => r.length); }
async function go(ctx, id, push = true, keep = false) {
  const u = ctx.from.id, s = St(u);
  reset(s);
  if (/^admin|^settings$|^features$/.test(id)) {                      // admin screens: admins only, and only the parts they were given
    const need = MENU_PERM[id];
    if (!isAdm(u) || (need === 'owner' ? !W.isOwner(u) : need && !permOn(u, need)) || (id === 'admin' && !canSee(u, '🛠 Admin'))) id = 'home';
  }
  const m = MENUS[id];
  if (id === 'home') s.nav = ['home']; else if (push && s.nav.at(-1) !== id) s.nav.push(id);
  if (!keep) await clean(ctx);
  s.keyboardRows = [...m.rows(u), ...(id === 'home' ? [] : [['⬅️ Back', '🏠 Home']])];
  return out(ctx, m.t, kb(s.keyboardRows));
}
const cur = s => s.nav.at(-1) || 'home';
const reset = s => {
  for (const k of ['step', 'p', 'q', 'edit', 'only', 'isQ', 'rep', 'days', 'off', 'h', 'm', 'ap', 'gap', 'gl', 'pick', 'intent', 'target', 'listName', 'settingKey', 'adminAction', 'cf', 'page', 'excludeKind', 'deadLinkKeys', 'deadLinkKey', 'forceSchedule', 'isMsg', 'msg', 'msel', 'gview', 'postList', 'tog', 'userPick', 'unsend',  'dateAbs', 'dm', 'planDraft', 'planIdx', 'planField', 'defDays']) delete s[k];
  s.kbFlow = false;
  const id = s.nav.at(-1) || 'home', menu = MENUS[id] || MENUS.home;
  s.keyboardRows = [...menu.rows(s.uid), ...(id === 'home' ? [] : [['⬅️ Back', '🏠 Home']])];
};
async function ready(ctx) {
  const u = ctx.from.id, pf = prof(u);
  if (!W.linked(u)) { out(ctx, '⚠️ Link WhatsApp first.'); return false; }
  if (pf.paused && !isAdm(u)) { out(ctx, '⏸ Your account is paused by the admin.'); return false; }
  if (W.expired(pf) && !isAdm(u)) { out(ctx, '⌛ Your plan has expired — open 💳 Plan.'); return false; }
  return true;
}

// ---------- colour / font data ----------
const PAL1 = { Red: '#E53935', Orange: '#FB8C00', Yellow: '#FDD835', Green: '#43A047', Blue: '#1E88E5', Purple: '#8E24AA', Pink: '#EC407A', Teal: '#128C7E', Black: '#000000', White: '#FFFFFF', Grey: '#757575', Brown: '#6D4C41' };
const PAL2 = { Crimson: '#B71C1C', Coral: '#FF7043', Gold: '#FFC107', Lime: '#C0CA33', Mint: '#26A69A', Cyan: '#00ACC1', Sky: '#29B6F6', Navy: '#0D47A1', Indigo: '#3949AB', Violet: '#5E35B1', Magenta: '#D81B60', Maroon: '#880E4F', Olive: '#827717', Peach: '#FFAB91', Lavender: '#B39DDB', Slate: '#455A64' };
const FONTS = { Default: 0, Text: 1, Script: 2, Bold: 6, Morning: 7, Calistoga: 8, Exo: 9, Courier: 10 };
const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const A = {}, F = {};                       // A: button actions, F: step handlers
for (const [label, id] of [['📲 Link WhatsApp', 'link'], ['✍️ Post', 'post'], ['📄 Templates', 'templates'], ['🎨 My colours', 'colours'], ['📋 Manage scheduled', 'schedule'], ['👥 Audience', 'audience'], ['👤 Contacts', 'contacts'], ['🏷 Lists', 'lists'], ['🚫 Exclusions', 'excl'], ['👪 Groups & links', 'groups'], ['🏷 Tag settings', 'tagset'], ['📊 Insights', 'insights'], ['💳 Plan', 'plan'], ['📩 Inbox', 'inbox'], ['⚙️ Account', 'account'], ['🛠 Admin', 'admin'], ['👤 Users', 'adminUsers'], ['📢 Messages', 'adminMsg'], ['💰 Payments', 'adminPay'], ['⚙️ Settings', 'settings'], ['👮 Admins', 'admins'], ['🗂 Manage plans', 'adminPlans'], ['🧩 Features', 'features'], ['📣 Reach out', 'reach'], ['✉️ Messages', 'messages'], ['📚 Group lists', 'grouplists']]) A[label] = ctx => go(ctx, id);
async function openScheduledComposer(ctx) {
  const s = St(ctx.from.id);
  await go(ctx, 'post');
  s.forceSchedule = true;
  return out(ctx, '🗓 Choose a post type below. This flow will schedule it instead of posting immediately.');
}
A['🗓 Schedule a post'] = openScheduledComposer;
A['➕ New scheduled post'] = openScheduledComposer;

// ---------- link ----------
A['📷 QR code'] = async ctx => { St(ctx.from.id).linkMode = 'qr'; await out(ctx, '⏳ Generating QR…'); W.connect(ctx.from.id, 'qr').catch(e => out(ctx, '❌ ' + esc(e.message))); };
A['🔢 Phone code'] = ctx => ask(ctx, St(ctx.from.id), 'phone', 'Send your WhatsApp number with country code, e.g. 2348012345678');
F.phone = async (ctx, t, s) => {
  const number = nums(t)[0];
  if (!number) return out(ctx, 'Send one valid phone number with its country code.');
  s.step = null; await out(ctx, '⏳ Requesting code…');
  W.connect(ctx.from.id, 'code', number).catch(e => out(ctx, '❌ ' + esc(e.message)));
};
hooks.qr = async (uid, buf) => {
  const s = St(uid), m = await tg.sendPhoto(uid, { source: buf }, { caption: 'Scan: WhatsApp → Linked devices → Link a device. Each QR stays valid ~2 minutes; the newest one is the live one.', ...keyboardFor(uid) });
  if (s.qrMsg) tg.deleteMessage(uid, s.qrMsg).catch(() => {}); s.qrMsg = m.message_id;
};
hooks.code = async (uid, code) => { W.linkState[uid] = { code, t: Date.now() }; const s = St(uid), m = await tg.sendMessage(uid, `🔢 Your code: <code>${code.match(/.{1,4}/g).join('-')}</code>\nWhatsApp → Linked devices → Link with phone number. It will not be regenerated.`, { parse_mode: 'HTML', ...keyboardFor(uid) }); s.codeMsg = m.message_id; };
hooks.opened = async uid => {
  delete W.linkState[uid];
  const s = St(uid); for (const k of ['qrMsg', 'codeMsg']) if (s[k]) { tg.deleteMessage(uid, s[k]).catch(() => {}); s[k] = null; }
  s.nav = ['home']; reset(s);
  s.keyboardRows = MENUS.home.rows(uid);
  tg.sendMessage(uid, '✅ <b>WhatsApp connected!</b>\nYour new dashboard is ready ↓', { parse_mode: 'HTML', ...keyboardFor(uid) });
};
hooks.note = (uid, text, keep) => tg.sendMessage(uid, text, { parse_mode: 'HTML', ...keyboardFor(uid) }).then(m => {
  if (!keep) { const timer = setTimeout(() => tg.deleteMessage(uid, m.message_id).catch(() => {}), 600000); timer.unref?.(); }
}).catch(() => {});
hooks.progress = () => {};
hooks.planActive = (uid, text) => { const us = St(Number(uid)); us.nav = ['home']; us.keyboardRows = MENUS.home.rows(Number(uid)); tg.sendMessage(uid, text, { parse_mode: 'HTML', ...keyboardFor(Number(uid)) }).catch(() => {}); };
hooks.adminNote = text => { for (const a of W.adminList()) if (W.isOwner(a) || permOn(a, 'payments')) tg.sendMessage(a, text, { parse_mode: 'HTML' }).catch(() => {}); };
hooks.expired = uid => tg.sendMessage(uid, '⌛ <b>Your plan has expired.</b> Open 💳 Plan to renew.', { parse_mode: 'HTML', ...keyboardFor(uid) }).catch(() => {});
hooks.report = (uid, t) => tg.sendMessage(uid, t, { parse_mode: 'HTML', ...keyboardFor(uid) }).catch(() => {});
hooks.backup = f => CFG.admin && tg.sendDocument(CFG.admin, { source: f, filename: f.endsWith('.enc') ? 'sessions-backup.tgz.enc' : 'sessions-backup.tgz' }, { caption: '🔐 Nightly backup of every WhatsApp login. Keep it private. To restore: Admin → ♻️ Restore backup.' }).catch(() => tg.sendMessage(CFG.admin, '⚠️ Tonight\'s backup could not be sent to Telegram (the file may be over 50 MB). It is saved on the server.').catch(() => {}));

// ---------- colours ----------
function askColor(ctx, s, which, page = '1') {
  const pf = prof(ctx.from.id); s.cf = which; s.page = page;
  const rows = [...chunk(Object.keys(page === '1' ? PAL1 : PAL2), 3), ...chunk(pf.colors.map(c => '⭐ ' + c.name), 3), [page === '1' ? '➡️ More colours' : '⬅️ Basic colours', '➕ Custom hex'], ['✔ Keep default']];
  return ask(ctx, s, 'color', `🎨 Pick the <b>${which === 'bg' ? 'background' : 'text'}</b> colour`, rows);
}
function setColor(ctx, s, hex) {
  const pf = prof(ctx.from.id); if (s.cf === 'bg') { s.p.bg = hex; pf.color = hex; } else { s.p.tc = hex; pf.textColor = hex; }
  save(ctx.from.id, 'profile', pf);
  return s.cf === 'bg' ? askColor(ctx, s, 'tc') : ask(ctx, s, 'font', '🔤 Pick a font', chunk(Object.keys(FONTS), 4));
}
F.color = (ctx, t, s) => {
  const pf = prof(ctx.from.id);
  if (t === '➡️ More colours') return askColor(ctx, s, s.cf, '2'); if (t === '⬅️ Basic colours') return askColor(ctx, s, s.cf, '1');
  if (t === '➕ Custom hex') return ask(ctx, s, 'hex', 'Send a hex like <code>#FF5722</code>. Add a name to save it for later: <code>#FF5722 Sunset</code>');
  const hex = t === '✔ Keep default' ? (s.cf === 'bg' ? pf.color : pf.textColor) : t.startsWith('⭐ ') ? pf.colors.find(c => '⭐ ' + c.name === t)?.hex : { ...PAL1, ...PAL2 }[t];
  return hex ? setColor(ctx, s, hex) : askColor(ctx, s, s.cf, s.page);
};
F.hex = (ctx, t, s) => {
  const m = t.match(/^#?([0-9a-f]{6})\s*(.*)$/i); if (!m) return out(ctx, '❌ Not a valid hex. Example: #FF5722');
  const hex = '#' + m[1].toUpperCase(), name = m[2].trim().slice(0, 20), pf = prof(ctx.from.id);
  if (name) { pf.colors = pf.colors.filter(c => c.name !== name); pf.colors.push({ name, hex }); save(ctx.from.id, 'profile', pf); }
  if (!s.p) { s.step = null; return out(ctx, `✅ Saved ${esc(name || hex)}`); }
  s.step = 'color'; return setColor(ctx, s, hex);
};
F.font = (ctx, t, s) => { if (!(t in FONTS)) return; s.p.font = FONTS[t]; const pf = prof(ctx.from.id); pf.font = FONTS[t]; save(ctx.from.id, 'profile', pf); return askAud(ctx, s); };
A['⭐ Saved colours'] = ctx => { const c = prof(ctx.from.id).colors; return out(ctx, c.length ? c.map(x => `${x.name} — <code>${x.hex}</code>`).join('\n') : 'None yet. Use ➕ Save a colour.'); };
A['➕ Save a colour'] = ctx => { const s = St(ctx.from.id); s.p = null; return ask(ctx, s, 'hex', 'Send <code>#HEX Name</code>, e.g. <code>#FF5722 Sunset</code>'); };

// ---------- compose ----------
A['📝 Text'] = async ctx => { if (await ready(ctx)) { const s = St(ctx.from.id); s.p = { type: 'text' }; ask(ctx, s, 'ptext', 'Send the text for your status.'); } };
F.ptext = (ctx, t, s) => { s.p.text = t; return askColor(ctx, s, 'bg'); };
for (const [l, k] of [['🖼 Image', 'image'], ['🎬 Video', 'video'], ['🎵 Audio', 'audio']]) A[l] = async ctx => { if (await ready(ctx)) { const s = St(ctx.from.id); s.p = null; ask(ctx, s, 'pmedia', `Send the ${k}${k === 'audio' ? ' (voice note)' : ' (add a caption if you like)'}.`); } };
async function fetchTo(ctx, id, ext) {
  const url = await tg.getFileLink(id); fs.mkdirSync(`${udir(ctx.from.id)}/media`, { recursive: true });
  const f = `${udir(ctx.from.id)}/media/${Date.now()}.${ext}`; fs.writeFileSync(f, Buffer.from(await (await fetch(url.href)).arrayBuffer())); return f;
}
// ---------- audience / tag / when ----------
function askAud(ctx, s) { const L = Object.keys(load(ctx.from.id, 'lists', {})); return ask(ctx, s, 'aud', '👥 Who should see it?', [['👥 Everyone', '👤 Personal only'], ['👪 Group members only'], ...chunk(L.map(x => '📋 ' + x), 2)]); }
F.aud = (ctx, t, s) => {
  const a = t === '👥 Everyone' ? 'all' : t === '👤 Personal only' ? 'personal' : t === '👪 Group members only' ? 'groups' : t.startsWith('📋 ') ? 'list:' + t.slice(3) : null;
  if (!a) return askAud(ctx, s);
  s.p.aud = a; s.p.exclude = []; s.p.excludeLists = []; s.p.excludeGroups = [];
  return ask(ctx, s, 'excl', '🚫 Choose people who should not see this post. You can add numbers, saved lists, or WhatsApp groups.', [['📱 Enter numbers', '📋 Exclude a list'], ['👪 Exclude a group', '⏭ Skip']]);
};
function askMoreExclusions(ctx, s) {
  return ask(ctx, s, 'exclMore', '✅ Exclusion added. Add another, or continue.', [['📱 Enter numbers', '📋 Exclude a list'], ['👪 Exclude a group', '✔ Done exclusions']]);
}
function continueAfterExclusions(ctx, s) {
  return s.isQ ? askDate(ctx, s) : ask(ctx, s, 'tag', '🏷 Who should be tagged? Choose people manually or select a group.', [['🚫 No tags', '🎲 Random contacts'], ['✍️ Enter numbers', '📋 From a list'], ['👪 From a group']]);
}
F.excl = (ctx, t, s) => {
  if (t === '⏭ Skip') return continueAfterExclusions(ctx, s);
  if (t === '📱 Enter numbers') return ask(ctx, s, 'excludeNumbers', 'Send phone numbers with country codes.');
  if (t === '📋 Exclude a list') {
    const names = Object.keys(load(ctx.from.id, 'lists', {}));
    if (!names.length) return out(ctx, 'No saved lists yet. Create one under 👥 Audience → 🏷 Lists.');
    s.excludeKind = 'list'; s.gl = names;
    return showNumbered(ctx, names, 'Saved lists', 'excludePick');
  }
  if (t === '👪 Exclude a group') {
    const groups = Object.entries(load(ctx.from.id, 'groups', {}));
    if (!groups.length) return out(ctx, 'No WhatsApp groups saved yet. Refresh groups first.');
    s.excludeKind = 'group'; s.gl = groups.map(([id]) => id);
    return showNumbered(ctx, groups.map(([, g]) => g.subject || 'Unnamed group'), 'WhatsApp groups', 'excludePick');
  }
};
F.excludeMore = (ctx, t, s) => {
  if (t === '✔ Done exclusions') return continueAfterExclusions(ctx, s);
  return F.excl(ctx, t, s);
};
F.excludeNumbers = (ctx, t, s) => {
  const numbers = nums(t);
  if (!numbers.length) return out(ctx, 'No valid phone numbers found. Include country codes and try again.');
  s.p.exclude = [...new Set([...s.p.exclude, ...numbers])];
  return askMoreExclusions(ctx, s);
};
F.excludePick = (ctx, t, s) => {
  const index = Number(t) - 1, id = s.gl?.[index];
  if (!id) return out(ctx, 'Choose a valid number from the list.');
  if (s.excludeKind === 'list') s.p.excludeLists = [...new Set([...s.p.excludeLists, id])];
  else s.p.excludeGroups = [...new Set([...s.p.excludeGroups, id])];
  return askMoreExclusions(ctx, s);
};
F.tag = (ctx, t, s) => {
  if (t === '🚫 No tags') return askWhen(ctx, s);
  if (t === '🎲 Random contacts') { s.p.tag = {}; return askWhen(ctx, s); }
  if (t === '✍️ Enter numbers') return ask(ctx, s, 'tagNumbers', 'Send the phone numbers to tag, including country codes.');
  if (t === '📋 From a list') {
    const names = Object.keys(load(ctx.from.id, 'lists', {}));
    if (!names.length) return out(ctx, 'No saved lists yet. Create one under 👥 Audience → 🏷 Lists.');
    s.gl = names;
    return showNumbered(ctx, names, 'Saved lists', 'tagListPick');
  }
  if (t === '👪 From a group') {
    const G = Object.entries(load(ctx.from.id, 'groups', {})); if (!G.length) return out(ctx, 'No groups yet — use 👪 Groups & links → 🔄 Refresh groups.');
    s.gl = G.map(g => g[0]); return showNumbered(ctx, G.map(([, g]) => g.subject || 'Unnamed group'), 'WhatsApp groups', 'tagg');
  }
};
F.tagNumbers = (ctx, t, s) => {
  const numbers = nums(t);
  if (!numbers.length) return out(ctx, 'No valid phone numbers found. Include country codes and try again.');
  s.p.tag = { numbers }; return askWhen(ctx, s);
};
F.tagListPick = (ctx, t, s) => {
  const name = s.gl?.[Number(t) - 1];
  if (!name) return out(ctx, 'Choose a valid number from the list.');
  s.p.tag = { list: name }; return askWhen(ctx, s);
};
F.tagg = (ctx, t, s) => { const id = s.gl?.[+t - 1]; if (!id) return out(ctx, 'Invalid number.'); s.p.tag = { group: id }; return askWhen(ctx, s); };
const askWhen = (ctx, s) => ask(
  ctx,
  s,
  'when',
  s.forceSchedule ? '🗓 Choose when this post should be scheduled.' : 'When should it go out?',
  s.forceSchedule ? [['🗓 Choose date & time'], ['💾 Save as template']] : [['🚀 Post now', '🗓 Schedule'], ['💾 Save as template']]
);
F.when = async (ctx, t, s) => {
  const u = ctx.from.id;
  if (t === '💾 Save as template') return ask(ctx, s, 'tname', 'Name this template.');
  if (t === '🗓 Schedule' || t === '🗓 Choose date & time') return askDate(ctx, s);
  if (t === '🚀 Post now' && s.forceSchedule) return out(ctx, 'This post is in schedule mode. Choose 🗓 Choose date & time to continue.');
  if (t !== '🚀 Post now' || !(await ready(ctx))) return;
  { const sg = W.checkSpam(u, s.p); if (!sg.ok) return out(ctx, `🛡 Spam guard: this post ${esc(sg.reason)}. Edit it and try again.`); }
  const p = { ...s.p, id: Date.now() }; reset(s); await go(ctx, 'home'); startNow(ctx, u, p);
};
F.tname = (ctx, t, s) => { const T = load(ctx.from.id, 'templates', []); T.push({ name: t.slice(0, 30), p: s.p }); save(ctx.from.id, 'templates', T); out(ctx, '💾 Saved'); return askWhen(ctx, s); };
function startNow(ctx, u, p) {
  ctx.reply('⏳ Preparing your post…', keyboardFor(u)).then(m => {
    const edit = t => tg.editMessageText(ctx.chat.id, m.message_id, undefined, t).catch(() => {});
    const del = ms => { const timer = setTimeout(() => tg.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), ms); timer.unref?.(); };
    let last = 0;
    W.runPost(u, p, (d, tot) => { if (Date.now() - last < 4000 && d < tot) return; last = Date.now(); edit(d === 0 ? `📤 Sending to ${tot - 1} people (most active first)…` : `📤 Delivered to ${d - 1} of ${tot - 1}${d < tot ? ' — your status is already live, the rest follow' : ''}`); })
      .then(r => { edit(`✅ Posted to ${r.count} contacts${r.failed ? ` (${r.failed} skipped)` : ''}${r.tagNotified ? `\n🔔 Tag notifications sent to ${r.tagNotified} people` : ''}`); del(10000); })
      .catch(e => { edit('❌ ' + e.message); del(20000); });
  });
}

// ---------- date / time / repeat ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localNow = () => new Date(Date.now() + CFG.tz * 36e5);
const absFromOffset = o => { const n = localNow(), d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + o)); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
const askDate = (ctx, s) => ask(ctx, s, 'date', `📅 Pick a date, or type it like 25/12 or 25/12/2026\n💡 Your audience is most active around: ${W.bestHours(ctx.from.id)}`, [['Today', 'Tomorrow', 'In 2 days'], ['📆 Pick month & day']]);
const askHour = (ctx, s) => ask(ctx, s, 'hour', '🕒 Hour', [['1', '2', '3', '4'], ['5', '6', '7', '8'], ['9', '10', '11', '12']]);
function askMonth(ctx, s) {
  const n = localNow(), labels = [];
  for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + i, 1)); labels.push(`${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`); }
  return ask(ctx, s, 'dmonth', '📆 Choose the month', chunk(labels, 3));
}
F.dmonth = (ctx, t, s) => { const m = t.match(/^([A-Za-z]{3}) (\d{4})$/), mi = m ? MON.indexOf(m[1]) : -1; if (mi < 0) return; s.dm = { y: +m[2], m: mi }; return askDay(ctx, s); };
function askDay(ctx, s) {
  const { y, m } = s.dm, n = localNow(), dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const first = (y === n.getUTCFullYear() && m === n.getUTCMonth()) ? n.getUTCDate() : 1, labels = [];
  for (let d = first; d <= dim; d++) labels.push(`${d} ${DAYN[new Date(Date.UTC(y, m, d)).getUTCDay()]}`);
  return ask(ctx, s, 'dday', `📆 ${MON[m]} ${y} — choose the day`, chunk(labels, 4));
}
F.dday = (ctx, t, s) => { const d = parseInt(t, 10); if (!s.dm || !(d >= 1 && d <= 31)) return; s.dateAbs = { ...s.dm, d }; return askHour(ctx, s); };
F.date = (ctx, t, s) => {
  const o = { 'Today': 0, 'Tomorrow': 1, 'In 2 days': 2 }[t];
  if (o !== undefined) { s.dateAbs = absFromOffset(o); return askHour(ctx, s); }
  if (t === '📆 Pick month & day') return askMonth(ctx, s);
  const m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/);
  if (!m) return out(ctx, 'Tap a date button, or type a date like 25/12 or 25/12/2026.');
  const n = localNow(), mo = +m[2] - 1, d = +m[1]; let y = m[3] ? +m[3] : n.getUTCFullYear(); if (y < 100) y += 2000;
  if (!m[3] && Date.UTC(y, mo, d) < Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) y++;   // no year given and date passed → next year
  const dt = new Date(Date.UTC(y, mo, d));
  if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return out(ctx, '❌ That date does not exist. Try again.');
  s.dateAbs = { y, m: mo, d }; return askHour(ctx, s);
};
F.hour = (ctx, t, s) => { if (!(+t >= 1 && +t <= 12)) return; s.h = +t; return ask(ctx, s, 'min', 'Minute', [['00', '05', '10', '15'], ['20', '25', '30', '35'], ['40', '45', '50', '55']]); };
F.min = (ctx, t, s) => { if (isNaN(+t)) return; s.m = +t; return ask(ctx, s, 'ap', 'AM or PM?', [['AM', 'PM']]); };
const atOf = s => { const a = s.dateAbs || absFromOffset(0), h = s.h % 12 + (s.ap === 'PM' ? 12 : 0); return Date.UTC(a.y, a.m, a.d, h, s.m) - CFG.tz * 36e5; };
F.ap = (ctx, t, s) => {
  if (!['AM', 'PM'].includes(t)) return; s.ap = t;
  if (atOf(s) < Date.now()) { out(ctx, '⏰ That date and time have already passed — pick again.'); return askDate(ctx, s); }
  if (s.isQ) return ask(ctx, s, 'gap', 'Gap between posts?', [['Every hour', 'Every 6 hours'], ['Every 12 hours', 'Every day']]);
  if (s.only === 'time') return finish(ctx, s);
  return askRep(ctx, s);
};
const askRep = (ctx, s) => ask(ctx, s, 'rep', '🔁 Repeat?', [['No repeat', 'Hourly', 'Daily'], ['Weekly', 'Monthly', 'Specific days']]);
F.rep = (ctx, t, s) => {
  const m = { 'No repeat': 'none', Hourly: 'hourly', Daily: 'daily', Weekly: 'weekly', Monthly: 'monthly' }[t];
  if (t === 'Specific days') { s.days = []; return askDays(ctx, s); } if (!m) return; s.rep = m; s.days = null; return finish(ctx, s);
};
const askDays = (ctx, s) => ask(ctx, s, 'days', 'Tap days to toggle, then Done.', [DAYN.slice(0, 4).map((d, i) => (s.days.includes(i) ? '✅ ' : '') + d), DAYN.slice(4).map((d, i) => (s.days.includes(i + 4) ? '✅ ' : '') + d), ['✔ Done']]);
F.days = (ctx, t, s) => {
  if (t === '✔ Done') { if (!s.days.length) return out(ctx, 'Pick at least one day.'); s.rep = 'days'; return finish(ctx, s); }
  const i = DAYN.indexOf(t.replace('✅ ', '')); if (i < 0) return; s.days = s.days.includes(i) ? s.days.filter(x => x !== i) : [...s.days, i]; return askDays(ctx, s);
};
F.gap = (ctx, t, s) => { const g = { 'Every hour': 1, 'Every 6 hours': 6, 'Every 12 hours': 12, 'Every day': 24 }[t]; if (!g) return; s.gap = g * 36e5; return finish(ctx, s); };
async function finish(ctx, s) {
  const u = ctx.from.id, P = load(u, 'posts', []), at = s.only === 'rep' ? 0 : atOf(s);
  if (s.isMsg) {                                                      // a scheduled MESSAGE, not a status post
    const sg = W.checkSpam(u, s.msg); if (!sg.ok) return out(ctx, `🛡 Spam guard: this message ${esc(sg.reason)}. Edit it and try again.`);
    const M = load(u, 'msgs', []); M.push({ ...s.msg, id: Date.now(), at, repeat: s.rep || 'none', days: s.days || [], status: 'scheduled' });
    for (const x of M) if (x.repeat === 'monthly' && !x.dom) x.dom = new Date(x.at + CFG.tz * 36e5).getUTCDate();
    save(u, 'msgs', M); reset(s); await go(ctx, 'home'); return out(ctx, `✅ Message scheduled for ${esc(fmt(at))}`);
  }
  if (!s.edit) for (const it of (s.isQ ? s.q : [s.p])) { const sg = W.checkSpam(u, it || {}); if (!sg.ok) return out(ctx, `🛡 Spam guard: a post ${esc(sg.reason)}. Edit it and try again.`); }
  if (s.edit) { const p = P.find(x => x.id === s.edit); if (p) { if (s.only !== 'rep') p.at = at; if (s.only !== 'time') { p.repeat = s.rep; p.days = s.days || []; } delete p.dom; p.status = 'scheduled'; p.retry = 0; } }
  else if (s.isQ) s.q.forEach((it, i) => P.push({ ...it, aud: s.p.aud, exclude: s.p.exclude, excludeLists: s.p.excludeLists, excludeGroups: s.p.excludeGroups, id: Date.now() + i, at: at + i * s.gap, repeat: 'none', status: 'scheduled' }));
  else P.push({ ...s.p, id: Date.now(), at, repeat: s.rep || 'none', days: s.days || [], status: 'scheduled' });
  for (const p of P) if (p.repeat === 'monthly' && !p.dom) p.dom = new Date(p.at + CFG.tz * 36e5).getUTCDate();   // keeps 31st → 30th/28th without drifting
  save(u, 'posts', P); const n = s.isQ ? s.q.length : 1; reset(s);
  await go(ctx, 'home'); out(ctx, `✅ ${n} post${n > 1 ? 's' : ''} scheduled${at ? ' from ' + fmt(at) : ''}`);
}

// ---------- menu and text routing ----------
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const userName = u => `+${u}`;
const postLabel = p => `${p.type === 'text' ? p.text : p.caption || p.type}`.replace(/\s+/g, ' ').slice(0, 45) || p.type;
const rowsOf = items => chunk(items, 2);
const isYes = t => ['✅ Yes', 'Yes', 'Confirm'].includes(t);
async function showNumbered(ctx, items, title, step, keep = false) {
  const pages = chunk(items, 20);
  for (let page = 0; page < pages.length; page++) {
    const offset = page * 20;
    const body = pages[page].map((item, i) => `${offset + i + 1}. ${esc(item)}`).join('\n');
    await out(ctx, `<b>${esc(title)} — batch ${page + 1}/${pages.length}</b>\n${body}`, {}, keep);
  }
  return ask(ctx, St(ctx.from.id), step, `Send the number from the ${esc(title.toLowerCase())} list.`);
}
async function outNumberedBatches(ctx, items, title, format = x => x) {
  if (!items.length) return out(ctx, `No ${title.toLowerCase()} found.`);
  const pages = chunk(items, 12);
  for (let page = 0; page < pages.length; page++) {
    const offset = page * 12;
    const body = pages[page].map((item, i) => `${offset + i + 1}. ${format(item)}`).join('\n');
    await out(ctx, `<b>${esc(title)} — batch ${page + 1}/${pages.length}</b>\n${body}`);
  }
}

bot.use((ctx, next) => {                                          // clear any per-chat command list / menu button once per person
  if (ctx.from && ctx.chat?.type === 'private') {
    const s = St(ctx.from.id);
    if (!s.menuCleared) { s.menuCleared = true; tg.callApi('setChatMenuButton', { chat_id: ctx.chat.id, menu_button: { type: 'default' } }).catch(() => {}); tg.callApi('deleteMyCommands', { scope: { type: 'chat', chat_id: ctx.chat.id } }).catch(() => {}); }
  }
  return next();
});
const BUILD = '2026-10-27 · messages · polls · payments · reach-out · session fixes';
let botUser = '';
bot.command('start', async ctx => {
  const u = ctx.from.id, s = St(u), p0 = prof(u);
  const fresh = !p0.refChecked && Date.now() - (p0.created || 0) < 10 * 60e3;       // brand-new person only
  p0.refChecked = true;
  const m = /^ref_([a-z0-9]{1,13})$/i.exec(ctx.startPayload || ''), ref = m ? String(parseInt(m[1], 36)) : null;
  if (fresh && ref && ref !== String(u) && users().includes(ref) && Number(CFG.refDays ?? 7) > 0) {
    p0.referredBy = ref; const rp = prof(ref); rp.refJoined = (rp.refJoined || 0) + 1; save(ref, 'profile', rp);
    hooks.note(ref, '🎉 Someone joined with your referral link. You earn free days when they make their first payment.', true);
  }
  save(u, 'profile', p0);
  reset(s);
  await go(ctx, 'home', false);
  if (!W.linked(u)) await out(ctx, 'Welcome. Link your WhatsApp account to get started.');
});

bot.catch((err, ctx) => {
  console.error(`Telegram update failed${ctx?.from?.id ? ` for ${ctx.from.id}` : ''}:`, err?.message || err);
  if (ctx?.chat) ctx.reply('⚠️ Something went wrong while handling that request. Please try again.').catch(() => {});
});

// ---------- posting extras ----------
A['🗂 Queue many'] = async ctx => {
  if (!(await ready(ctx))) return;
  const s = St(ctx.from.id);
  s.p = { type: 'queue' }; s.q = []; s.isQ = true;
  await ask(ctx, s, 'queue', 'Send the images, videos, or audio clips to queue, one at a time. When finished, choose ✔ Finish queue.', [['✔ Finish queue']]);
};
A['✔ Finish queue'] = async ctx => {
  const s = St(ctx.from.id);
  if (s.step !== 'queue' || !s.q?.length) return out(ctx, 'Add at least one media file before finishing the queue.');
  return askAud(ctx, s);
};

A['📋 My templates'] = ctx => {
  const T = load(ctx.from.id, 'templates', []);
  if (!T.length) return out(ctx, 'No saved templates yet. Compose a post and choose 💾 Save as template.');
  const s = St(ctx.from.id); s.pick = T.map((_, i) => i);
  return ask(ctx, s, 'templatePick', `Choose a template by number:\n${T.map((x, i) => `${i + 1}. ${esc(x.name)}`).join('\n')}`);
};
A['🗑 Delete template'] = ctx => {
  const T = load(ctx.from.id, 'templates', []);
  if (!T.length) return out(ctx, 'There are no templates to delete.');
  const s = St(ctx.from.id); s.pick = T.map((_, i) => i);
  return ask(ctx, s, 'templateDelete', `Choose a template to delete by number:\n${T.map((x, i) => `${i + 1}. ${esc(x.name)}`).join('\n')}`);
};
F.templatePick = (ctx, t, s) => {
  const i = Number.parseInt(t, 10) - 1, T = load(ctx.from.id, 'templates', []);
  if (!Number.isInteger(i) || !T[i]) return out(ctx, 'Send the number of a template in the list.');
  s.p = structuredClone(T[i].p); s.isQ = false;
  return askWhen(ctx, s);
};
F.templateDelete = (ctx, t) => {
  const i = Number.parseInt(t, 10) - 1, T = load(ctx.from.id, 'templates', []);
  if (!Number.isInteger(i) || !T[i]) return out(ctx, 'Send the number of a template in the list.');
  const [removed] = T.splice(i, 1); save(ctx.from.id, 'templates', T);
  return out(ctx, `🗑 Deleted “${esc(removed.name)}”.`);
};

// ---------- schedule menu ----------
const scheduledPosts = u => load(u, 'posts', []).filter(p => p.status === 'scheduled').sort((a, b) => a.at - b.at);
function showPosts(ctx, posts) {
  if (!posts.length) return out(ctx, 'There are no scheduled posts.');
  return out(ctx, posts.slice(0, 30).map((p, i) => `${i + 1}. ${p.at ? esc(fmt(p.at)) : 'Next repeat'} — ${esc(postLabel(p))}`).join('\n'));
}
A['📅 Upcoming'] = ctx => showPosts(ctx, scheduledPosts(ctx.from.id));
A['💡 Best time'] = ctx => out(ctx, `💡 Your audience is most active around ${esc(W.bestHours(ctx.from.id))}.`);
A['✏️ Edit / reschedule'] = ctx => {
  const P = scheduledPosts(ctx.from.id);
  if (!P.length) return out(ctx, 'There are no scheduled posts to edit.');
  const s = St(ctx.from.id); s.pick = P.map(p => p.id); s.intent = 'edit';
  return ask(ctx, s, 'postPick', `Choose a post by number:\n${P.slice(0, 30).map((p, i) => `${i + 1}. ${p.at ? esc(fmt(p.at)) : 'Next repeat'} — ${esc(postLabel(p))}`).join('\n')}`);
};
const parseIdx = (t, max) => {
  const set = new Set();
  for (const tok of t.toLowerCase().split(/[\s,;]+/).filter(Boolean)) {
    if (tok === 'all') { for (let i = 1; i <= max; i++) set.add(i); continue; }
    const m = tok.match(/^(\d+)(?:-(\d+))?$/); if (!m) return null;
    const x = +m[1], y = m[2] ? +m[2] : x;
    for (let i = Math.min(x, y); i <= Math.max(x, y); i++) if (i >= 1 && i <= max) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
};
const postRow = (p, i) => `${i + 1}. ${{ text: '📝', image: '🖼', video: '🎬', audio: '🎵' }[p.type] || '📝'} ${p.at ? esc(fmt(p.at)) : 'Next repeat'}${p.repeat && p.repeat !== 'none' ? ' 🔁' + esc(p.repeat) : ''} — ${esc(postLabel(p))}`;
async function previewPost(ctx, p) {                              // show the actual item being edited
  const s = St(ctx.from.id), info = `🕒 ${esc(fmt(p.at))}${p.repeat && p.repeat !== 'none' ? ' · 🔁 ' + esc(p.repeat) : ''} · 👥 ${esc(String(p.aud || 'all'))}`;
  const body = p.type === 'text' ? `📝 ${esc(p.text || '')}` : esc(p.caption || '');
  let m;
  try {
    if (p.type === 'text') m = await ctx.reply(`${body}\n\n${info}`, { parse_mode: 'HTML' });
    else if (!p.file || !fs.existsSync(p.file)) m = await ctx.reply(`⚠️ The ${p.type} file is missing.\n${body}\n\n${info}`, { parse_mode: 'HTML' });
    else {
      const cap = { caption: `${body}\n\n${info}`.slice(0, 1000), parse_mode: 'HTML' }, src = { source: p.file };
      m = p.type === 'image' ? await ctx.replyWithPhoto(src, cap) : p.type === 'video' ? await ctx.replyWithVideo(src, cap)
        : /\.ogg$/.test(p.file) ? await ctx.replyWithVoice(src, cap) : await ctx.replyWithAudio(src, cap);
    }
  } catch (e) { m = await ctx.reply(`⚠️ Could not show the ${p.type}: ${esc(e.message)}\n${info}`, { parse_mode: 'HTML' }); }
  s.tmp.push(m.message_id);
}
A['🗑 Cancel posts'] = ctx => {
  const P = scheduledPosts(ctx.from.id);
  if (!P.length) return out(ctx, 'There are no scheduled posts to cancel.');
  const s = St(ctx.from.id); s.pick = P.slice(0, 60).map(p => p.id); s.intent = 'cancel';
  return ask(ctx, s, 'postPick', `Send the numbers to cancel — for example <code>1 3 5</code> or <code>2-6</code>, or <code>all</code>:\n\n${P.slice(0, 60).map(postRow).join('\n')}`);
};
A['🧹 Cancel all'] = ctx => ask(ctx, St(ctx.from.id), 'cancelAll', 'Cancel every scheduled post?', [['✅ Yes', 'No']]);
F.postPick = async (ctx, t, s) => {
  const u = ctx.from.id, P = load(u, 'posts', []);
  if (s.intent === 'cancel') {
    const idx = parseIdx(t, s.pick?.length || 0);
    if (!idx?.length) return out(ctx, 'Send numbers like 1 3 5, a range like 2-6, or all.');
    let n = 0; for (const i of idx) { const p = P.find(x => x.id === s.pick[i - 1] && x.status === 'scheduled'); if (p) { p.status = 'cancelled'; n++; } }
    save(u, 'posts', P); reset(s); return out(ctx, `🗑 Cancelled ${n} scheduled post${n === 1 ? '' : 's'}.`);
  }
  const id = s.pick?.[Number.parseInt(t, 10) - 1];
  if (id === undefined) return out(ctx, 'Send a valid post number from the list.');
  const p = P.find(x => x.id === id && x.status === 'scheduled');
  if (!p) return out(ctx, 'That scheduled post is no longer available.');
  s.edit = id; await previewPost(ctx, p);
  return ask(ctx, s, 'editMode', 'What would you like to change?', [['⏰ Change time', '🔁 Change repeat'], ...(p.type === 'audio' ? [] : [['✏️ Edit text/caption']]), ['🗑 Delete this post', '🧹 Cancel all']]);
};
F.editMode = async (ctx, t, s) => {
  const u = ctx.from.id, P = load(u, 'posts', []), p = P.find(x => x.id === s.edit);
  if (!p) { reset(s); return out(ctx, 'That post is no longer available.'); }
  if (t === '⏰ Change time') { s.only = 'time'; return askDate(ctx, s); }
  if (t === '🔁 Change repeat') { s.only = 'rep'; return askRep(ctx, s); }
  if (t === '✏️ Edit text/caption') return ask(ctx, s, 'editText', `Current ${p.type === 'text' ? 'text' : 'caption'}:\n<code>${esc(p.type === 'text' ? p.text : p.caption || '(none)')}</code>\n\nSend the new ${p.type === 'text' ? 'text' : 'caption'}.`);
  if (t === '🗑 Delete this post') { p.status = 'cancelled'; save(u, 'posts', P); reset(s); return out(ctx, '🗑 Post deleted.'); }
  if (t === '🧹 Cancel all') return ask(ctx, s, 'cancelAll', 'Cancel every scheduled post?', [['✅ Yes', 'No']]);
};
F.editText = (ctx, t, s) => {
  const u = ctx.from.id, P = load(u, 'posts', []), p = P.find(x => x.id === s.edit);
  if (!p) { reset(s); return out(ctx, 'That post is no longer available.'); }
  if (p.type === 'text') p.text = t.slice(0, 2000); else p.caption = t.slice(0, 1000);
  save(u, 'posts', P); reset(s); return out(ctx, '✅ Updated.');
};
F.cancelAll = (ctx, t, s) => {
  if (!isYes(t)) { reset(s); return out(ctx, 'No scheduled posts were cancelled.'); }
  const P = load(ctx.from.id, 'posts', []); let n = 0;
  for (const p of P) if (p.status === 'scheduled') { p.status = 'cancelled'; n++; }
  save(ctx.from.id, 'posts', P); reset(s);
  return out(ctx, `🗑 Cancelled ${n} scheduled post${n === 1 ? '' : 's'}.`);
};

// ---------- audience, contacts, lists, and exclusions ----------
const contactsOf = u => load(u, 'contacts', {});
A['👤 Contacts'] = ctx => go(ctx, 'contacts');
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = rows => '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
const nm = (C, n) => (C[n]?.name ? ` (${esc(C[n].name)})` : '');
A['📈 Summary'] = ctx => {
  const E = Object.entries(contactsOf(ctx.from.id)), act = E.filter(([, c]) => !c.out), by = k => act.filter(([, c]) => c.src === k).length;
  return out(ctx, `👤 <b>${act.length} unique contacts</b> — each person counted once, even if they are in several groups\n📒 Phonebook ${by('phonebook')} · 💬 Chats ${by('chat')} · 👁 Viewers ${by('viewer')} · 👪 Group-only ${by('group')}\n👪 In 2+ of your groups: ${act.filter(([, c]) => (c.gc || 0) > 1).length} (most: ${Math.max(0, ...act.map(([, c]) => c.gc || 0))} groups)\n🚫 Removed from audience: ${E.length - act.length}\n\nTap 🧹 Fix duplicates to merge any number stored twice.`);
};
A['👁 Who views me'] = async ctx => {
  const u = ctx.from.id, C = contactsOf(u), V = load(u, 'views', { log: [] }), H = load(u, 'history', []);
  const list = Object.entries(C).filter(([, c]) => c.v > 0).sort((a, b) => b[1].v - a[1].v);
  if (!list.length) return out(ctx, '👁 No status views recorded yet.\nViews are saved when someone opens a status you posted through this bot, and only if they have read receipts on.');
  const last = {}; for (let i = V.log.length - 1; i >= 0; i--) if (!(V.log[i].who in last)) last[V.log[i].who] = V.log[i];
  const post = n => { const h = H.find(x => x.id === last[n]?.post); return h ? h.preview : ''; };
  await out(ctx, `👁 <b>${list.length} people</b> opened your status posts (read receipts on). This is status views, not chat views.\n\n` + list.slice(0, 15).map(([n, c], i) => `${i + 1}. +${n}${nm(C, n)} — ${c.v}× · last ${esc(fmt(c.lastView))}${post(n) ? ` · “${esc(post(n))}”` : ''}`).join('\n') + (list.length > 15 ? `\n\n…full list in the file ↓` : ''), {}, true);
  return doc(ctx, toCsv([['Phone', 'Name', 'Views', 'Last viewed', 'Last post'], ...list.map(([n, c]) => ['+' + n, c.name || '', c.v, fmt(c.lastView), post(n)])]), 'status-viewers.csv');
};
A['👁 Post viewers'] = ctx => {
  const u = ctx.from.id, H = load(u, 'history', []).slice(-10).reverse(), s = St(u);
  if (!H.length) return out(ctx, 'No posts yet.');
  s.postList = H.map(h => h.id);
  out(ctx, H.map((h, i) => `${i + 1}. ${esc(fmt(h.at))} — “${esc(h.preview)}” — ${h.viewers?.length || 0} views`).join('\n'), {}, true);
  return ask(ctx, s, 'postViewers', 'Send the post number to see who viewed it.');
};
F.postViewers = async (ctx, t, s) => {
  const u = ctx.from.id, h = load(u, 'history', []).find(x => x.id === s.postList?.[+t - 1]); if (!h) return out(ctx, 'Invalid number.');
  const C = contactsOf(u), v = h.viewers || []; reset(s);
  await out(ctx, `👁 “${esc(h.preview)}” — ${v.length} viewers\n` + (v.slice(0, 40).map(n => `+${n}${nm(C, n)}`).join('\n') || 'Nobody yet.'), {}, true);
  if (v.length) return doc(ctx, toCsv([['Phone', 'Name'], ...v.map(n => ['+' + n, C[n]?.name || ''])]), 'post-viewers.csv');
};
A['😴 Inactive 6m'] = async ctx => {
  const u = ctx.from.id, r = W.inactiveReport(u), C = contactsOf(u), s = St(u);
  if (!r.ok) return out(ctx, `😴 <b>Not enough data yet</b>\n\n“Inactive” means: no status view recorded for 6 months. The bot only learns views from read receipts on posts you send through it, so it needs 183 days of tracking and at least 10 posts in that time. Otherwise real viewers would be wrongly listed.\n\nTracking: ${r.tracked} days · Posts in the last 6 months: ${r.posts}\n\nNote: people who turned read receipts off never appear as viewers.`, {}, true);
  if (!r.list.length) return out(ctx, '✅ Everyone has viewed at least one post in the last 6 months.');
  await out(ctx, `😴 <b>${r.list.length} contacts</b> were added over 6 months ago and have not viewed any of your status posts since (based on read receipts — people with receipts off look inactive).`, {}, true);
  await doc(ctx, toCsv([['Phone', 'Name', 'Total views', 'Last viewed'], ...r.list.map(n => ['+' + n, C[n]?.name || '', C[n]?.v || 0, C[n]?.lastView ? fmt(C[n].lastView) : 'never'])]), 'inactive-contacts.csv');
  return ask(ctx, s, 'pruneAsk', 'Remove them from your posting audience? (They stay saved, they just stop receiving posts.)', [['✅ Yes', 'No']]);
};
F.pruneAsk = (ctx, t, s) => { if (!isYes(t)) { reset(s); return out(ctx, 'Nobody was removed.'); } const n = W.prune(ctx.from.id); reset(s); return out(ctx, `🧹 Removed ${n} contacts from your audience.`); };
A['📤 Export numbers'] = async ctx => {
  const C = contactsOf(ctx.from.id), E = Object.entries(C).filter(([n]) => /^\d{7,15}$/.test(n));   // unique by number
  if (!E.length) return out(ctx, 'No contacts yet.');
  await doc(ctx, toCsv([['Name', 'Phone', 'Source', 'Groups in', 'Status views', 'In audience'], ...E.map(([n, c]) => [c.name || '', '+' + n, c.src || '', c.gc || 0, c.v || 0, c.out ? 'no' : 'yes'])]), 'contacts.csv');
  await doc(ctx, E.map(([n, c]) => `BEGIN:VCARD\nVERSION:3.0\nFN:${(c.name || '+' + n).replace(/[\r\n]/g, ' ')}\nTEL;TYPE=CELL:+${n}\nEND:VCARD`).join('\n'), 'contacts.vcf');
  return out(ctx, `📤 ${E.length} unique contacts, real phone numbers.\n• contacts.csv opens in Excel or Sheets\n• contacts.vcf imports straight into your phone contacts`, {}, true);
};
A['🧹 Fix duplicates'] = async ctx => {
  await out(ctx, '⏳ Merging duplicates…');
  const r = await W.cleanContacts(ctx.from.id);
  return out(ctx, `✅ Merged ${r.merged} duplicate entr${r.merged === 1 ? 'y' : 'ies'} and removed ${r.removed} invalid number${r.removed === 1 ? '' : 's'}.`);
};
A['🏷 Lists'] = ctx => go(ctx, 'lists');
A['➕ New list'] = ctx => ask(ctx, St(ctx.from.id), 'listName', 'Send a name for the new list (up to 40 characters).');
F.listName = (ctx, t, s) => {
  const name = t.trim().slice(0, 40), L = load(ctx.from.id, 'lists', {});
  if (!name) return out(ctx, 'List names cannot be empty.');
  if (Object.hasOwn(L, name)) return out(ctx, 'A list with that name already exists.');
  L[name] = []; save(ctx.from.id, 'lists', L); reset(s);
  return out(ctx, `✅ Created list “${esc(name)}”.`);
};
A['➕ Add numbers'] = ctx => {
  const L = load(ctx.from.id, 'lists', {}), names = Object.keys(L);
  if (!names.length) return out(ctx, 'Create a list first.');
  return ask(ctx, St(ctx.from.id), 'listTarget', 'Choose the list to add numbers to:', rowsOf(names));
};
F.listTarget = (ctx, t, s) => {
  const L = load(ctx.from.id, 'lists', {});
  if (!Object.hasOwn(L, t)) return out(ctx, 'Choose a list name from the menu.');
  s.listName = t; return ask(ctx, s, 'listNumbers', `Send numbers to add to “${esc(t)}” (separated by spaces, commas, or new lines).`);
};
F.listNumbers = (ctx, t, s) => {
  const L = load(ctx.from.id, 'lists', {}), ns = nums(t);
  if (!s.listName || !Object.hasOwn(L, s.listName)) { reset(s); return out(ctx, 'That list is no longer available.'); }
  if (!ns.length) return out(ctx, 'No valid phone numbers found. Include country codes and try again.');
  L[s.listName] = [...new Set([...L[s.listName], ...ns])]; save(ctx.from.id, 'lists', L); reset(s);
  return out(ctx, `✅ Added ${ns.length} number${ns.length === 1 ? '' : 's'}.`);
};
A['📖 View lists'] = ctx => {
  const L = load(ctx.from.id, 'lists', {}), names = Object.keys(L);
  return out(ctx, names.length ? names.map(n => `• ${esc(n)} — ${L[n].length} numbers`).join('\n') : 'No lists yet.');
};
A['🗑 Delete list'] = ctx => {
  const names = Object.keys(load(ctx.from.id, 'lists', {}));
  if (!names.length) return out(ctx, 'There are no lists to delete.');
  return ask(ctx, St(ctx.from.id), 'listDeletePick', 'Choose the list to delete:', rowsOf(names));
};
F.listDeletePick = (ctx, t, s) => {
  if (!Object.hasOwn(load(ctx.from.id, 'lists', {}), t)) return out(ctx, 'Choose a list name from the menu.');
  s.listName = t;
  return ask(ctx, s, 'listDeleteConfirm', `Delete “${esc(t)}” and its saved numbers?`, [['✅ Yes', 'No']]);
};
F.listDeleteConfirm = (ctx, t, s) => {
  if (isYes(t)) { const L = load(ctx.from.id, 'lists', {}); delete L[s.listName]; save(ctx.from.id, 'lists', L); }
  const deleted = isYes(t); reset(s);
  return out(ctx, deleted ? '🗑 List deleted.' : 'No list was deleted.');
};
A['🚫 Exclusions'] = ctx => go(ctx, 'excl');
A['➕ Exclude number'] = ctx => ask(ctx, St(ctx.from.id), 'excludeAdd', 'Send the phone numbers to exclude.');
F.excludeAdd = (ctx, t, s) => {
  const ns = nums(t), E = load(ctx.from.id, 'exclude', []);
  if (!ns.length) return out(ctx, 'No valid phone numbers found.');
  save(ctx.from.id, 'exclude', [...new Set([...E, ...ns])]); reset(s);
  return out(ctx, `✅ Excluded ${ns.length} number${ns.length === 1 ? '' : 's'}.`);
};
A['➖ Un-exclude'] = ctx => ask(ctx, St(ctx.from.id), 'excludeRemove', 'Send the phone numbers to remove from exclusions.');
F.excludeRemove = (ctx, t, s) => {
  const ns = new Set(nums(t)), E = load(ctx.from.id, 'exclude', []), next = E.filter(n => !ns.has(n));
  save(ctx.from.id, 'exclude', next); reset(s);
  return out(ctx, `✅ Removed ${E.length - next.length} number${E.length - next.length === 1 ? '' : 's'} from exclusions.`);
};
A['📖 View excluded'] = ctx => {
  const E = load(ctx.from.id, 'exclude', []);
  return out(ctx, E.length ? E.map(phone).join('\n') : 'No excluded numbers.');
};
A['👪 Groups & links'] = ctx => go(ctx, 'groups');
const groupRows = u => Object.entries(load(u, 'groups', {})).map(([id, g]) => ({ id, ...g }));
const quiet = g => !g.subject || !g.lastMsg || g.lastMsg < Date.now() - 45 * 864e5;
const gLine = g => `${esc(g.subject || '(no name)')} · ${g.size || 0} members${g.role === 'admin' ? ' · you admin' : ''}\n${g.link ? g.link : 'no link (only admins can fetch it — open the group by name in WhatsApp)'}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function sendBatches(ctx, header, lines, cap = 30) {           // as many lines as fit in each Telegram message
  const MAX = 3800, msgs = []; let buf = header ? header + '\n\n' : '';
  for (const l of lines) { if (buf.length + l.length + 1 > MAX && buf.trim()) { msgs.push(buf); buf = ''; } buf += l + '\n'; }
  if (buf.trim()) msgs.push(buf);
  const shown = msgs.slice(0, cap);
  for (let i = 0; i < shown.length; i++) {
    const m = await ctx.reply((shown.length > 1 ? `(${i + 1}/${msgs.length})\n` : '') + shown[i], { parse_mode: 'HTML', disable_web_page_preview: true, ...keyboardFor(ctx.from.id) });
    const tm = setTimeout(() => tg.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 20 * 60e3); tm.unref?.();
    if (i < shown.length - 1) await wait(350);
  }
  if (msgs.length > cap) await out(ctx, `…${msgs.length - cap} more message${msgs.length - cap === 1 ? '' : 's'} not shown (limit ${cap}).`);
  return msgs.length;
}
A['📖 My groups'] = async ctx => {
  const G = groupRows(ctx.from.id); if (!G.length) return out(ctx, 'No groups yet — tap 🔄 Refresh groups.');
  const rows = [...G].sort((a, b) => (quiet(b) - quiet(a)) || (a.lastMsg || 0) - (b.lastMsg || 0));
  return sendBatches(ctx, `👪 <b>${G.length} groups</b> · ${G.filter(g => g.role === 'admin').length} you admin · ${G.filter(g => g.link).length} with links · ${G.filter(quiet).length} quiet or unnamed (shown first)`, rows.map((g, i) => `${i + 1}. ${gLine(g)}\n`));
};
A['😴 Quiet groups'] = ctx => {
  const u = ctx.from.id, G = groupRows(u).filter(quiet).sort((a, b) => (a.lastMsg || 0) - (b.lastMsg || 0));
  if (!G.length) return out(ctx, '✅ All your groups have had recent messages.');
  const days = Math.floor((Date.now() - (prof(u).created || Date.now())) / 864e5);
  return sendBatches(ctx, `😴 <b>${G.length} quiet or unnamed groups</b> (no message seen in 45 days; the bot has been watching ${days} day${days === 1 ? '' : 's'})`, G.map((g, i) => `${i + 1}. ${gLine(g)}\n`));
};
A['🔄 Refresh groups'] = async ctx => {
  if (!(await ready(ctx))) return;
  try { const n = await W.refreshGroups(ctx.from.id); return out(ctx, `✅ Refreshed ${n} group${n === 1 ? '' : 's'}.`); }
  catch { return out(ctx, '❌ WhatsApp is not connected. Repair or link your session first.'); }
};
A['🔗 Group links'] = ctx => {
  const G = load(ctx.from.id, 'groups', {}), byUrl = new Map();
  for (const g of Object.values(G)) if (g.link) byUrl.set(g.link, `${g.subject || 'Group'} — ${g.link}`);
  for (const item of Object.values(load(ctx.from.id, 'links_seen', {}))) if (item.url && !byUrl.has(item.url)) byUrl.set(item.url, item.url);
  return outNumberedBatches(ctx, [...byUrl.values()], 'Group links', esc);
};
A['🧹 Clean dead links'] = async ctx => {
  if (!(await ready(ctx))) return;
  try {
    const n = await W.checkLinks(ctx.from.id);
    return out(ctx, n
      ? `✅ Found ${n} dead link${n === 1 ? '' : 's'} and moved ${n === 1 ? 'it' : 'them'} to 🧾 Review dead links. Nothing was permanently deleted.`
      : '✅ No dead links found. Saved links were left unchanged.');
  }
  catch { return out(ctx, '❌ Could not check links while WhatsApp is disconnected.'); }
};
A['🧾 Review dead links'] = async ctx => {
  const dead = load(ctx.from.id, 'dead_links', {});
  const entries = Object.entries(dead).sort((a, b) => (a[1].detectedAt || 0) - (b[1].detectedAt || 0));
  if (!entries.length) return out(ctx, 'No dead links are waiting for review.');
  const s = St(ctx.from.id); s.deadLinkKeys = entries.map(([key]) => key);
  const rows = entries.map(([key, item]) => {
    const where = item.groupName ? ` — ${item.groupName}` : '';
    return `${item.url || `https://chat.whatsapp.com/${key}`}${where}`;
  });
  for (let i = 0; i < rows.length; i += 12) {
    await out(ctx, `<b>Dead links for review — batch ${Math.floor(i / 12) + 1}/${Math.ceil(rows.length / 12)}</b>\n${rows.slice(i, i + 12).map((line, j) => `${i + j + 1}. ${esc(line)}`).join('\n')}`, {}, true);
  }
  return ask(ctx, s, 'deadLinkDeletePick', 'Send a number to open a dead link for review. It will stay here until you confirm permanent deletion.');
};
F.deadLinkDeletePick = (ctx, t, s) => {
  const key = s.deadLinkKeys?.[Number(t) - 1], item = key && load(ctx.from.id, 'dead_links', {})[key];
  if (!item) return out(ctx, 'That number is not available. Open 🧾 Review dead links again and choose a current entry.');
  s.deadLinkKey = key;
  return ask(ctx, s, 'deadLinkDeleteConfirm', `Review this link before deleting it:\n${esc(item.url || `https://chat.whatsapp.com/${key}`)}\n\nPermanently delete this saved dead-link record?`, [['🗑 Permanently delete', 'Keep it']]);
};
F.deadLinkDeleteConfirm = (ctx, t, s) => {
  if (t !== '🗑 Permanently delete') { reset(s); return out(ctx, 'The dead link is still saved for review.'); }
  const dead = load(ctx.from.id, 'dead_links', {});
  if (!s.deadLinkKey || !Object.hasOwn(dead, s.deadLinkKey)) { reset(s); return out(ctx, 'That link was already removed.'); }
  delete dead[s.deadLinkKey]; save(ctx.from.id, 'dead_links', dead); reset(s);
  return out(ctx, '🗑 Dead-link record permanently deleted.');
};
A['🏷 Tag settings'] = ctx => go(ctx, 'tagset');
A['🔢 Tag count'] = ctx => ask(ctx, St(ctx.from.id), 'tagCount', `Current tag count: ${prof(ctx.from.id).tagN}. Send a number from 1 to 20.`);
F.tagCount = (ctx, t, s) => {
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 20) return out(ctx, 'Choose a whole number from 1 to 20.');
  const p = prof(ctx.from.id); p.tagN = n; save(ctx.from.id, 'profile', p); reset(s);
  return out(ctx, `✅ Tag count set to ${n}.`);
};
A['🔀 Tag mode'] = ctx => ask(ctx, St(ctx.from.id), 'tagMode', 'Choose how contacts are selected for tags:', [['Shuffle', 'Prefer new'], ['Most viewed']]);
F.tagMode = (ctx, t, s) => {
  const mode = { Shuffle: 'shuffle', 'Prefer new': 'new', 'Most viewed': 'viewed' }[t];
  if (!mode) return;
  const p = prof(ctx.from.id); p.tagMode = mode; save(ctx.from.id, 'profile', p); reset(s);
  return out(ctx, '✅ Tag selection mode updated.');
};

// ---------- insights and billing ----------
A['📊 Insights'] = ctx => go(ctx, 'insights');
A['📈 Stats'] = ctx => {
  const u = ctx.from.id, P = load(u, 'history', []), V = load(u, 'views', { log: [] }).log;
  const since = Date.now() - 7 * 864e5, posts = P.filter(p => p.at >= since);
  const views = V.filter(v => v.t >= since).length;
  return out(ctx, `📊 <b>Last 7 days</b>\n📤 Posts: ${posts.length}\n👁 Views: ${views}\n👥 Contacts: ${Object.keys(contactsOf(u)).length}\n⏰ Best hours: ${esc(W.bestHours(u))}`);
};
A['⏰ Best hours'] = ctx => out(ctx, `⏰ Best hours: ${esc(W.bestHours(ctx.from.id))}`);
A['🏆 Best posts'] = ctx => {
  const posts = [...load(ctx.from.id, 'history', [])].sort((a, b) => (b.viewers?.length || 0) - (a.viewers?.length || 0)).slice(0, 10);
  return out(ctx, posts.length ? posts.map((p, i) => `${i + 1}. ${esc(p.preview || p.type || 'Status')} — ${p.viewers?.length || 0} views`).join('\n') : 'No posts have been recorded yet.');
};
A['📰 Weekly report'] = ctx => out(ctx, W.report(ctx.from.id));
A['💳 Plan'] = ctx => go(ctx, 'plan');
A['📄 My plan'] = ctx => {
  const p = prof(ctx.from.id);
  const status = p.paused ? 'Paused' : W.expired(p) ? 'Expired' : 'Active';
  return out(ctx, `💳 <b>Plan status:</b> ${status}\n🛒 Plan: ${esc(p.plan || '—')}\n📆 Expires: ${p.expires ? esc(fmt(p.expires)) : 'No expiry'}\n📤 Daily limit: ${p.limit}\n📊 Posts today: ${p.sent?.n || 0}`);
};
A['💳 Pay'] = ctx => {
  const bits = [];
  if (CFG.payLink) bits.push(`Payment link: ${esc(CFG.payLink)}`);
  if (CFG.bank) bits.push(`Bank details:\n${esc(CFG.bank)}`);
  return out(ctx, bits.length ? `${bits.join('\n\n')}\n\nAfter paying, choose 🧾 Send receipt.` : 'Payment instructions are not configured yet.');
};
const plans = () => load('_g', 'plans', []);
const planBtn = p => `🛒 ${p.name} · ${p.price} · ${p.days}d`;
A['🛒 Choose a plan'] = ctx => {
  const list = plans();
  if (!list.length) return A['💳 Pay'](ctx);                       // no plans configured: fall back to the general payment details
  return ask(ctx, St(ctx.from.id), 'planPick', 'Choose the plan you want:', list.map(p => [planBtn(p)]));
};
async function startPay(ctx, s, p) {
  const u = ctx.from.id, pf = prof(u);
  if (!pf.email) return ask(ctx, s, 'payEmail', '📧 Send your email address for the payment receipt (asked only once).');
  try {
    const r = await W.startOnlinePayment(u, p, pf.email), bank = p.bank || CFG.bank;
    await out(ctx, `💳 <b>${esc(p.name)}</b> — ${esc(p.price)} · ${p.days} days\n\n🔗 <a href="${esc(r.url)}">Pay securely online</a>\n\nPayment is confirmed automatically within about a minute — no receipt needed. This link works for 3 hours.${bank ? `\n\n🏦 Prefer a bank transfer?\n${esc(bank)}\nThen open 🧾 Send receipt.` : ''}`, { disable_web_page_preview: true }, true);
    reset(s); return go(ctx, 'plan', false, true);
  } catch (e) { return out(ctx, `❌ ${esc(e.message)}`); }
}
F.payEmail = (ctx, t, s) => {
  const em = t.trim().toLowerCase(), p = plans().find(x => x.id === s.payPlan);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return out(ctx, 'Send a valid email address.');
  const pf = prof(ctx.from.id); pf.email = em; save(ctx.from.id, 'profile', pf);
  if (!p) { reset(s); return out(ctx, 'Please choose the plan again.'); }
  return startPay(ctx, s, p);
};
F.planPick = async (ctx, t, s) => {
  const p = plans().find(x => planBtn(x) === t); if (!p) return out(ctx, 'Tap one of the plans shown.');
  const pf = prof(ctx.from.id); pf.pendingPlan = p.id; save(ctx.from.id, 'profile', pf);
  if (W.onlinePayOn() && W.parsePrice(p.price)) { s.payPlan = p.id; return startPay(ctx, s, p); }
  const link = p.link || CFG.payLink, bank = p.bank || CFG.bank;
  const lines = [`🛒 <b>${esc(p.name)}</b>`, `💰 Price: ${esc(p.price)}`, `📆 Duration: ${p.days} days`];
  if (link) lines.push(`\n🔗 Pay here: ${esc(link)}`);
  if (bank) lines.push(`\n🏦 Bank / payment details:\n${esc(bank)}`);
  lines.push('\nAfter paying, open 🧾 Send receipt and upload your screenshot.');
  await out(ctx, lines.join('\n'), {}, true); reset(s); return go(ctx, 'plan', false, true);
};
A['🧾 Send receipt'] = ctx => {
  if (plans().length && !plans().some(x => x.id === prof(ctx.from.id).pendingPlan)) return out(ctx, 'Please choose a plan first: 🛒 Choose a plan.');
  return ask(ctx, St(ctx.from.id), 'receipt', 'Send a screenshot or document of your payment receipt.');
};
async function receipt(ctx) {
  const admins = W.adminList(); if (!admins.length) return out(ctx, 'Receipts cannot be reviewed because no admin is configured.');
  const u = ctx.from.id, plan = plans().find(x => x.id === prof(u).pendingPlan);
  const pending = load('_g', 'pending_payments', []);
  pending.push({ uid: u, at: Date.now(), status: 'pending', planId: plan?.id, planName: plan?.name, days: plan?.days, price: plan?.price }); save('_g', 'pending_payments', pending);
  let sent = 0;
  for (const a of admins) {
    try {
      await tg.forwardMessage(a, ctx.chat.id, ctx.message.message_id);
      await tg.sendMessage(a, `🧾 Receipt from ${u}${plan ? ` for <b>${esc(plan.name)}</b> (${esc(plan.price)}, ${plan.days} days)` : ''}. Use Admin → Payments to review.`, { parse_mode: 'HTML' });
      sent++;
    } catch {}
  }
  if (!sent) { pending.pop(); save('_g', 'pending_payments', pending); return out(ctx, '❌ Could not forward the receipt. Please try again.'); }
  reset(St(u)); return out(ctx, '✅ Receipt sent to the admin for review.', {}, true);
}
A['📩 Inbox'] = ctx => go(ctx, 'inbox');
A['📌 Notices'] = ctx => {
  const notices = load('_g', 'notices', []);
  return out(ctx, notices.length ? notices.slice(-10).reverse().map(n => `• ${esc(n.text)}`).join('\n\n') : 'No notices right now.');
};
A['✉️ Message admin'] = ctx => ask(ctx, St(ctx.from.id), 'msgadm', 'Send your message to the admin.');
async function msgAdmin(ctx, text = ctx.message?.text) {
  if (!CFG.admin) { reset(St(ctx.from.id)); return out(ctx, 'There is no admin contact configured.'); }
  const message = String(text || '').trim();
  if (!message) return out(ctx, 'Please send a non-empty message.');
  const inbox = load('_g', 'admin_inbox', []);
  inbox.push({ uid: ctx.from.id, text: message.slice(0, 4000), at: Date.now(), replied: false });
  save('_g', 'admin_inbox', inbox);
  try { await tg.sendMessage(CFG.admin, `✉️ Message from ${ctx.from.id}:\n${esc(message.slice(0, 4000))}`, { parse_mode: 'HTML' }); }
  catch { return out(ctx, '⚠️ Your message was saved, but the admin could not be notified right now.'); }
  reset(St(ctx.from.id));
  return out(ctx, '✅ Your message was sent to the admin.');
}
F.msgadm = (ctx, t) => msgAdmin(ctx, t);

// ---------- account controls ----------
A['⚙️ Account'] = ctx => go(ctx, 'account');
A['ℹ️ Status'] = ctx => {
  const u = ctx.from.id, p = prof(u);
  return out(ctx, `⚙️ <b>Account status</b>\nWhatsApp: ${W.linked(u) ? (W.isUp(u) ? 'Connected' : 'Linked, reconnecting') : 'Not linked'}\nPlan: ${p.paused ? 'Paused' : W.expired(p) ? 'Expired' : 'Active'}\nAlerts: ${p.alerts ? 'On' : 'Off'}\nWeekly report: ${p.weekly ? 'On' : 'Off'}\nAuto-prune: ${p.autoPrune ? 'On' : 'Off'}\n\n🩺 <b>Session health</b>\n${esc(W.healthSummary(ctx.from.id))}`);
};
for (const [label, key, title] of [['🔔 Toggle alerts', 'alerts', 'Alerts'], ['📰 Toggle weekly report', 'weekly', 'Weekly report'], ['🧹 Toggle auto-prune', 'autoPrune', 'Auto-prune']]) {
  A[label] = ctx => {
    const p = prof(ctx.from.id); p[key] = !p[key]; save(ctx.from.id, 'profile', p);
    return out(ctx, `${title} ${p[key] ? 'enabled' : 'disabled'}.`);
  };
}
A['🧽 Repair session'] = async ctx => {
  const u = ctx.from.id;
  if (!W.linked(u)) return out(ctx, 'No linked WhatsApp session was found. Choose 📲 Link WhatsApp to connect.');
  try { const n = await W.repairSession(u); return out(ctx, `🧽 Repaired (${n} stale session files cleared). Reconnecting…`); }
  catch { return out(ctx, '❌ Could not repair the WhatsApp session. Try linking again.'); }
};
A['🔌 Unlink'] = ctx => ask(ctx, St(ctx.from.id), 'unlinkConfirm', 'Unlink WhatsApp from this account?', [['✅ Yes', 'No']]);
F.unlinkConfirm = async (ctx, t, s) => {
  if (!isYes(t)) { reset(s); return out(ctx, 'Your WhatsApp session remains linked.'); }
  await W.unlink(ctx.from.id); reset(s); return go(ctx, 'home', false);
};
A['🗑 Delete account'] = ctx => ask(ctx, St(ctx.from.id), 'deleteConfirm', 'Delete this account and move its saved data to the deleted-accounts archive?', [['✅ Yes', 'No']]);
F.deleteConfirm = async (ctx, t, s) => {
  if (!isYes(t)) { reset(s); return out(ctx, 'Your account was not deleted.'); }
  const u = ctx.from.id;
  await W.unlink(u); W.dropUser(u); delete ST[u];
  await out(ctx, 'Your account data has been removed from active users.');
};

// ---------- admin menus and actions ----------
const requireAdmin = ctx => {
  if (isAdm(ctx.from.id)) return true;
  out(ctx, 'This action is available to admins only.');
  return false;
};
// ---------- admin: polls and broadcasts your users can react to ----------
const withRetry = async fn => { try { return await fn(); } catch (e) { const ra = e?.response?.parameters?.retry_after; if (ra) { await wait((ra + 1) * 1000); return fn(); } throw e; } };
async function fanOut(ctx, uids, fn, label) {                       // ~22 messages a second, safely under Telegram's limit, with live progress
  const m = await ctx.reply(`⏳ ${label}… 0 of ${uids.length}`), edit = x => tg.editMessageText(ctx.chat.id, m.message_id, undefined, x, { parse_mode: 'HTML' }).catch(() => {});
  let ok = 0, fail = 0, last = Date.now();
  for (const uid of uids) {
    try { await withRetry(() => fn(uid)); ok++; } catch { fail++; }
    if (Date.now() - last > 4000) { last = Date.now(); edit(`⏳ ${label}… ${ok + fail} of ${uids.length}`); }
    await wait(45);
  }
  edit(`✅ ${label}: ${ok} delivered${fail ? `, ${fail} could not be reached (blocked or deleted the bot)` : ''}.`);
  const tm = setTimeout(() => tg.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 90000); tm.unref?.();
  return { ok, fail };
}
const audienceOf = kind => users().filter(u => kind === 'active' ? (!W.expired(prof(u)) && !prof(u).paused) : kind === 'live' ? W.isUp(u) : true);
const newCampaign = (ctx, o) => ({ id: Date.now(), at: Date.now(), by: ctx.from.id, sent: 0, failed: 0, closed: false, msgs: {}, pollIds: {}, votes: {}, counts: {}, totals: {}, reacts: {}, ...o });
async function runCampaign(ctx, c, uids) {
  const L = campaigns(); L.push(c); save('_g', 'campaigns', L.slice(-20));
  const r = await fanOut(ctx, uids, async uid => {
    const m = c.kind === 'poll' ? await tg.sendPoll(uid, c.question, c.options, { is_anonymous: c.anonymous, allows_multiple_answers: c.multi }) : await tg.sendMessage(uid, c.text);
    c.msgs[uid] = m.message_id; if (m.poll) c.pollIds[m.poll.id] = uid;
  }, c.kind === 'poll' ? 'Sending the poll' : 'Sending the broadcast');
  c.sent = r.ok; c.failed = r.fail; save('_g', 'campaigns', campaigns());
  W.logActivity(ctx.from.id, c.kind === 'poll' ? 'poll-sent' : 'broadcast', c.id, `${r.ok} users`);
}
A['🗳 New poll'] = ctx => { if (!requireAdmin(ctx)) return; const s = St(ctx.from.id); s.poll = {}; return ask(ctx, s, 'pollQ', '🗳 Send the poll question (up to 300 characters).'); };
F.pollQ = (ctx, t, s) => { s.poll.question = t.trim().slice(0, 300); return ask(ctx, s, 'pollOpts', 'Send the options, one per line (2 to 10, up to 100 characters each).'); };
F.pollOpts = (ctx, t, s) => { const o = t.split('\n').map(x => x.trim().slice(0, 100)).filter(Boolean); if (o.length < 2 || o.length > 10) return out(ctx, 'Send between 2 and 10 options, one per line.'); s.poll.options = o; return ask(ctx, s, 'pollAnon', 'Should you see who voted?', [['👤 Show who voted', '🕶 Anonymous']]); };
F.pollAnon = (ctx, t, s) => { if (!['👤 Show who voted', '🕶 Anonymous'].includes(t)) return; s.poll.anonymous = t === '🕶 Anonymous'; return ask(ctx, s, 'pollMulti', 'One answer or several?', [['☝️ One answer', '✅ Several answers']]); };
F.pollMulti = (ctx, t, s) => { if (!['☝️ One answer', '✅ Several answers'].includes(t)) return; s.poll.multi = t === '✅ Several answers'; return ask(ctx, s, 'pollAud', 'Who should receive it?', [['👥 Everyone', '✅ Active plans'], ['🟢 Connected now']]); };
F.pollAud = (ctx, t, s) => {
  const k = { '👥 Everyone': 'all', '✅ Active plans': 'active', '🟢 Connected now': 'live' }[t]; if (!k) return;
  s.poll.aud = k; const p = s.poll;
  return ask(ctx, s, 'pollGo', `🗳 <b>${esc(p.question)}</b>\n${p.options.map((o, n) => `${n + 1}. ${esc(o)}`).join('\n')}\n\n${p.anonymous ? '🕶 Anonymous' : '👤 You can see who voted'} · ${p.multi ? 'several answers' : 'one answer'} · ${audienceOf(k).length} recipients`, [['🚀 Send poll', 'Cancel']]);
};
F.pollGo = async (ctx, t, s) => {
  const p = s.poll; if (t !== '🚀 Send poll' || !p) { s.poll = null; reset(s); return out(ctx, 'Poll cancelled.'); }
  const uids = audienceOf(p.aud); s.poll = null; reset(s); await go(ctx, cur(s), false, true);
  void runCampaign(ctx, newCampaign(ctx, { kind: 'poll', question: p.question, options: p.options, anonymous: p.anonymous, multi: p.multi, aud: p.aud }), uids);
};
const bar = (n, total) => { const p = total ? Math.round(100 * n / total) : 0, f = Math.round(p / 10); return `${'▓'.repeat(f)}${'░'.repeat(10 - f)} ${p}% (${n})`; };
const reactTally = c => { const t = {}; for (const list of Object.values(c.reacts || {})) for (const e of list) t[e] = (t[e] || 0) + 1; return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(' · ') || 'none yet'; };
function pollTally(c) {
  const k = c.options.length, counts = Array(k).fill(0);
  if (!c.anonymous) { for (const v of Object.values(c.votes || {})) for (const n of v) if (n < k) counts[n]++; return { counts, voters: Object.keys(c.votes || {}).length }; }
  for (const arr of Object.values(c.counts || {})) arr.forEach((n, x) => { if (x < k) counts[x] += n; });
  return { counts, voters: Object.values(c.totals || {}).reduce((a, b) => a + b, 0) };
}
function campaignReport(c) {
  const head = `${c.kind === 'poll' ? '🗳' : '📢'} <b>${esc(c.kind === 'poll' ? c.question : String(c.text).slice(0, 80))}</b>\n${esc(fmt(c.at))} · delivered ${c.sent}${c.failed ? ` · failed ${c.failed}` : ''}${c.closed ? ' · 🔒 closed' : ''}`;
  if (c.kind !== 'poll') return `${head}\n\n❤️ Reactions: ${esc(reactTally(c))}`;
  const { counts, voters } = pollTally(c);
  return `${head}\n\n${c.options.map((o, n) => `${esc(o)}\n${bar(counts[n], voters)}`).join('\n\n')}\n\n👥 Voted: ${voters} of ${c.sent} (${c.sent ? Math.round(100 * voters / c.sent) : 0}%)\n❤️ Reactions: ${esc(reactTally(c))}`;
}
A['📊 Results'] = ctx => {
  if (!requireAdmin(ctx)) return; const L = campaigns().slice(-10).reverse(); if (!L.length) return out(ctx, 'No polls or broadcasts yet.');
  const s = St(ctx.from.id); s.campList = L.map(c => c.id);
  return ask(ctx, s, 'resPick', `📊 Which one?\n\n${L.map((c, n) => `${n + 1}. ${c.kind === 'poll' ? '🗳' : '📢'} ${esc(fmt(c.at))} — ${esc((c.kind === 'poll' ? c.question : c.text).slice(0, 40))}`).join('\n')}\n\nSend the number.`);
};
const showCampaign = (ctx, s, id) => {
  const c = campaigns().find(x => x.id === id); if (!c) { reset(s); return out(ctx, 'That item no longer exists.'); }
  s.camp = id;
  const extra = c.kind === 'poll' ? [[...(c.anonymous ? [] : ['👥 Who voted']), ...(c.closed ? [] : ['🔒 Close poll'])]] : [];
  return ask(ctx, s, 'resAct', campaignReport(c), [['🔄 Refresh', '📣 Share results'], ...extra.filter(r => r.length)]);
};
F.resPick = (ctx, t, s) => { const id = s.campList?.[Number.parseInt(t, 10) - 1]; return id === undefined ? out(ctx, 'Send a number from the list.') : showCampaign(ctx, s, id); };
F.resAct = async (ctx, t, s) => {
  const L = campaigns(), c = L.find(x => x.id === s.camp); if (!c) { reset(s); return out(ctx, 'That item no longer exists.'); }
  if (t === '🔄 Refresh') return showCampaign(ctx, s, c.id);
  if (t === '📣 Share results') { await fanOut(ctx, Object.keys(c.msgs), uid => tg.sendMessage(uid, `📊 Results\n\n${campaignReport(c)}`, { parse_mode: 'HTML' }), 'Sharing the results'); return showCampaign(ctx, s, c.id); }
  if (t === '🔒 Close poll') { await fanOut(ctx, Object.keys(c.msgs), uid => tg.stopPoll(uid, c.msgs[uid]), 'Closing the poll'); c.closed = true; save('_g', 'campaigns', L); W.logActivity(ctx.from.id, 'poll-closed', c.id, ''); return showCampaign(ctx, s, c.id); }
  if (t === '👥 Who voted' && !c.anonymous) {
    const by = c.options.map(() => []); for (const [u, ids] of Object.entries(c.votes || {})) for (const n of ids) by[n]?.push(esc(prof(u).name || u));
    return sendBatches(ctx, '👥 Who voted', c.options.map((o, n) => `<b>${esc(o)}</b> (${by[n].length})\n${by[n].join(', ') || '—'}\n`));
  }
};
A['🛠 Admin'] = ctx => go(ctx, 'admin');
A['👤 Users'] = ctx => go(ctx, 'adminUsers');
A['📢 Messages'] = ctx => go(ctx, 'adminMsg');
A['💰 Payments'] = ctx => go(ctx, 'adminPay');
A['⚙️ Settings'] = ctx => go(ctx, 'settings');
A['👮 Admins'] = ctx => go(ctx, 'admins');
const planList = () => plans().map((p, i) => `${i + 1}. ${p.name} — ${p.price} — ${p.days} days\n🔗 ${p.link || '—'}\n🏦 ${(p.bank || '—').slice(0, 80)}`).join('\n\n');
A['📖 List plans'] = ctx => { if (!requireAdmin(ctx)) return; return out(ctx, plans().length ? esc(planList()) : 'No plans yet. Use ➕ Add plan.', {}, true); };
A['➕ Add plan'] = ctx => { if (!requireAdmin(ctx)) return; const s = St(ctx.from.id); s.planDraft = {}; return ask(ctx, s, 'planName', 'Plan name? (for example Weekly or Monthly)'); };
F.planName = (ctx, t, s) => { if (!requireAdmin(ctx)) return; s.planDraft.name = t.slice(0, 30); return ask(ctx, s, 'planPrice', 'Price as users should see it (for example ₦5,000 or $10)'); };
F.planPrice = (ctx, t, s) => { if (!requireAdmin(ctx)) return; s.planDraft.price = t.slice(0, 30); return ask(ctx, s, 'planDays', 'How many days does this plan last? (1–3650)'); };
F.planDays = (ctx, t, s) => { if (!requireAdmin(ctx)) return; const n = Number(t); if (!Number.isInteger(n) || n < 1 || n > 3650) return out(ctx, 'Enter a whole number from 1 to 3650.'); s.planDraft.days = n; return ask(ctx, s, 'planLink', 'Payment link for THIS plan (send - for none)'); };
F.planLink = (ctx, t, s) => { if (!requireAdmin(ctx)) return; s.planDraft.link = t.trim() === '-' ? '' : t.trim(); return ask(ctx, s, 'planBank', 'Bank / payment details for THIS plan (send - for none)'); };
F.planBank = (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const L = plans(); L.push({ ...s.planDraft, bank: t.trim() === '-' ? '' : t.trim(), id: Date.now() }); save('_g', 'plans', L);
  reset(s); return out(ctx, '✅ Plan saved. Users can pick it now.');
};
const pickPlan = (label, step) => { A[label] = ctx => { if (!requireAdmin(ctx)) return; if (!plans().length) return out(ctx, 'No plans yet.'); out(ctx, esc(planList()), {}, true); return ask(ctx, St(ctx.from.id), step, 'Send the plan number.'); }; };
pickPlan('✏️ Edit plan', 'planEditPick'); pickPlan('🗑 Remove plan', 'planDelPick');
F.planDelPick = (ctx, t, s) => { if (!requireAdmin(ctx)) return; const L = plans(), i = +t - 1; if (!L[i]) return out(ctx, 'Invalid number.'); L.splice(i, 1); save('_g', 'plans', L); reset(s); return out(ctx, '🗑 Plan removed.'); };
F.planEditPick = (ctx, t, s) => { if (!requireAdmin(ctx)) return; if (!plans()[+t - 1]) return out(ctx, 'Invalid number.'); s.planIdx = +t - 1; return ask(ctx, s, 'planEditField', 'What do you want to change?', [['Name', 'Price'], ['Days', 'Link'], ['Bank details']]); };
F.planEditField = (ctx, t, s) => { if (!requireAdmin(ctx)) return; const f = { Name: 'name', Price: 'price', Days: 'days', Link: 'link', 'Bank details': 'bank' }[t]; if (!f) return; s.planField = f; return ask(ctx, s, 'planEditValue', `Send the new ${t.toLowerCase()} (send - to clear link/bank).`); };
F.planEditValue = (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const L = plans(), p = L[s.planIdx]; if (!p) { reset(s); return out(ctx, 'That plan no longer exists.'); }
  if (s.planField === 'days') { const n = Number(t); if (!Number.isInteger(n) || n < 1 || n > 3650) return out(ctx, 'Enter a whole number from 1 to 3650.'); p.days = n; }
  else p[s.planField] = ['link', 'bank'].includes(s.planField) && t.trim() === '-' ? '' : t.trim().slice(0, 500);
  save('_g', 'plans', L); reset(s); return out(ctx, '✅ Plan updated.');
};
A['📌 Pinned keyboard'] = async ctx => {
  if (!requireAdmin(ctx)) return;
  const pin = CFG.kbPinned === false; W.setCfg('kbPinned', pin); await go(ctx, 'settings', false);
  return out(ctx, pin ? '📌 Pinned keyboard: <b>ON</b> — the menu always stays open.' : '📌 Pinned keyboard: <b>OFF</b> — collapse the menu with the keyboard icon beside the typing box.');
};
A['🌈 Button colours'] = ctx => { if (!requireAdmin(ctx)) return; return ask(ctx, St(ctx.from.id), 'kbStyle', 'Choose how the menu buttons are coloured. Telegram supports blue, green and red only. Colours need a Telegram app updated after Feb 2026.', chunk(Object.keys(STYLE_MODES), 2)); };
F.kbStyle = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return; if (!(t in STYLE_MODES)) return out(ctx, 'Choose one of the options shown.');
  W.setCfg('kbStyle', STYLE_MODES[t]); await go(ctx, 'settings', false); return out(ctx, `🌈 Button colours: ${t}`);
};
A['💾 Backup now'] = async ctx => {
  if (!requireAdmin(ctx)) return;
  const dir = fs.mkdtempSync(`${os.tmpdir()}/wa-status-backup-`), archive = `${dir}/backup.tgz`;
  try {
    execFileSync('tar', ['-czf', archive, W.DATA], { timeout: 120000 });
    const enc = !!W.backupKey(); if (enc) W.encryptFile(archive, `${archive}.enc`, W.backupKey());
    await ctx.replyWithDocument({ source: enc ? `${archive}.enc` : archive, filename: enc ? 'wa-status-backup.tgz.enc' : 'wa-status-backup.tgz' }, { caption: `🔐 Everything: logins, schedules, contacts, settings.${enc ? ' Encrypted with your BACKUP_KEY.' : ' Not encrypted: set BACKUP_KEY in .env to encrypt it.'} Keep it private.` });
  } catch (e) { await out(ctx, `❌ Backup failed: ${esc(e.message)}`); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
A['♻️ Restore backup'] = async ctx => {
  if (!W.isOwner(ctx.from.id)) return out(ctx, 'Only the owner can restore a backup.');
  return ask(ctx, St(ctx.from.id), 'restore', '♻️ Send the backup file here as a file (.tgz, or .enc if you encrypt backups).\n\n• Only people who are NOT linked right now get their login restored, so nobody is rolled back.\n• Existing files are never overwritten.\n• Telegram lets me download files up to 20 MB.\n• Add the word force as the caption to overwrite everything. Use that only on a fresh server.');
};
async function restoreDoc(ctx) {
  const u = ctx.from.id, m = ctx.message, d = m.document;
  if (!W.isOwner(u)) return out(ctx, 'Only the owner can restore a backup.');
  if (!d) return out(ctx, 'Please send the backup as a file (a document), not as a photo or text.');
  if (d.file_size > 19.5e6) return out(ctx, '❌ This file is over 20 MB and Telegram does not let bots download that much. Restore it by hand: stop the bot, unpack it into the data folder, then start the bot again.');
  const force = /\bforce\b/i.test(m.caption || ''), tmp = fs.mkdtempSync(`${os.tmpdir()}/wa-restore-in-`), raw = `${tmp}/in`, plain = `${tmp}/out.tgz`;
  ctx.deleteMessage().catch(() => {});                              // the file holds everyone's logins
  await out(ctx, '♻️ Restoring… this can take a minute.');
  try {
    const url = await tg.getFileLink(d.file_id); fs.writeFileSync(raw, Buffer.from(await (await fetch(url.href)).arrayBuffer()));
    let file = raw;
    if (W.isEncrypted(raw)) { if (!W.backupKey()) throw new Error('This backup is encrypted. Set BACKUP_KEY in your .env to the same key, restart the bot, and send it again.'); W.decryptFile(raw, plain, W.backupKey()); file = plain; }
    const r = await W.restoreBackup(file, { force }); St(u).step = null;
    W.logActivity(u, 'backup-restore', `${r.restored.length} logins, ${r.data} files${force ? ', force' : ''}`);
    return out(ctx, ['✅ Restore finished', '', `🔐 Logins restored: ${r.restored.length} (they reconnect now, one by one)`, `⏭ Kept as they are (already linked here): ${r.kept.length}`, `📂 Data files restored: ${r.data}`, r.notPaired ? `ℹ️ Logins in the backup that were not linked: ${r.notPaired}` : '', r.failed ? `⚠️ Failed: ${r.failed}` : '', '', 'A login can be a few hours older than the live one. If someone does not reconnect, ask them to link again.'].filter(x => x !== '').join('\n'));
  } catch (e) { return out(ctx, `❌ ${esc(e.message)}`); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
A['🗄 Deleted accounts'] = ctx => {
  if (!requireAdmin(ctx)) return;
  const dir = `${W.DATA}/deleted`, entries = fs.existsSync(dir) ? fs.readdirSync(dir).slice(-50) : [];
  return out(ctx, entries.length ? entries.map(esc).join('\n') : 'No deleted accounts in the archive.');
};
A['📋 List users'] = ctx => {
  if (!requireAdmin(ctx)) return;
  const all = users();
  return out(ctx, all.length ? all.slice(0, 100).map((u, i) => `${i + 1}. ${userName(u)}${W.linked(u) ? ' — linked' : ''}`).join('\n') : 'No users yet.');
};
A['ℹ️ User info'] = ctx => askAdminTarget(ctx, 'info', 'Send the Telegram user ID.');
for (const [label, action, prompt] of [
  ['⏸ Pause', 'pause', 'Send the Telegram user ID to pause.'],
  ['▶️ Resume', 'resume', 'Send the Telegram user ID to resume.'],
  ['🔢 Set limit', 'limit', 'Send the Telegram user ID whose daily limit to change.'],
  ['⏳ Add days', 'days', 'Send the Telegram user ID whose plan to extend.'],
  ['🔌 Force unlink', 'unlink', 'Send the Telegram user ID to unlink.'],
  ['🧽 Repair user', 'repair', 'Send the Telegram user ID whose session to repair.'],
  ['📦 User data file', 'data', 'Send the Telegram user ID whose data file to export.'],
  ['🗑 Remove user', 'remove', 'Send the Telegram user ID to remove.']
]) A[label] = ctx => askAdminTarget(ctx, action, prompt);
function askAdminTarget(ctx, action, prompt) {
  if (!requireAdmin(ctx)) return;
  const s = St(ctx.from.id); s.adminAction = action;
  return ask(ctx, s, 'adminTarget', prompt);
}
F.adminTarget = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  W.logActivity(ctx.from.id, `user:${s.adminAction}`, t.trim());
  const uid = t.trim();
  if (!/^\d{1,20}$/.test(uid) || !users().includes(uid)) return out(ctx, 'Send a Telegram user ID that exists in the user list.');
  s.target = uid;
  switch (s.adminAction) {
    case 'info': {
      const p = prof(uid);
      reset(s);
      return out(ctx, `👤 <b>${uid}</b>\nWhatsApp: ${W.linked(uid) ? (W.isUp(uid) ? 'Connected' : 'Linked, reconnecting') : 'Not linked'}\nPlan: ${p.paused ? 'Paused' : W.expired(p) ? 'Expired' : 'Active'}\nLimit: ${p.limit}\nPosts today: ${p.sent?.n || 0}\n\n🩺 Session health:\n${esc(W.healthSummary(uid))}`);
    }
    case 'pause':
    case 'resume': {
      const p = prof(uid); p.paused = s.adminAction === 'pause'; save(uid, 'profile', p); reset(s);
      return out(ctx, `✅ User ${uid} ${p.paused ? 'paused' : 'resumed'}.`);
    }
    case 'limit':
      return ask(ctx, s, 'adminValue', 'Send a daily limit from 1 to 10000.');
    case 'days':
      return ask(ctx, s, 'adminValue', 'Send the number of days to add (1 to 3650).');
    case 'unlink':
      await W.unlink(uid); reset(s); return out(ctx, `✅ WhatsApp unlinked for ${uid}.`);
    case 'repair': { const n = await W.repairSession(uid); reset(s); return out(ctx, `🧽 Repaired ${uid}: ${n} stale session files cleared, reconnecting.`); }
    case 'data': {
      const files = ['profile', 'contacts', 'history', 'views', 'posts', 'lists', 'exclude', 'templates', 'groups', 'links_seen', 'dead_links', 'tags'];
      const data = Object.fromEntries(files.map(f => [f, load(uid, f, f === 'exclude' || f === 'templates' ? [] : {})]));
      reset(s); return doc(ctx, JSON.stringify(data, null, 2), `user-${uid}-data.json`);
    }
    case 'remove':
      return ask(ctx, s, 'adminRemoveConfirm', `Remove user ${uid} and archive their active data?`, [['✅ Yes', 'No']]);
  }
};
F.adminValue = (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  W.logActivity(ctx.from.id, `user:${s.adminAction}-value`, s.target, t.trim());
  const n = Number(t), uid = s.target;
  if (!Number.isInteger(n)) return out(ctx, 'Send a whole number.');
  const p = prof(uid);
  if (s.adminAction === 'limit') {
    if (n < 1 || n > 10000) return out(ctx, 'The limit must be from 1 to 10000.');
    p.limit = n; save(uid, 'profile', p); reset(s); return out(ctx, `✅ Daily limit for ${uid} set to ${n}.`);
  }
  if (s.adminAction === 'days') {
    if (n < 1 || n > 3650) return out(ctx, 'Enter a number from 1 to 3650.');
    p.expires = Math.max(Date.now(), p.expires || 0) + n * 864e5; save(uid, 'profile', p); reset(s);
    return out(ctx, `✅ Added ${n} days to ${uid}'s plan.`);
  }
};
F.adminRemoveConfirm = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const uid = s.target;
  if (isYes(t)) { await W.unlink(uid); W.dropUser(uid); reset(s); return out(ctx, `✅ User ${uid} removed and archived.`); }
  reset(s); return out(ctx, 'The user was not removed.');
};

A['📢 Broadcast'] = ctx => requireAdmin(ctx) && ask(ctx, St(ctx.from.id), 'broadcast', 'Send the message to broadcast to all bot users.');
A['📌 Pin notice'] = ctx => requireAdmin(ctx) && ask(ctx, St(ctx.from.id), 'notice', 'Send the notice to save and pin for all bot users.');
F.broadcast = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const text = t.trim(); if (!text) return out(ctx, 'The broadcast cannot be empty.');
  reset(s); await go(ctx, cur(s), false, true);
  void runCampaign(ctx, newCampaign(ctx, { kind: 'message', text: text.slice(0, 4000) }), users());
};
F.notice = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const text = t.trim().slice(0, 4000);
  if (!text) return out(ctx, 'The notice cannot be empty.');
  const notices = load('_g', 'notices', []); notices.push({ text, at: Date.now() }); save('_g', 'notices', notices.slice(-50));
  let sent = 0;
  for (const uid of users()) {
    try {
      const m = await tg.sendMessage(uid, `📌 ${text}`);
      await tg.pinChatMessage(uid, m.message_id, { disable_notification: true }).catch(() => {});
      sent++;
    } catch {}
  }
  reset(s); return out(ctx, `📌 Notice delivered to ${sent} user${sent === 1 ? '' : 's'}.`);
};
A['📥 Admin inbox'] = ctx => {
  if (!requireAdmin(ctx)) return;
  const inbox = load('_g', 'admin_inbox', []).filter(x => !x.replied).slice(-20).reverse();
  return out(ctx, inbox.length ? inbox.map(x => `${x.uid} — ${esc(x.text.slice(0, 180))}`).join('\n\n') : 'No unread messages.');
};
A['↩️ Reply user'] = ctx => requireAdmin(ctx) && ask(ctx, St(ctx.from.id), 'replyTarget', 'Send the Telegram user ID to reply to.');
F.replyTarget = (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const uid = t.trim();
  if (!/^\d{1,20}$/.test(uid) || !users().includes(uid)) return out(ctx, 'Send a valid Telegram user ID.');
  s.target = uid; return ask(ctx, s, 'replyText', `Send your reply to ${uid}.`);
};
F.replyText = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const message = t.trim().slice(0, 4000);
  try { await tg.sendMessage(s.target, `📩 Reply from admin:\n${message}`); }
  catch { return out(ctx, 'Could not deliver the reply. The user may have blocked the bot.'); }
  const inbox = load('_g', 'admin_inbox', []);
  const item = [...inbox].reverse().find(x => x.uid === Number(s.target) && !x.replied);
  if (item) item.replied = true;
  save('_g', 'admin_inbox', inbox); reset(s); return out(ctx, '✅ Reply sent.');
};

// Payment review uses the configured paid-plan switch and extends approval by 30 days.
A['🕒 Pending'] = ctx => {
  if (!requireAdmin(ctx)) return;
  const pending = load('_g', 'pending_payments', []).filter(x => x.status === 'pending');
  return out(ctx, pending.length ? pending.map(x => `${x.uid} — ${fmt(x.at)}`).join('\n') : 'No pending receipts.');
};
A['✅ Approve'] = ctx => askPaymentDecision(ctx, 'approve');
A['❌ Decline'] = ctx => askPaymentDecision(ctx, 'decline');
function askPaymentDecision(ctx, action) {
  if (!requireAdmin(ctx)) return;
  const pending = load('_g', 'pending_payments', []).filter(x => x.status === 'pending');
  if (!pending.length) return out(ctx, 'No pending receipts.');
  const s = St(ctx.from.id); s.adminAction = action;
  return ask(ctx, s, 'paymentTarget', `Send the Telegram user ID to ${action}:\n${pending.map(x => `${x.uid} — ${fmt(x.at)}`).join('\n')}`);
}
F.paymentTarget = async (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const uid = t.trim(), pending = load('_g', 'pending_payments', []);
  const item = [...pending].reverse().find(x => String(x.uid) === uid && x.status === 'pending');
  if (!item) return out(ctx, 'No pending receipt was found for that user ID.');
  if (s.adminAction === 'approve') {
    s.target = uid; s.defDays = item.days || null;
    return ask(ctx, s, 'paymentDays', item.days ? `Plan: ${item.planName} (${item.days} days). Send OK to grant ${item.days} days, or send a different number of days.` : 'Send the number of plan days to grant (1 to 3650).', item.days ? [['OK']] : []);
  }
  item.status = 'declined'; item.reviewedAt = Date.now();
  save('_g', 'pending_payments', pending); reset(s);
  tg.sendMessage(uid, '❌ Your payment receipt was declined. Contact the admin if you need help.').catch(() => {});
  return out(ctx, '✅ Receipt declined.');
};
F.paymentDays = (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const n = /^ok$/i.test(t.trim()) && s.defDays ? s.defDays : Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return out(ctx, 'Enter a whole number from 1 to 3650.');
  const uid = s.target, pending = load('_g', 'pending_payments', []);
  const item = [...pending].reverse().find(x => String(x.uid) === uid && x.status === 'pending');
  if (!item) { reset(s); return out(ctx, 'That pending receipt is no longer available.'); }
  const p = prof(uid); p.expires = Math.max(Date.now(), p.expires || 0) + n * 864e5; p.expNotified = false; if (item.planName) p.plan = item.planName; delete p.pendingPlan; save(uid, 'profile', p);
  W.rewardReferrer(uid);
  item.status = 'approved'; item.reviewedAt = Date.now(); item.daysGranted = n; W.logActivity(ctx.from.id, 'payment-approved', uid, `${item.planName || ''} ${n}d`);
  save('_g', 'pending_payments', pending); reset(s);
  { const us = St(Number(uid)); us.nav = ['home']; us.keyboardRows = MENUS.home.rows(Number(uid)); tg.sendMessage(uid, `🎉 Payment approved! ${item.planName ? esc(item.planName) + ' plan: ' : ''}${n} days added. Your dashboard is updated ↓`, { parse_mode: 'HTML', ...keyboardFor(Number(uid)) }).catch(() => {}); }
  return out(ctx, `✅ Receipt approved; ${n} days added.`);
};

// ---------- live settings and admin list ----------
const settingPrompts = {
  '💳 Pay link': ['payLink', 'Send the payment link (or "-" to clear it).'],
  '🏦 Bank details': ['bank', 'Send the bank details (or "-" to clear them).'],
  '🔢 Default limit': ['limit', 'Send the default daily limit from 1 to 10000.'],
  '👥 Max audience': ['maxAud', 'Send the maximum audience size from 1 to 100000.'],
  '📦 Batch size': ['batch', 'Send the post batch size from 1 to 1000.'],
  '⏳ Trial days': ['trial', 'Send the default trial length from 0 to 3650 days.'],
  '⏰ Reminder days': ['remindDays', 'Send the reminder days before a plan ends, separated by commas, for example 3,1'],
  '🔗 Max links per post': ['spamMaxLinks', 'Send the most links allowed in one post (0 to 20).'],
  '🚫 Spam words': ['spamWords', 'Send blocked words separated by commas (or "-" to clear).'],
  '✉️ Message daily cap': ['msgDailyCap', 'Send the most messages one user may send per day (1 to 2000). Groups and channels count as one each.'],
  '👥 Message max recipients': ['msgMaxRecipients', 'Send the most recipients allowed in a single message (1 to 1000).'],
  '📣 Reach-out max/day': ['reachMax', 'Send the highest daily reach-out messages any user may set (1 to 50).'],
  '🎁 Referral days': ['refDays', 'Send the free days a referrer earns when their friend first pays (0 turns referrals off).']
};
for (const [label, [key, prompt]] of Object.entries(settingPrompts)) A[label] = ctx => {
  if (!requireAdmin(ctx)) return;
  const s = St(ctx.from.id); s.settingKey = key;
  return ask(ctx, s, 'settingValue', prompt);
};
A['🧪 Toggle plan required'] = ctx => {
  if (!requireAdmin(ctx)) return;
  W.setCfg('require', !CFG.require);
  return out(ctx, `✅ Plan requirement ${CFG.require ? 'enabled' : 'disabled'}.`);
};
F.settingValue = (ctx, t, s) => {
  if (!requireAdmin(ctx)) return;
  const key = s.settingKey, raw = t.trim();
  if (key === 'remindDays') {
    const list = raw.split(',').map(x => Number(x.trim()));
    if (!list.length || list.some(n => !Number.isInteger(n) || n < 1 || n > 60)) return out(ctx, 'Send whole days from 1 to 60 separated by commas, for example 3,1');
    W.setCfg('remindDays', list.join(',')); reset(s); return out(ctx, '✅ Setting saved.');
  }
  W.logActivity(ctx.from.id, 'setting', key, ['payLink', 'bank', 'spamWords'].includes(key) ? '' : raw);
  if (['payLink', 'bank', 'spamWords'].includes(key)) W.setCfg(key, raw === '-' ? '' : raw);
  else {
    const n = Number(raw), bounds = { limit: [1, 10000], maxAud: [1, 100000], batch: [1, 1000], trial: [0, 3650], refDays: [0, 365], spamMaxLinks: [0, 20], reachMax: [1, 50], msgDailyCap: [1, 2000], msgMaxRecipients: [1, 1000] }[key];
    if (!Number.isInteger(n) || !bounds || n < bounds[0] || n > bounds[1]) return out(ctx, `Enter a valid whole number from ${bounds?.[0] ?? 0} to ${bounds?.[1] ?? 0}.`);
    const configKey = { limit: 'limit', maxAud: 'maxAud', batch: 'batch', trial: 'trial', refDays: 'refDays', spamMaxLinks: 'spamMaxLinks', reachMax: 'reachMax', msgDailyCap: 'msgDailyCap', msgMaxRecipients: 'msgMaxRecipients' }[key];
    W.setCfg(configKey, n);
  }
  reset(s); return out(ctx, '✅ Setting saved.');
};
A['➕ Add admin'] = ctx => {
  if (!W.isOwner(ctx.from.id)) return out(ctx, 'Only the owner can manage admins.');
  return ask(ctx, St(ctx.from.id), 'adminAdd', 'Send the Telegram user ID to add as an admin.');
};
A['➖ Remove admin'] = ctx => {
  if (!W.isOwner(ctx.from.id)) return out(ctx, 'Only the owner can manage admins.');
  const admins = W.adminList().filter(x => x !== String(CFG.admin));
  return ask(ctx, St(ctx.from.id), 'adminRemove', `Send the admin user ID to remove:\n${admins.join('\n') || 'No additional admins.'}`);
};
A['📖 List admins'] = ctx => {
  if (!requireAdmin(ctx)) return;
  return out(ctx, W.adminList().length ? W.adminList().map((id, i) => `${i + 1}. ${id}${W.isOwner(id) ? ' (owner)' : ''}`).join('\n') : 'No admins configured.');
};
F.adminAdd = (ctx, t, s) => {
  if (!W.isOwner(ctx.from.id)) return out(ctx, 'Only the owner can manage admins.');
  const uid = t.trim();
  if (!/^\d{1,20}$/.test(uid)) return out(ctx, 'Send a valid Telegram user ID.');
  W.setAdmins([...new Set([...W.adminList().filter(x => x !== String(CFG.admin)), uid])]);
  const P = load('_g', 'admin_perms', {}); P[uid] ??= []; save('_g', 'admin_perms', P);   // new admins start with NO access
  reset(s); refreshMenus();
  return out(ctx, `✅ Admin ${uid} added with no access yet. Open 🔐 Admin access to choose what they can see and do.`, {}, true);
};
F.adminRemove = (ctx, t, s) => {
  if (!W.isOwner(ctx.from.id)) return out(ctx, 'Only the owner can manage admins.');
  const uid = t.trim();
  if (uid === String(CFG.admin)) return out(ctx, 'The owner cannot be removed.');
  const before = W.adminList(), next = before.filter(x => x !== uid);
  if (next.length === before.length) return out(ctx, 'That ID is not an admin.');
  W.setAdmins(next.filter(x => x !== String(CFG.admin))); reset(s);
  return out(ctx, `✅ Admin ${uid} removed.`);
};

// ---------- profile ----------
A['👤 Profile'] = ctx => {
  const u = ctx.from.id, p = prof(u), C = contactsOf(u), G = load(u, 'groups', {}), P = load(u, 'posts', []), me = W.waMe(u), now = Date.now();
  const act = Object.values(C).filter(x => !x.out), role = W.isOwner(u) ? 'Owner' : isAdm(u) ? 'Admin' : 'User';
  const left = p.expires ? Math.ceil((p.expires - now) / 864e5) : null;
  const access = role === 'User' ? [] : ['', `🔐 Access: ${W.isOwner(u) ? 'everything' : (permList(u) ?? Object.keys(PERMS)).map(k => PERMS[k]).join(', ') || 'none yet'}`, `🧩 Build: ${BUILD}`];
  return out(ctx, [
    '👤 <b>Your profile</b>', `Name: ${esc(ctx.from.first_name || '')}${ctx.from.username ? ' · @' + esc(ctx.from.username) : ''}`, `Telegram ID: <code>${u}</code> · Role: ${role}`, '',
    `📱 WhatsApp: ${me ? '+' + me.number + (me.name ? ' · ' + esc(me.name) : '') : 'not linked'}`,
    `Status: ${W.linked(u) ? (W.isUp(u) ? '🟢 Connected' : '🟡 Reconnecting') : '🔴 Not linked'}`, '',
    `💳 Plan: ${esc(p.plan || '—')} · ${p.paused ? '⏸ Paused' : W.expired(p) ? '⌛ Expired' : '✅ Active'}`,
    `📆 Expires: ${p.expires ? esc(fmt(p.expires)) + (left > 0 ? ` (${left} days left)` : ' (ended)') : 'no expiry'}`,
    `📤 Today: ${p.sent?.n || 0}/${p.limit} · All time: ${p.total || 0}`,
    `🗓 Scheduled: ${P.filter(x => x.status === 'scheduled').length} · 📡 Sending now: ${W.activeJobs(u).length}`, '',
    `👥 Contacts: ${act.length} · 👁 Viewers: ${act.filter(x => x.v > 0).length}`,
    `👪 Groups: ${Object.keys(G).length} (admin in ${Object.values(G).filter(g => g.role === 'admin').length})`,
    `🏷 Lists: ${Object.keys(load(u, 'lists', {})).length}`, `🎁 Referrals: joined ${p.refJoined || 0} · paid ${p.refPaid || 0}`, `📅 Joined: ${esc(fmt(p.created || now))}`, ...access
  ].join('\n'), {}, true);
};

// ---------- posts being sent right now ----------
function showJobs(ctx) {
  const u = ctx.from.id, s = St(u), J = W.activeJobs(u);
  if (!J.length) { reset(s); return out(ctx, '📡 Nothing is being sent right now.'); }
  const lines = J.map((j, i) => {
    const left = Math.max(0, j.total - j.sent), pct = j.total ? Math.round(100 * j.sent / j.total) : 0;
    return `${i + 1}. “${esc(j.preview)}” (${j.type})\n✅ Sent ${j.sent} · ⏳ Left ${left} of ${j.total} (${pct}%)\n🕒 Started ${esc(fmt(j.started))}${j.cancel ? '\n🛑 Stopping…' : ''}`;
  });
  return ask(ctx, s, 'jobs', `📡 <b>Sending now</b>\n\n${lines.join('\n\n')}`, [['🔄 Refresh', '🛑 Stop all'], ...J.map((_, i) => [`🛑 Stop #${i + 1}`])]);
}
A['📡 Sending now'] = ctx => showJobs(ctx);
F.jobs = async (ctx, t) => {
  const u = ctx.from.id;
  if (t === '🔄 Refresh') return showJobs(ctx);
  if (t === '🛑 Stop all') { const n = W.cancelJobs(u); await out(ctx, n ? `🛑 Stopping ${n} post${n === 1 ? '' : 's'}. People who already received it keep it; nobody else will be sent.` : 'Nothing to stop.'); await wait(1500); return showJobs(ctx); }
  const m = t.match(/^🛑 Stop #(\d+)$/); if (!m) return;
  const j = W.activeJobs(u)[+m[1] - 1]; if (!j) return out(ctx, 'That post already finished.');
  W.cancelJobs(u, j.id); await out(ctx, '🛑 Stopping. People who already received it keep it; nobody else will be sent.'); await wait(1500); return showJobs(ctx);
};
A['📡 All sending'] = ctx => {
  const J = W.allJobs(); if (!J.length) return out(ctx, '📡 No posts are being sent right now.');
  return ask(ctx, St(ctx.from.id), 'admJobs', `📡 <b>Sending now</b>\n\n${J.map(j => `${j.uid} “${esc(j.preview)}” — sent ${j.sent}/${j.total}`).join('\n')}\n\nSend a user ID to stop all of that user's posts.`);
};
F.admJobs = (ctx, t) => { const n = W.cancelJobs(t.trim()); return out(ctx, n ? `🛑 Stopping ${n} post${n === 1 ? '' : 's'}.` : 'No active post for that ID.'); };

// ---------- admin: pull one kind of data for one user ----------
const pickUserPrompt = (ctx, s, step, title) => {
  const all = users(); if (!all.length) return out(ctx, 'No users yet.');
  s.userPick = all;
  return ask(ctx, s, step, `${title}\n\n${all.slice(0, 80).map((id, i) => `${i + 1}. ${id} ${esc(prof(id).name || '')} ${W.isUp(id) ? '🟢' : W.linked(id) ? '🟡' : '⚪'}`).join('\n')}${all.length > 80 ? '\n…' : ''}`);
};
const resolveUser = (t, s) => { const x = t.trim(); return (/^\d{1,4}$/.test(x) && s.userPick?.[+x - 1]) || (users().includes(x) ? x : null); };
A['📂 User data'] = ctx => pickUserPrompt(ctx, St(ctx.from.id), 'udataUser', '📂 Choose a user — send the number or Telegram ID:');
const udataRows = [['👥 Contacts list', '👪 Groups list'], ['🔗 Links of groups', '💬 Chat links'], ['📄 Contacts file', '📦 Everything (file)'], ['🔄 Sync groups now', '🧼 Merge duplicates now'], ['🔗 Check dead links now']];
F.udataUser = (ctx, t, s) => {
  const id = resolveUser(t, s); if (!id) return out(ctx, 'Send a number from the list or a valid Telegram ID.');
  s.target = id; return ask(ctx, s, 'udata', `📂 User <b>${id}</b> ${esc(prof(id).name || '')}\nChoose what to send:`, udataRows);
};
F.udata = async (ctx, t, s) => {
  W.logActivity(ctx.from.id, 'user-data', s.target, t);
  const id = s.target, C = load(id, 'contacts', {}), G = load(id, 'groups', {}), L = load(id, 'links_seen', {});
  const E = Object.entries(C).filter(([n]) => /^\d{7,15}$/.test(n)).sort((a, b) => a[0].localeCompare(b[0]));
  const gl = g => `${esc(g.subject || '(no name)')} · ${g.size || 0} members${g.role === 'admin' ? ' · admin' : ''}`;
  if (t === '👥 Contacts list') return sendBatches(ctx, `👥 <b>${E.length} unique contacts</b> of ${id}`, E.map(([n, c]) => `+${n}${c.name ? ' ' + esc(c.name) : ''}`));
  if (t === '👪 Groups list') { const V = Object.values(G); return V.length ? sendBatches(ctx, `👪 <b>${V.length} groups</b> of ${id}`, V.map((g, i) => `${i + 1}. ${gl(g)}${g.link ? '\n' + g.link : ''}\n`)) : out(ctx, 'No groups saved for this user.'); }
  if (t === '🔗 Links of groups') { const V = Object.values(G).filter(g => g.link); return V.length ? sendBatches(ctx, `🔗 <b>${V.length} group links</b> of ${id}`, V.map(g => `${esc(g.subject || '(no name)')} — ${g.link}`)) : out(ctx, 'No group links saved for this user.'); }
  if (t === '💬 Chat links') { const V = Object.values(L); return V.length ? sendBatches(ctx, `💬 <b>${V.length} links seen in chats</b> of ${id}`, V.map(l => `${l.url}${G[l.group]?.subject ? ' — ' + esc(G[l.group].subject) : ''}`)) : out(ctx, 'No chat links saved for this user.'); }
  if (t === '📄 Contacts file') {
    if (!E.length) return out(ctx, 'No contacts saved for this user.');
    await doc(ctx, toCsv([['Name', 'Phone', 'Source'], ...E.map(([n, c]) => [c.name || '', '+' + n, c.src || ''])]), `contacts-${id}.csv`);
    return doc(ctx, E.map(([n, c]) => `BEGIN:VCARD\nVERSION:3.0\nFN:${(c.name || '+' + n).replace(/[\r\n]/g, ' ')}\nTEL;TYPE=CELL:+${n}\nEND:VCARD`).join('\n'), `contacts-${id}.vcf`);
  }
  if (t === '🔄 Sync groups now') {
    if (!W.isUp(id)) return out(ctx, '⚠️ That user is not connected to WhatsApp right now.');
    await out(ctx, '⏳ Syncing their groups… (can take a few minutes for many groups)');
    W.refreshGroups(id).then(n => { const p = prof(id); p.groupsSyncedAt = Date.now(); save(id, 'profile', p); return out(ctx, `✅ ${n} groups synced for ${id}.`, {}, true); }).catch(e => out(ctx, `❌ Sync failed: ${esc(e.message)}`));
    return;
  }
  if (t === '🧼 Merge duplicates now') { const r = await W.cleanContacts(id); return out(ctx, `✅ ${id}: merged ${r.merged} duplicates, removed ${r.removed} invalid numbers.`, {}, true); }
  if (t === '🔗 Check dead links now') {
    if (!W.isUp(id)) return out(ctx, '⚠️ That user is not connected to WhatsApp right now.');
    await out(ctx, '⏳ Checking their group links… (slow on purpose, to stay safe)');
    W.checkLinks(id).then(r => out(ctx, `✅ ${id}: link check finished${typeof r === 'number' ? ` — ${r} removed` : ''}.`, {}, true)).catch(e => out(ctx, `❌ ${esc(e.message)}`));
    return;
  }
  if (t === '📦 Everything (file)') {
    const f = `${os.tmpdir()}/u${id}-${Date.now()}.tgz`;
    try { W.flush(); execFileSync('tar', ['-czf', f, '--exclude=auth', '-C', W.DATA, id], { timeout: 120000 }); await ctx.replyWithDocument({ source: f, filename: `user-${id}-data.tgz` }); }
    catch (e) { await out(ctx, `❌ ${esc(e.message)}`); } finally { fs.rmSync(f, { force: true }); }
  }
};

// ---------- admin: switch features on/off, give admins access ----------
function togItems(kind, target) {
  if (kind === 'feat') return Object.entries(FEATURES).map(([k, f]) => ({ k, name: f.name, on: !!featState(target, k) }));
  const cur = permList(target) ?? Object.keys(PERMS);
  return Object.entries(PERMS).map(([k, name]) => ({ k, name, on: cur.includes(k) }));
}
function askToggles(ctx, s, kind, target) {
  s.tog = { kind, target };
  const head = kind === 'feat' ? (target ? `🧩 Features for user <b>${target}</b> (overrides the defaults)` : '🧩 Default features for <b>all users</b>') : `🔐 Access for admin <b>${target}</b>`;
  return ask(ctx, s, 'tog', `${head}\n✅ on · ❌ off — tap an item to switch it.`, [...chunk(togItems(kind, target).map(i => `${i.on ? '✅' : '❌'} ${i.name}`), 2), ...(kind === 'feat' && target ? [['↩️ Reset to default']] : [])]);
}
F.tog = (ctx, t, s) => {
  const { kind, target } = s.tog || {}; if (!kind) return;
  if (t === '↩️ Reset to default' && kind === 'feat' && target) { const p = prof(target); delete p.feat; save(target, 'profile', p); refreshMenus(); return askToggles(ctx, s, kind, target); }
  const it = togItems(kind, target).find(i => `${i.on ? '✅' : '❌'} ${i.name}` === t); if (!it) return;
  W.logActivity(ctx.from.id, `${kind}-toggle`, target ?? 'everyone', `${it.name} → ${it.on ? 'off' : 'on'}`);
  if (kind === 'feat') {
    if (target) { const p = prof(target); p.feat = { ...(p.feat || {}), [it.k]: !it.on }; save(target, 'profile', p); }
    else { const g = load('_g', 'features', {}); g[it.k] = !it.on; save('_g', 'features', g); }
  } else {
    const P = load('_g', 'admin_perms', {}), cur = new Set(P[String(target)] ?? Object.keys(PERMS)); it.on ? cur.delete(it.k) : cur.add(it.k); P[String(target)] = [...cur]; save('_g', 'admin_perms', P);
  }
  refreshMenus(); St(ctx.from.id).keyboardRows = undefined;
  return askToggles(ctx, s, kind, target);
};
A['🌐 Default features'] = ctx => askToggles(ctx, St(ctx.from.id), 'feat', null);
A['🧑 User features'] = ctx => pickUserPrompt(ctx, St(ctx.from.id), 'featUser', '🧑 Choose a user — send the number or Telegram ID:');
F.featUser = (ctx, t, s) => { const id = resolveUser(t, s); return id ? askToggles(ctx, s, 'feat', id) : out(ctx, 'Send a number from the list or a valid Telegram ID.'); };
A['🔐 Admin access'] = ctx => {
  const s = St(ctx.from.id), list = W.adminList().filter(a => String(a) !== String(CFG.admin));
  if (!list.length) return out(ctx, 'There are no other admins yet. Use ➕ Add admin first.');
  s.userPick = list; return ask(ctx, s, 'permAdmin', `🔐 Choose an admin — send the number or ID:\n\n${list.map((id, i) => `${i + 1}. ${id}`).join('\n')}`);
};
F.permAdmin = (ctx, t, s) => { const x = t.trim(), id = (/^\d{1,3}$/.test(x) && s.userPick?.[+x - 1]) || (s.userPick?.includes(x) ? x : null); return id ? askToggles(ctx, s, 'perm', String(id)) : out(ctx, 'Send a number from the list or an admin ID.'); };
A['🤖 Auto session repair'] = ctx => { const on = CFG.autoRepair === false; W.setCfg('autoRepair', on); return out(ctx, `🤖 Automatic session repair: <b>${on ? 'ON' : 'OFF'}</b>`); };

// ---------- messages to numbers, saved lists, WhatsApp groups and channels ----------
const MSG_TYPES = { '📝 Message text': 'text', '🖼 Message image': 'image', '🎬 Message video': 'video', '🎵 Message audio': 'audio', '📎 Message file': 'file' };
A['✉️ New message'] = async ctx => {
  if (!(await ready(ctx))) return;
  const s = St(ctx.from.id), x = W.msgUsage(ctx.from.id); s.msg = {}; s.isMsg = true;
  return ask(ctx, s, 'mtype', `✉️ What do you want to send?\nToday: ${x.n} of ${x.cap} messages used. Up to ${x.max} recipients per message.`, [['📝 Message text', '🖼 Message image'], ['🎬 Message video', '🎵 Message audio'], ['📎 Message file']]);
};
F.mtype = (ctx, t, s) => {
  const k = MSG_TYPES[t]; if (!k) return;
  if (k === 'text') return ask(ctx, s, 'mtext', "Send the message. Use {name} for the person's first name.");
  return ask(ctx, s, 'mmedia', `Send the ${k === 'file' ? 'file (PDF, document…)' : k}. You can add a caption, and {name} works there too.`);
};
F.mtext = (ctx, t, s) => { s.msg = { type: 'text', text: t.slice(0, 4000) }; return askMsgTarget(ctx, s); };
const askMsgTarget = (ctx, s) => ask(ctx, s, 'mtarget', 'Who should receive it?', [['📱 Number(s)', '📋 A saved list'], ['👪 WhatsApp groups', '📚 A group list'], ['📺 Channel']]);
const gname = g => g.subject || '(no name)';
F.mtarget = (ctx, t, s) => {
  const u = ctx.from.id;
  if (t === '📱 Number(s)') return ask(ctx, s, 'mnums', 'Send one or more numbers with country code (one per line, or separated by commas).');
  if (t === '📋 A saved list') { const L = Object.keys(load(u, 'lists', {})); return L.length ? ask(ctx, s, 'mlist', 'Choose the list.', chunk(L, 2)) : out(ctx, 'You have no saved lists yet. Create one under Audience → Lists.'); }
  if (t === '👪 WhatsApp groups') {
    if (!Object.keys(load(u, 'groups', {})).length) return out(ctx, 'No groups are synced yet. Please try again in a few minutes.');
    s.msel = []; s.gview = [];
    return ask(ctx, s, 'mgroups', 'Send a word from a group name to search, or choose 🔍 Show first 40. Then send the numbers you want, like 1 3 5 or 2-6.', [['🔍 Show first 40', '👑 Add all I admin'], ['✅ Done selecting', '🗑 Clear']]);
  }
  if (t === '📚 A group list') { const L = Object.keys(load(u, 'grouplists', {})); return L.length ? ask(ctx, s, 'mgl', 'Choose the group list.', chunk(L, 2)) : out(ctx, 'You have no group lists yet. Create one under ✉️ Messages → 📚 Group lists.'); }
  if (t === '📺 Channel') {
    const H = load(u, 'channels', {}), ids = Object.keys(H); if (!ids.length) return out(ctx, 'No channels saved yet. Add one under ✉️ Messages → 📺 My channels.');
    s.gview = ids; return ask(ctx, s, 'mchan', `Which channel? Send the number (or several, like 1 2).\n\n${ids.map((id, n) => `${n + 1}. ${esc(H[id].name)} (${esc(H[id].role || '?')})`).join('\n')}`);
  }
};
F.mnums = (ctx, t, s) => {
  const n = nums(t), max = W.msgUsage(ctx.from.id).max;
  if (!n.length) return out(ctx, 'Send at least one valid number with country code.');
  if (n.length > max && !isAdm(ctx.from.id)) return out(ctx, `That is ${n.length} numbers; the limit is ${max} per message.`);
  s.msg.target = { kind: 'numbers', numbers: n }; return askMsgWhen(ctx, s);
};
F.mlist = (ctx, t, s) => { if (!load(ctx.from.id, 'lists', {})[t]) return out(ctx, 'Choose a list from the buttons.'); s.msg.target = { kind: 'list', name: t }; return askMsgWhen(ctx, s); };
F.mchan = (ctx, t, s) => { const idx = parseIdx(t, s.gview?.length || 0); if (!idx?.length) return out(ctx, 'Send a number from the list.'); s.msg.target = { kind: 'channels', ids: idx.map(n => s.gview[n - 1]) }; return askMsgWhen(ctx, s); };
function pickGroups(ctx, t, s, done) {                              // shared by "message groups" and "group lists"
  const G = load(ctx.from.id, 'groups', {}), all = Object.entries(G).sort((a, b) => gname(a[1]).localeCompare(gname(b[1])));
  s.msel ||= []; s.gview ||= [];
  if (t === '✅ Done selecting') { if (!s.msel.length) return out(ctx, 'Select at least one group first.'); return done([...s.msel]); }
  if (t === '🗑 Clear') { s.msel = []; return out(ctx, 'Selection cleared.'); }
  if (t === '👑 Add all I admin') { for (const [id, g] of all) if (g.role === 'admin' && !s.msel.includes(id)) s.msel.push(id); return out(ctx, `✅ ${s.msel.length} group${s.msel.length === 1 ? '' : 's'} selected.`); }
  if (/^[\d\s,\-]+$/.test(t) && s.gview.length) {
    const idx = parseIdx(t, s.gview.length); if (!idx?.length) return out(ctx, 'Send numbers from the list shown.');
    for (const n of idx) { const id = s.gview[n - 1]; if (!s.msel.includes(id)) s.msel.push(id); }
    return out(ctx, `✅ ${s.msel.length} group${s.msel.length === 1 ? '' : 's'} selected. Search again, or choose ✅ Done selecting.`);
  }
  const term = t === '🔍 Show first 40' ? '' : t.toLowerCase(), view = all.filter(([, g]) => !term || gname(g).toLowerCase().includes(term)).slice(0, 40);
  if (!view.length) return out(ctx, 'No group matches that. Try another word.');
  s.gview = view.map(([id]) => id);
  return out(ctx, `${view.map(([id, g], n) => `${n + 1}. ${esc(gname(g))} (${g.size || 0})${g.role === 'admin' ? ' 👑' : ''}${s.msel.includes(id) ? ' ✅' : ''}`).join('\n')}\n\nSend the numbers to add. Selected so far: ${s.msel.length}.`);
}
F.mgroups = (ctx, t, s) => pickGroups(ctx, t, s, ids => { s.msg.target = { kind: 'groups', ids }; return askMsgWhen(ctx, s); });
F.mgl = (ctx, t, s) => { if (!load(ctx.from.id, 'grouplists', {})[t]) return out(ctx, 'Choose a list from the buttons.'); s.msg.target = { kind: 'grouplist', name: t }; return askMsgWhen(ctx, s); };

// ---------- saved lists of WhatsApp groups ----------
const GL_HELP = 'Send a word from a group name to search, or choose 🔍 Show first 40. Then send the numbers you want, like 1 3 5 or 2-6.';
const GL_ROWS = [['🔍 Show first 40', '👑 Add all I admin'], ['✅ Done selecting', '🗑 Clear']];
const glNames = u => Object.keys(load(u, 'grouplists', {}));
F.glpick = (ctx, t, s) => pickGroups(ctx, t, s, ids => {
  const u = ctx.from.id, GL = load(u, 'grouplists', {}), name = s.glname;
  GL[name] = [...new Set([...(GL[name] || []), ...ids])]; save(u, 'grouplists', GL); reset(s);
  return out(ctx, `✅ “${esc(name)}” now has ${GL[name].length} group${GL[name].length === 1 ? '' : 's'}.`);
});
A['➕ New group list'] = ctx => {
  if (!Object.keys(load(ctx.from.id, 'groups', {})).length) return out(ctx, 'No groups are synced yet. Please try again in a few minutes.');
  return ask(ctx, St(ctx.from.id), 'glnew', 'Name the group list, for example Church groups or Customers.');
};
F.glnew = (ctx, t, s) => {
  const u = ctx.from.id, name = t.trim().slice(0, 30); if (!name) return out(ctx, 'Send a name for the list.');
  const GL = load(u, 'grouplists', {}); GL[name] ??= []; save(u, 'grouplists', GL); s.glname = name; s.msel = []; s.gview = [];
  return ask(ctx, s, 'glpick', `📚 “${esc(name)}” is ready. ${GL_HELP}`, GL_ROWS);
};
A['➕ Add groups to a list'] = ctx => glNames(ctx.from.id).length ? ask(ctx, St(ctx.from.id), 'gladd', 'Which list?', chunk(glNames(ctx.from.id), 2)) : out(ctx, 'No group lists yet. Create one first.');
F.gladd = (ctx, t, s) => { if (!load(ctx.from.id, 'grouplists', {})[t]) return out(ctx, 'Choose a list from the buttons.'); s.glname = t; s.msel = []; s.gview = []; return ask(ctx, s, 'glpick', GL_HELP, GL_ROWS); };
A['📖 View group lists'] = ctx => {
  const u = ctx.from.id, GL = load(u, 'grouplists', {}), G = load(u, 'groups', {}), names = Object.keys(GL);
  if (!names.length) return out(ctx, 'No group lists yet.');
  return sendBatches(ctx, `📚 <b>${names.length} group list${names.length === 1 ? '' : 's'}</b>`, names.map(n => { const live = GL[n].filter(id => G[id]); return `<b>${esc(n)}</b> (${live.length})\n${live.slice(0, 12).map(id => esc(gname(G[id]))).join(', ')}${live.length > 12 ? ` … +${live.length - 12} more` : ''}\n`; }));
};
A['➖ Remove from a list'] = ctx => glNames(ctx.from.id).length ? ask(ctx, St(ctx.from.id), 'glrmList', 'Which list?', chunk(glNames(ctx.from.id), 2)) : out(ctx, 'No group lists yet.');
F.glrmList = (ctx, t, s) => {
  const u = ctx.from.id, GL = load(u, 'grouplists', {}), G = load(u, 'groups', {}); if (!GL[t]) return out(ctx, 'Choose a list from the buttons.');
  s.glname = t; s.gview = GL[t].filter(id => G[id]); if (!s.gview.length) { reset(s); return out(ctx, 'That list has no groups.'); }
  out(ctx, s.gview.map((id, n) => `${n + 1}. ${esc(gname(G[id]))}`).join('\n').slice(0, 3800));
  return ask(ctx, s, 'glrm', 'Send the numbers to remove (like 1 3 or 2-6).');
};
F.glrm = (ctx, t, s) => {
  const u = ctx.from.id, idx = parseIdx(t, s.gview?.length || 0); if (!idx?.length) return out(ctx, 'Send numbers like 1 3, or a range like 2-6.');
  const GL = load(u, 'grouplists', {}), drop = new Set(idx.map(n => s.gview[n - 1])); GL[s.glname] = (GL[s.glname] || []).filter(id => !drop.has(id)); save(u, 'grouplists', GL); reset(s);
  return out(ctx, `✅ Removed ${drop.size}. “${esc(s.glname)}” has ${GL[s.glname].length} left.`);
};
A['🗑 Delete group list'] = ctx => glNames(ctx.from.id).length ? ask(ctx, St(ctx.from.id), 'gldel', 'Delete which list?', chunk(glNames(ctx.from.id), 2)) : out(ctx, 'No group lists yet.');
F.gldel = (ctx, t, s) => { const u = ctx.from.id, GL = load(u, 'grouplists', {}); if (!GL[t]) return out(ctx, 'Choose a list from the buttons.'); delete GL[t]; save(u, 'grouplists', GL); reset(s); return out(ctx, `🗑 “${esc(t)}” deleted.`); };
const targetText = t => ({ grouplist: `group list “${t?.name}”`, numbers: `${(t.numbers || []).length} number(s)`, list: `list “${t.name}”`, groups: `${(t.ids || []).length} group(s)`, channels: `${(t.ids || []).length} channel(s)` })[t?.kind] || '?';
function askMsgWhen(ctx, s) {
  const u = ctx.from.id, n = W.targetCount(u, s.msg.target), x = W.msgUsage(u);
  return ask(ctx, s, 'mwhen', `✉️ ${esc((s.msg.type === 'text' ? s.msg.text : s.msg.caption || s.msg.type).replace(/\s+/g, ' ').slice(0, 60))}\n→ ${esc(targetText(s.msg.target))} (${n} will receive it)\nToday: ${x.n} of ${x.cap} messages used.\n\nWhen should it go?`, [['🚀 Send now', '🗓 Schedule']]);
}
F.mwhen = async (ctx, t, s) => {
  const u = ctx.from.id;
  if (t === '🗓 Schedule') return askDate(ctx, s);
  if (t !== '🚀 Send now') return;
  if (!(await ready(ctx))) return;
  const sg = W.checkSpam(u, s.msg); if (!sg.ok) return out(ctx, `🛡 Spam guard: this message ${esc(sg.reason)}.`);
  const m = { ...s.msg, id: Date.now() }; reset(s); await go(ctx, 'home'); startMsgNow(ctx, u, m);
};
function startMsgNow(ctx, u, m) {
  ctx.reply('⏳ Preparing your message…').then(msg => {
    const edit = x => tg.editMessageText(ctx.chat.id, msg.message_id, undefined, x).catch(() => {});
    const del = ms => { const tm = setTimeout(() => tg.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), ms); tm.unref?.(); };
    let last = 0;
    W.runMessage(u, m, (d, tot) => { if (Date.now() - last < 4000 && d < tot) return; last = Date.now(); edit(`✉️ Sent ${d} of ${tot}… You can stop it any time in Post → 📡 Sending now.`); })
      .then(r => { edit(`✅ Done: ${r.ok} sent${r.fail ? `, ${r.fail} failed` : ''}${r.cancelled ? ' (stopped)' : ''}.`); del(15000); })
      .catch(e => { edit(`❌ ${e.message}`); del(20000); });
  });
}
const msgsOf = u => load(u, 'msgs', []).filter(x => x.status === 'scheduled').sort((a, b) => a.at - b.at);
const msgRow = (m, n) => `${n + 1}. ${{ text: '📝', image: '🖼', video: '🎬', audio: '🎵', document: '📎' }[m.type] || '✉️'} ${esc(fmt(m.at))}${m.repeat && m.repeat !== 'none' ? ' 🔁' + esc(m.repeat) : ''} → ${esc(targetText(m.target))} — ${esc(String(m.type === 'text' ? m.text : m.caption || m.type).replace(/\s+/g, ' ').slice(0, 30))}`;
A['📋 Scheduled messages'] = ctx => {
  const L = msgsOf(ctx.from.id); if (!L.length) return out(ctx, 'No scheduled messages.');
  const s = St(ctx.from.id); s.pick = L.slice(0, 60).map(m => m.id);
  return ask(ctx, s, 'mcancel', `${L.slice(0, 60).map(msgRow).join('\n')}\n\nSend the numbers to cancel (like 1 3, or 2-4, or all). Choose ⬅️ Back to keep them all.`);
};
F.mcancel = (ctx, t, s) => {
  const u = ctx.from.id, idx = parseIdx(t, s.pick?.length || 0); if (!idx?.length) return out(ctx, 'Send numbers like 1 3, a range like 2-4, or all.');
  const M = load(u, 'msgs', []); let n = 0; for (const x of idx) { const m = M.find(y => y.id === s.pick[x - 1] && y.status === 'scheduled'); if (m) { m.status = 'cancelled'; n++; } }
  save(u, 'msgs', M); reset(s); return out(ctx, `🗑 Cancelled ${n} scheduled message${n === 1 ? '' : 's'}.`);
};
A['📺 My channels'] = ctx => {
  const u = ctx.from.id, H = load(u, 'channels', {}), ids = Object.keys(H), s = St(u); s.gview = ids;
  return ask(ctx, s, 'chanMgr', `📺 <b>Your channels</b>\n${ids.length ? ids.map((id, n) => `${n + 1}. ${esc(H[id].name)} (${esc(H[id].role || '?')})`).join('\n') : 'None saved yet.'}\n\nSend a channel link to add one, or a number to remove one. You can only post to channels you own or manage.`);
};
F.chanMgr = async (ctx, t, s) => {
  const u = ctx.from.id;
  if (/whatsapp\.com\/channel\//i.test(t)) { try { const c = await W.addChannel(u, t); return out(ctx, `✅ Added “${esc(c.name)}”${c.role ? ` (${esc(c.role)})` : ''}.`); } catch (e) { return out(ctx, `❌ ${esc(e.message)}`); } }
  const id = s.gview?.[Number.parseInt(t, 10) - 1]; if (!id) return out(ctx, 'Send a channel link to add, or a number from the list to remove.');
  const H = load(u, 'channels', {}); delete H[id]; save(u, 'channels', H); s.gview = Object.keys(H); return out(ctx, '🗑 Channel removed.');
};

// ---------- refer a friend ----------
A['🎁 Refer a friend'] = ctx => {
  const u = ctx.from.id, p = prof(u), rd = Number(CFG.refDays ?? 7);
  if (!(rd > 0)) return out(ctx, 'Referrals are not active right now.');
  if (!botUser) return out(ctx, 'Please try again in a moment.');
  return out(ctx, `🎁 <b>Refer a friend</b>\nShare your link. When someone joins with it and makes their first payment, you get <b>${rd} free days</b>.\n\n🔗 https://t.me/${botUser}?start=ref_${Number(u).toString(36)}\n\n👥 Joined: ${p.refJoined || 0} · 💳 Paid: ${p.refPaid || 0} · 🎁 Days earned: ${p.refDaysEarned || 0}`, { disable_web_page_preview: true }, true);
};

// ---------- delete a post you already sent (statuses last 24 h) ----------
A['🗑 Delete a sent post'] = ctx => {
  const u = ctx.from.id, H = load(u, 'history', []).filter(h => h.msgId && !h.deleted && Date.now() - h.at < 24 * 36e5).slice(-10).reverse();
  if (!H.length) return out(ctx, 'No posts from the last 24 hours can be deleted. Statuses disappear after 24 hours anyway.');
  const s = St(u); s.pick = H.map(h => h.id);
  return ask(ctx, s, 'unsendPick', `🗑 Which post should be removed from your status?\n\n${H.map((h, i) => `${i + 1}. ${esc(fmt(h.at))} — “${esc(h.preview)}” — ${Math.max(0, (h.n || 1) - 1)} people`).join('\n')}\n\nSend the number.`);
};
F.unsendPick = (ctx, t, s) => {
  const id = s.pick?.[Number.parseInt(t, 10) - 1]; if (id === undefined) return out(ctx, 'Send a number from the list.');
  s.unsend = id; return ask(ctx, s, 'unsendConfirm', 'This removes the post from everyone it was sent to. People who already viewed it did see it. Continue?', [['✅ Yes', 'No']]);
};
F.unsendConfirm = async (ctx, t, s) => {
  const u = ctx.from.id, id = s.unsend;
  if (!isYes(t)) { reset(s); return out(ctx, 'Nothing was deleted.'); }
  await go(ctx, cur(s), false, true);
  const m = await ctx.reply('⏳ Removing the post…'), edit = x => tg.editMessageText(ctx.chat.id, m.message_id, undefined, x).catch(() => {});
  let last = 0;
  W.deleteSentPost(u, id, (d, tot) => { if (Date.now() - last < 4000 && d < tot) return; last = Date.now(); edit(`🗑 Removed from ${d} of ${tot} people…`); })
    .then(r => { edit(`✅ Post removed from ${r.count} people.`); const tm = setTimeout(() => tg.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 12000); tm.unref?.(); })
    .catch(e => edit(`❌ ${e.message}`));
};

// ---------- activity log ----------
A['🧾 Activity log'] = ctx => {
  const L = W.activityLog(80); if (!L.length) return out(ctx, 'Nothing has been logged yet.');
  return sendBatches(ctx, `🧾 <b>Activity log</b> (newest first)`, L.map(e => `${esc(fmt(e.t))} · ${e.actor === 'system' ? 'system' : `${e.actor} ${esc(prof(e.actor).name || '')}`} · ${esc(e.action)}${e.target ? ' · ' + esc(e.target) : ''}${e.detail ? ' · ' + esc(e.detail) : ''}`));
};

// ---------- online payments + spam guard (admin settings) ----------
A['🌐 Online payments'] = ctx => ask(ctx, St(ctx.from.id), 'payProv', `🌐 Automatic payment checking\nProvider: <b>${esc(W.payProvider() || 'off')}</b> · Secret key: <b>${W.onlinePayOn() || CFG.paySecret ? 'set' : 'not set'}</b>\n\nChoose a provider. Plan prices must contain the amount, for example ₦5,000.`, [['Paystack', 'Flutterwave'], ['Off']]);
F.payProv = (ctx, t, s) => { const v = { Paystack: 'paystack', Flutterwave: 'flutterwave', Off: '' }[t]; if (v === undefined) return; W.setCfg('payProvider', v); W.logActivity(ctx.from.id, 'setting', 'payProvider', v || 'off'); reset(s); return out(ctx, `✅ Online payments: ${v || 'off'}${v && !(CFG.paySecret || process.env.PAY_SECRET_KEY) ? '\nNow set 🔑 Payment key.' : ''}`); };
A['🔑 Payment key'] = ctx => ask(ctx, St(ctx.from.id), 'payKey', 'Send your SECRET key (Paystack sk_… or Flutterwave FLWSECK-…). I delete your message right away.\nSafer: put PAY_SECRET_KEY in your .env file instead.');
F.payKey = (ctx, t, s) => { W.setCfg('paySecret', t.trim()); W.logActivity(ctx.from.id, 'setting', 'paySecret', 'changed'); reset(s); return out(ctx, '✅ Payment key saved (your message was deleted).'); };
A['🛡 Spam guard'] = ctx => { const on = CFG.spamGuard === false; W.setCfg('spamGuard', on); W.logActivity(ctx.from.id, 'setting', 'spamGuard', on ? 'on' : 'off'); return out(ctx, `🛡 Spam guard: <b>${on ? 'ON' : 'OFF'}</b>`); };

// ---------- reach-out ----------
A['🔛 Reach-out on/off'] = ctx => {
  const u = ctx.from.id, r = W.reachState(u);
  if (r.on) { r.on = false; save(u, 'profile', prof(u)); return out(ctx, '📣 Reach-out is now <b>OFF</b>.'); }
  return ask(ctx, St(u), 'reachOn', `📣 <b>Reach-out</b> sends up to ${Math.min(r.perDay, Number(CFG.reachMax ?? 10))} short messages a day (between 9 AM and 7 PM) from YOUR WhatsApp to contacts you saved but have not chatted with in ${r.minDays} days, with your own friendly message.\n\n⚠️ Unwanted messages are a common reason WhatsApp restricts numbers, so keep the number low. If someone asks you to stop, the bot quietly stops messaging them.\n\nTurn it on?`, [['✅ Yes', 'No']]);
};
F.reachOn = async (ctx, t, s) => {
  const u = ctx.from.id; if (!isYes(t)) { reset(s); return out(ctx, 'Reach-out stays off.'); }
  const r = W.reachState(u); r.on = true; r.nextAt = Date.now() + 5 * 60e3; save(u, 'profile', prof(u)); reset(s);
  return out(ctx, '📣 Reach-out is <b>ON</b>. The first message goes out within a few minutes (9 AM–7 PM only).');
};
A['📊 Reach-out stats'] = ctx => {
  const u = ctx.from.id, r = W.reachState(u), C = Object.values(load(u, 'contacts', {}));
  return out(ctx, `📣 <b>Reach-out</b> is ${r.on ? '🟢 ON' : '⚪ OFF'}\nPer day: ${r.perDay} · Today: ${r.n || 0}\nSent in total: ${r.total || 0}\n💬 Replies: ${r.replies || 0}\n👁 Viewed your status since: ${C.filter(c => c.reachedAt && c.lastView > c.reachedAt).length}\n🚫 Asked to stop: ${C.filter(c => c.optOut).length}`, {}, true);
};
A['✏️ Reach-out messages'] = ctx => {
  const r = W.reachState(ctx.from.id), cur = r.msgs?.length ? r.msgs : W.REACH_DEFAULT;
  return ask(ctx, St(ctx.from.id), 'reachMsgs', `✏️ Current messages:\n${cur.map((m, n) => `${n + 1}. ${esc(m)}`).join('\n')}\n\nSend up to 5 new messages, one per line. Use {name} for their first name. Write them the way you would normally text: greetings, check-ins, event invites.`, [['↩️ Use defaults']]);
};
F.reachMsgs = (ctx, t, s) => {
  const u = ctx.from.id, r = W.reachState(u);
  r.msgs = t === '↩️ Use defaults' ? [] : t.split('\n').map(x => x.trim()).filter(x => x.length >= 8 && x.length <= 300).slice(0, 5);
  save(u, 'profile', prof(u)); reset(s); return out(ctx, r.msgs.length ? `✅ Saved ${r.msgs.length} message${r.msgs.length === 1 ? '' : 's'}.` : '✅ Using the default messages.');
};
A['🔢 Reach-out per day'] = ctx => ask(ctx, St(ctx.from.id), 'reachPer', `How many reach-out messages per day? (1 to ${Number(CFG.reachMax ?? 10)})`);
F.reachPer = (ctx, t, s) => { const n = Number(t), max = Number(CFG.reachMax ?? 10); if (!Number.isInteger(n) || n < 1 || n > max) return out(ctx, `Send a whole number from 1 to ${max}.`); const u = ctx.from.id, r = W.reachState(u); r.perDay = n; save(u, 'profile', prof(u)); reset(s); return out(ctx, `✅ ${n} per day.`); };

// Handle media uploads only in the matching step (receipts are handled first).
bot.on('text', async ctx => {
  const text = normalizeButton(ctx.message.text.trim()), u = ctx.from.id, s = St(u);
  if (text.startsWith('/')) return out(ctx, 'Please use the menu buttons below.');
  if (text === '🏠 Home') { reset(s); return go(ctx, 'home', false); }
  if (text === '⬅️ Back') {
    reset(s);
    if (s.nav.length > 1) s.nav.pop();
    return go(ctx, cur(s), false);
  }
  const action = A[text];
  if (action && !canSee(u, text)) return out(ctx, '🔒 That option is not available on your account.');
  if (action) {
    try { await action(ctx); }
    catch (e) { await out(ctx, `❌ ${esc(e?.message || 'Could not complete that action.')}`); }
    return;
  }
  if (s.step && F[s.step]) {
    try { await F[s.step](ctx, text, s); }
    catch (e) { await out(ctx, `❌ ${esc(e?.message || 'Could not complete that step.')}`); }
    return;
  }
  if (s.step) return out(ctx, 'Please follow the current prompt, or choose ⬅️ Back or 🏠 Home.');
  return out(ctx, 'Choose an option from the menu below.');
});

bot.on('message', ctx => {
  if (ctx.message?.text) return;
  const s = St(ctx.from.id);
  if (s.step === 'receipt') return receipt(ctx).catch(e => out(ctx, `❌ ${esc(e.message)}`));
  if (s.step === 'msgadm') return out(ctx, 'Please send your message as text.');
  if (s.step === 'restore') return restoreDoc(ctx);
  if (!['pmedia', 'queue', 'mmedia'].includes(s.step)) return;
  return (async () => {
    const u = ctx.from.id, m = ctx.message;
    ctx.deleteMessage().catch(() => {});
    let it;
    try {
      if (m.photo) it = { type: 'image', file: await fetchTo(ctx, m.photo.at(-1).file_id, 'jpg'), caption: m.caption };
      else if (m.video) it = { type: 'video', file: await fetchTo(ctx, m.video.file_id, 'mp4'), caption: m.caption };
      else if (m.voice || m.audio) it = { type: 'audio', file: await fetchTo(ctx, (m.voice || m.audio).file_id, m.voice ? 'ogg' : 'mp3') };
      else if (m.document && s.step === 'mmedia') it = { type: 'document', file: await fetchTo(ctx, m.document.file_id, ((m.document.file_name || '').split('.').pop() || 'bin').slice(0, 8)), fileName: m.document.file_name, mime: m.document.mime_type, caption: m.caption };
      else return;
    } catch { return out(ctx, '❌ Could not download that file (Telegram limit is 20 MB).'); }
    if (s.step === 'queue') {
      if (s.q.length >= 50) return out(ctx, 'The queue limit is 50 files. Finish this queue before adding more.');
      const p = prof(u); s.q.push({ ...it, bg: p.color, tc: p.textColor, font: p.font });
      return out(ctx, `➕ Added #${s.q.length}. Send another file or choose ✔ Finish queue.`);
    }
    if (s.step === 'mmedia') { s.msg = { ...it }; return askMsgTarget(ctx, s); }
    s.p = it; return askAud(ctx, s);
  })().catch(e => out(ctx, `❌ ${esc(e?.message || 'Could not process that file.')}`));
});

// ---------- start polling and graceful shutdown ----------
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  try { bot.stop(signal); } catch {}
  await W.shutdown();
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

async function resumeLinkedSessions() {                            // one session every 1–3 seconds: a restart must not stampede WhatsApp or the server
  for (const uid of users()) {
    if (!W.linked(uid)) continue;
    W.connect(uid, 'resume').catch(e => console.error(`WhatsApp resume failed for ${uid}:`, e?.message || e));
    await new Promise(r => setTimeout(r, 150 + Math.random() * 300));
  }
}

async function clearBotMenu() {                                   // no slash commands anywhere → the blue ☰ button disappears
  const scopes = [undefined, { type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }, { type: 'all_chat_administrators' }];
  const langs = [undefined, 'en', 'fr', 'es', 'pt', 'ar', 'ru', 'hi', 'id', 'tr', 'ha', 'yo', 'ig', 'sw'];
  for (const scope of scopes) for (const language_code of langs) {
    try { await tg.callApi('deleteMyCommands', { ...(scope ? { scope } : {}), ...(language_code ? { language_code } : {}) }); } catch {}
  }
  try { await tg.callApi('setChatMenuButton', { menu_button: { type: 'default' } }); } catch {}
}
function main() {
  W.lockOrExit();
  resumeLinkedSessions();                                          // do NOT wait for Telegram: WhatsApp sessions come up immediately on start
  if (process.env.PROXY_URL) {                                     // Render's free tier sleeps after ~15 min idle: ping it so the Mini App never hits a cold start
    const ping = () => fetch(process.env.PROXY_URL.replace(/\/$/, '') + '/healthz', { signal: AbortSignal.timeout(20000) }).catch(() => {});
    ping(); setInterval(ping, 9 * 60e3).unref();
  }
  if (process.env.MINIAPP_ORIGIN) startApi({ port: Number(process.env.MINIAPP_PORT || 3000), origins: process.env.MINIAPP_ORIGIN.split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean), token: CFG.token, W, canSee, isAdm, build: BUILD, bot: {
    featList: target => Object.entries(FEATURES).map(([k, f]) => ({ k, name: f.name, on: !!featState(target, k), custom: !!target && prof(target).feat?.[k] !== undefined })),
    featSet: (target, k, on) => { if (!FEATURES[k]) return false; if (target) { const p = prof(target); p.feat = { ...(p.feat || {}), [k]: !!on }; save(target, 'profile', p); } else { const g = load('_g', 'features', {}); g[k] = !!on; save('_g', 'features', g); } refreshMenus(); return true; },
    featReset: target => { const p = prof(target); delete p.feat; save(target, 'profile', p); refreshMenus(); },
    audienceCount: k => audienceOf(k).length,
    broadcast: (adminId, text, aud) => { const uids = audienceOf(aud), ctx = { from: { id: adminId }, chat: { id: adminId }, reply: (t, e) => tg.sendMessage(adminId, t, e) }; void runCampaign(ctx, newCampaign(ctx, { kind: 'message', text: text.slice(0, 4000) }), uids); return uids.length; },
    campaigns: () => campaigns().slice(-10).reverse().map(c => ({ id: c.id, kind: c.kind, at: c.at, title: String(c.kind === 'poll' ? c.question : c.text).slice(0, 80), sent: c.sent, failed: c.failed, closed: !!c.closed, report: campaignReport(c).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') })),
    pinNotice: (adminId, text) => { const n = load('_g', 'notices', []); n.push({ text, at: Date.now() }); save('_g', 'notices', n.slice(-50)); const uids = users(); void (async () => { let sent = 0; for (const uid of uids) { try { const m = await tg.sendMessage(uid, `📌 ${text}`); await tg.pinChatMessage(uid, m.message_id, { disable_notification: true }).catch(() => {}); sent++; } catch {} await wait(45); } tg.sendMessage(adminId, `📌 Notice delivered to ${sent} user${sent === 1 ? '' : 's'}.`).catch(() => {}); })(); return uids.length; },
    replyUser: (uid, text) => tg.sendMessage(uid, `📩 Reply from admin:\n${text}`),
    sendFile: (uid, text, filename, caption) => tg.sendDocument(uid, { source: Buffer.from(text || '—'), filename }, caption ? { caption } : {}), approvedNotice: (uid, planName, n) => { const us = St(Number(uid)); us.nav = ['home']; us.keyboardRows = MENUS.home.rows(Number(uid)); return tg.sendMessage(uid, `🎉 Payment approved! ${planName ? esc(planName) + ' plan: ' : ''}${n} days added. Your dashboard is updated ↓`, { parse_mode: 'HTML', ...keyboardFor(Number(uid)) }).catch(() => {}); }, declinedNotice: uid => tg.sendMessage(uid, '❌ Your payment receipt was declined. Contact the admin if you need help.').catch(() => {}), reachMax: () => Number(CFG.reachMax ?? 10), hasAdmin: () => !!CFG.admin, notifyAdmin: text => tg.sendMessage(CFG.admin, text, { parse_mode: 'HTML' }), esc, refDays: () => Number(CFG.refDays ?? 7), refLink: u => botUser ? `https://t.me/${botUser}?start=ref_${Number(u).toString(36)}` : '' } });
  // Telegraf's launch promise remains pending for as long as polling runs.
  // Use its onLaunch callback for startup work instead of awaiting that promise.
  bot.launch({ allowedUpdates: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'poll', 'poll_answer', 'message_reaction'] }, () => {
    console.log('Telegram API connected; long polling is starting.');
    void clearBotMenu();
    console.log('Bot running — build', BUILD);
    if (CFG.admin) tg.sendMessage(CFG.admin, `✅ Bot started.\nBuild: ${BUILD}`).catch(() => {});
    tg.getMe().then(me => { botUser = me.username || ''; }).catch(() => {});
    W.startScheduler();
  }).catch(async err => {
    console.error('Telegram bot failed to start:', err?.message || err);
    process.exitCode = 1;
    await shutdown('startup failure');
  });
}

main();

