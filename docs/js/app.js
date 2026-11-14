// Rummy (without lay-downs): screens, server calls, live updates and the hand.
import * as Cards from './cards.js?v=1';
import * as SFX from './sfx.js?v=1';

const $ = (id) => document.getElementById(id);
const CFG = window.RUMMY_CONFIG;
const db = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
window.__rummyDb = db;

const MSG = {
  not_your_turn: 'זה לא התור שלך', stale: 'המשחק התעדכן — נסה שוב', wrong_phase: 'קודם שולפים אבן, אחר כך זורקים',
  game_over: 'המשחק כבר נגמר', game_gone: 'המשחק לא נמצא', not_in_game: 'אתה לא משתתף במשחק הזה',
  room_full: 'השולחן מלא', room_playing: 'המשחק בשולחן הזה כבר התחיל', room_gone: 'השולחן כבר לא קיים',
  in_game: 'אתה באמצע משחק — חוזרים אליו', not_host: 'רק מי שפתח את השולחן יכול לעשות את זה',
  need_players: 'צריך לפחות 2 משתתפים (אפשר להוסיף בוט)', nick_taken: 'הכינוי הזה תפוס, בחר אחר',
  bad_nick: 'כינוי צריך להיות 2–14 תווים', not_a_win: 'היד עדיין לא מסתדרת כולה', not_your_card: 'האבן הזאת לא אצלך',
  pile_empty: 'הערימה ריקה', not_logged_in: 'צריך להתחבר מחדש', no_profile: 'צריך להתחבר מחדש',
  network: 'אין חיבור לשרת. בודקים שוב…',
};

let me = null;              // { nickname, wins, games }
const imagesReady = Cards.loadImages();
let screen = 'boot';
let timers = [];
let channels = [];

// ---------- helpers ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id);
  screen = id;
}
let toastT;
function toast(text, ms = 2200) {
  const t = $('toast'); t.textContent = text; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}
async function rpc(fn, args = {}) {
  let res;
  try { res = await db.rpc(fn, args); } catch (e) { throw Object.assign(new Error('network'), { code: 'network' }); }
  if (res.error) {
    const m = String(res.error.message || '');
    const code = Object.keys(MSG).find((k) => m.includes(k)) || (/fetch|network/i.test(m) ? 'network' : 'other');
    const err = new Error(m); err.code = code; throw err;
  }
  return res.data;
}
function errText(e) { return MSG[e && e.code] || 'משהו השתבש. נסה שוב.'; }
function clearScreenWork() {
  timers.forEach(clearInterval); timers = [];
  channels.forEach((c) => { try { db.removeChannel(c); } catch (e) { /* ignore */ } }); channels = [];
}
function every(ms, fn) { timers.push(setInterval(fn, ms)); }
function listen(name, table, filter, fn) {
  try {
    const opts = { event: '*', schema: 'public', table }; if (filter) opts.filter = filter;
    const ch = db.channel(name + '-' + Math.random().toString(36).slice(2)).on('postgres_changes', opts, fn).subscribe();
    channels.push(ch);
  } catch (e) { /* polling keeps working */ }
}
function avatar(name, bot) {
  const s = document.createElement('span'); s.className = 'avatar' + (bot ? ' bot' : '');
  if (!bot) s.textContent = (name || '?').trim().charAt(0);
  return s;
}
function esc(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }

// nickname -> technical email (players only ever see the nickname)
function nickEmail(nick) {
  const bytes = new TextEncoder().encode(nick.trim().toLowerCase());
  return 'p' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') + '@players.rummy.game';
}

// ---------- login ----------
async function doLogin() {
  const nick = $('nick').value.trim(), pass = $('pass').value;
  $('loginErr').textContent = '';
  if (nick.length < 2 || nick.length > 14) { $('loginErr').textContent = MSG.bad_nick; return; }
  if (pass.length < 6) { $('loginErr').textContent = 'סיסמה של 6 תווים לפחות'; return; }
  const btn = $('loginBtn'); btn.disabled = true; btn.textContent = 'מתחבר…';
  SFX.unlock();
  try {
    const email = nickEmail(nick);
    let r = await db.auth.signInWithPassword({ email, password: pass });
    if (r.error && /invalid login credentials/i.test(r.error.message)) {
      r = await db.auth.signUp({ email, password: pass, options: { data: { nick } } });
      if (r.error && /already registered|already exists/i.test(r.error.message)) throw new Error('wrongpass');
      if (r.error) throw r.error;
      if (!r.data.session) r = await db.auth.signInWithPassword({ email, password: pass });
    }
    if (r.error) throw r.error;
    try { localStorage.setItem('rummy_nick', nick); } catch (e) { /* ignore */ }
    await afterLogin(nick);
  } catch (e) {
    $('loginErr').textContent = e.message === 'wrongpass' ? 'הסיסמה לא נכונה לכינוי הזה'
      : MSG[e.code] || (/fetch|network/i.test(e.message || '') ? MSG.network : 'הכניסה נכשלה: ' + (e.message || ''));
  } finally { btn.disabled = false; btn.textContent = 'כניסה'; }
}
$('loginForm').addEventListener('submit', (ev) => { ev.preventDefault(); doLogin(); });

async function afterLogin(nickHint) {
  const { data } = await db.auth.getSession();
  const meta = data.session && data.session.user && data.session.user.user_metadata || {};
  let stored = ''; try { stored = localStorage.getItem('rummy_nick') || ''; } catch (e) { /* ignore */ }
  me = await rpc('rummy_profile_ensure', { p_nick: nickHint || meta.nick || stored || 'שחקן' });
  await route();
}

async function route() {
  const params = new URLSearchParams(location.search);
  const want = Number(params.get('room') || 0);
  if (want) history.replaceState(null, '', location.pathname);
  const cur = await rpc('rummy_current');
  if (cur.game) return openGame(cur.game);
  if (want && want !== cur.room) {
    try { await rpc('rummy_room_join', { p_room: want }); return openRoom(want); } catch (e) { toast(errText(e)); }
  }
  if (cur.room) return openRoom(cur.room);
  return openLobby();
}

// ---------- lobby ----------
let seats = 4;
for (const b of document.querySelectorAll('#seatSeg button')) {
  b.addEventListener('click', () => {
    seats = Number(b.dataset.n);
    document.querySelectorAll('#seatSeg button').forEach((x) => x.classList.toggle('on', x === b));
  });
}
// turn-time wheel (10..60 seconds, steps of 10)
let turnSecs = 30;
const wheel = $('secsWheel');
const wheelOpts = [...wheel.querySelectorAll('.opt')];
const optH = () => wheelOpts[0].offsetHeight || 36;
function wheelPick(i, smooth) {
  i = Math.max(0, Math.min(wheelOpts.length - 1, i));
  turnSecs = Number(wheelOpts[i].dataset.v);
  wheelOpts.forEach((o, k) => o.classList.toggle('on', k === i));
  wheel.scrollTo({ top: i * optH(), behavior: smooth ? 'smooth' : 'auto' });
}
let wheelT;
wheel.addEventListener('scroll', () => {
  const i = Math.round(wheel.scrollTop / optH());
  wheelOpts.forEach((o, k) => o.classList.toggle('on', k === i));
  clearTimeout(wheelT); wheelT = setTimeout(() => { turnSecs = Number(wheelOpts[Math.max(0, Math.min(5, i))].dataset.v); }, 80);
});
wheelOpts.forEach((o, i) => o.addEventListener('click', () => wheelPick(i, true)));
try { const saved = Number(localStorage.getItem('rummy_secs')); if (saved >= 10 && saved <= 60) turnSecs = saved; } catch (e) { /* ignore */ }

async function openLobby() {
  clearScreenWork(); show('lobby');
  $('meName').textContent = me.nickname;
  $('meAvatar').replaceWith(Object.assign(avatar(me.nickname), { id: 'meAvatar' }));
  requestAnimationFrame(() => wheelPick(turnSecs / 10 - 1, false));
  await loadLobby();
  every(6000, loadLobby);
  listen('lobby', 'rummy_rooms', null, () => loadLobby());
}
async function loadLobby() {
  if (screen !== 'lobby') return;
  let d;
  try { d = await rpc('rummy_lobby'); } catch (e) { if (e.code === 'network') toast(MSG.network); return; }
  if (d.my_room) return openRoom(d.my_room);
  $('meStats').textContent = `· ${d.me.wins} ניצחונות מתוך ${d.me.games} משחקים`;
  const list = $('roomList'); list.innerHTML = '';
  if (!d.rooms.length) { list.innerHTML = '<div class="empty">אין עדיין שולחנות. פתח שולחן חדש והזמן חברים, או שחק נגד בוטים.</div>'; return; }
  for (const r of d.rooms) {
    const el = document.createElement('div'); el.className = 'room-card';
    const dots = Array.from({ length: r.max }, (_, i) => `<i class="${i < r.humans ? 'h' : i < r.humans + r.bots ? 'b' : ''}"></i>`).join('');
    el.innerHTML = `<div class="info"><div class="name">${esc(r.name)}</div>
      <div class="muted">מארח: ${esc(r.host || '—')} · ${r.humans + r.bots}/${r.max} · ${r.secs || 30} שניות לתור</div><div class="dots">${dots}</div></div>
      <span class="badge ${r.status === 'playing' ? 'play' : ''}">${r.status === 'playing' ? 'במשחק' : 'ממתין'}</span>`;
    if (r.status === 'waiting') {
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'הצטרף';
      b.onclick = async () => {
        b.disabled = true;
        try { await rpc('rummy_room_join', { p_room: r.id }); openRoom(r.id); } catch (e) { toast(errText(e)); b.disabled = false; loadLobby(); }
      };
      el.appendChild(b);
    }
    list.appendChild(el);
  }
}
$('createBtn').onclick = async () => {
  const b = $('createBtn'); b.disabled = true; SFX.unlock();
  turnSecs = Number(wheelOpts[Math.max(0, Math.min(5, Math.round(wheel.scrollTop / optH())))].dataset.v) || turnSecs;
  try { localStorage.setItem('rummy_secs', String(turnSecs)); } catch (e) { /* ignore */ }
  try { const id = await rpc('rummy_room_create', { p_name: $('roomName').value, p_max: seats, p_secs: turnSecs }); $('roomName').value = ''; openRoom(id); }
  catch (e) { toast(errText(e)); if (e.code === 'in_game') route(); }
  finally { b.disabled = false; }
};
$('logoutBtn').onclick = async () => { clearScreenWork(); await db.auth.signOut(); me = null; show('login'); };

// ---------- room ----------
let roomId = null;
async function openRoom(id) {
  clearScreenWork(); roomId = id;
  $('startBtn').classList.add('hidden'); $('waitHost').classList.add('hidden');
  $('seatList').innerHTML = ''; $('roomTitle').textContent = ''; $('roomStatus').textContent = 'טוען…';
  show('room');
  await loadRoom();
  every(3000, loadRoom);
  listen('room', 'rummy_rooms', 'id=eq.' + id, () => loadRoom());
}
async function loadRoom() {
  if (screen !== 'room') return;
  let r;
  try { r = await rpc('rummy_room_get', { p_room: roomId }); } catch (e) {
    if (e.code === 'room_gone') { toast(MSG.room_gone); return openLobby(); }
    return;
  }
  if (!r.in_room) return openLobby();
  if (r.status === 'playing' && r.game_id) return openGame(r.game_id);
  $('roomTitle').textContent = r.name + ' · ' + (r.secs || 30) + ' שניות לתור';
  const filled = r.seats.length;
  $('roomStatus').textContent = filled < 2 ? 'ממתינים לשחקנים… אפשר להזמין חבר או להוסיף בוט'
    : filled < r.max ? `${filled} משתתפים — אפשר להתחיל או לחכות לעוד` : 'השולחן מלא — אפשר להתחיל!';
  const list = $('seatList'); list.innerHTML = '';
  for (let i = 0; i < r.max; i++) {
    const s = r.seats.find((x) => x.seat === i);
    const el = document.createElement('div');
    if (s) {
      el.className = 'seat'; el.appendChild(avatar(s.name, s.bot));
      const nm = document.createElement('div'); nm.className = 'nm';
      nm.innerHTML = esc(s.name) + (s.me ? ' <span class="muted">(אתה)</span>' : '') + (s.host ? '<div class="host-tag">מארח</div>' : '');
      el.appendChild(nm);
      if (s.bot && r.is_host) {
        const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'הסר בוט';
        x.onclick = async () => { try { await rpc('rummy_room_remove_bot', { p_room: roomId, p_seat: i }); loadRoom(); } catch (e) { toast(errText(e)); } };
        el.appendChild(x);
      }
    } else {
      el.className = 'seat empty';
      if (r.is_host) {
        const b = document.createElement('button'); b.className = 'btn ghost small'; b.textContent = '+ הוסף בוט';
        b.onclick = async () => { b.disabled = true; try { await rpc('rummy_room_add_bot', { p_room: roomId }); loadRoom(); } catch (e) { toast(errText(e)); } };
        el.appendChild(b);
      } else el.textContent = 'מקום פנוי';
    }
    list.appendChild(el);
  }
  $('startBtn').classList.toggle('hidden', !r.is_host);
  $('startBtn').disabled = filled < 2;
  $('waitHost').classList.toggle('hidden', r.is_host);
}
$('startBtn').onclick = async () => {
  const b = $('startBtn'); b.disabled = true; SFX.unlock();
  try { const gid = await rpc('rummy_game_start', { p_room: roomId }); openGame(gid); }
  catch (e) { toast(errText(e)); b.disabled = false; }
};
$('leaveRoomBtn').onclick = async () => { try { await rpc('rummy_room_leave'); } catch (e) { /* ignore */ } openLobby(); };
$('shareBtn').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + roomId;
  try {
    if (navigator.share) await navigator.share({ title: 'בוא לשחק רמי', text: 'בוא לשחק איתי רמי', url });
    else { await navigator.clipboard.writeText(url); toast('הקישור הועתק — שלח אותו לחבר'); }
  } catch (e) { toast(url, 5000); }
};

// ---------- game ----------
let T = null;                // 3D table
let tablePromise = null;
let G = null;                // last state shown
let gameId = null;
let lastSeq = -1;
let busy = Promise.resolve();
let pendingState = null;
let processing = false;
let hand = [];               // my cards in my order
let newCards = new Set();
let selected = null;
let acting = false;
let deadlineAt = 0;
let tickedFor = 0;
let pileStack = [];
let deckShown = 0;
let endRoomPoll = null;

function rel(seat) { return G && G.me != null ? (seat - G.me + G.n) % G.n : seat; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureTable() {
  if (T) return T;
  if (!tablePromise) {
    tablePromise = (async () => {
      try {
        await imagesReady;
        const mod = await import('./table3d.js?v=2');
        T = await mod.createTable($('stage'));
      } catch (e) {
        window.rummyReport && window.rummyReport('3d failed: ' + e.message, e.stack);
        T = null; $('stage').style.background = '#0b1511 url(assets/img/bg_lobby.webp) center/cover';
      }
      return T;
    })();
  }
  return tablePromise;
}

async function openGame(gid) {
  if (screen === 'game' && gameId === gid) return;      // already showing this game
  clearScreenWork(); show('game');
  $('end').classList.add('hidden'); $('menu').classList.add('hidden');
  if (endRoomPoll) { clearInterval(endRoomPoll); endRoomPoll = null; }
  gameId = gid; G = null; lastSeq = -1; hand = []; slots = new Array(NSLOT).fill(null); newCards.clear(); selected = null; pileStack = []; tickedFor = 0;
  $('hand').innerHTML = ''; $('tags').innerHTML = ''; $('turnBanner').textContent = 'טוען את השולחן…';
  await ensureTable();
  await refresh();
  every(3000, refresh);
  every(250, tickTimer);
  listen('game', 'rummy_games', 'id=eq.' + gid, () => refresh());
}

async function refresh() {
  if (screen !== 'game' || !gameId) return;
  try { const st = await rpc('rummy_state', { p_game: gameId }); queueState(st); }
  catch (e) { if (e.code === 'network') $('turnBanner').textContent = MSG.network; }
}

function queueState(st) {
  if (!st || st.id !== gameId) return;
  pendingState = st;
  if (processing) return;
  processing = true;
  busy = busy.then(async () => {
    while (pendingState) { const s = pendingState; pendingState = null; await process(s); }
    processing = false;
  }).catch((e) => { processing = false; window.rummyReport && window.rummyReport('process: ' + e.message, e.stack); });
}

async function process(st) {
  const first = G == null;
  if (!first && st.seq < G.seq) return;              // older than what we show
  if (!first && st.seq === G.seq && st.status === G.status && !!st.away === !!G.away) {
    G = st; deadlineAt = st.deadline_ms != null ? Date.now() + st.deadline_ms : 0; placeHud(); return;
  }
  const prev = G; G = st;
  if (first) {
    if (T) T.setPlayers(st.n);
    pileStack = st.pile_top != null ? [st.pile_top] : [];
    deckShown = st.deck_count;
    if (T && st.seq <= 1 && st.status === 'playing') { SFX.play('shuffle'); drawTableState(st, true); await T.dealAnim(st.n); }
    lastSeq = st.seq;
    render(st);
    return;
  }
  const entries = (st.log || []).filter((e) => e.n > lastSeq);
  const fast = entries.length > 16 || document.hidden;
  for (const e of entries) {
    if (!fast) await animateEntry(e, st);
    lastSeq = Math.max(lastSeq, e.n);
  }
  lastSeq = Math.max(lastSeq, st.seq);
  render(st, prev);
}

// bots (and players a bot is covering for) take about 5 seconds a turn, so a person has time to arrange his rack
const BOT_THINK_DRAW = 2200, BOT_THINK_DISCARD = 1700;
function isBotSeat(seat) { return G && seat != null && seat !== G.me && (G.bots[seat] || G.autos[seat]); }
function showTurnOf(seat) {
  if (!G || seat == null || seat === G.me) return;
  const b = $('turnBanner'); b.textContent = `התור של ${G.names[seat]}`; b.classList.remove('mine');
  for (const t of document.querySelectorAll('#tags .tag')) t.classList.toggle('turn', t.dataset.seat === String(seat));
}
async function animateEntry(e, st) {
  const r = e.seat != null ? rel(e.seat) : 0;
  if (e.seat != null && e.seat !== G.me && (e.a === 'draw' || e.a === 'discard' || e.a === 'close')) showTurnOf(e.seat);
  if (isBotSeat(e.seat)) await sleep(e.a === 'draw' ? BOT_THINK_DRAW : BOT_THINK_DISCARD);
  if (e.a === 'draw') {
    if (e.src === 'pile') { pileStack.pop(); if (T) T.drawPile(pileStack.at(-1), pileStack.length); }
    else { deckShown = Math.max(0, deckShown - 1); if (T) T.drawDeck(deckShown); }
    SFX.play('draw');
    if (T) await T.flyDraw(r, e.src === 'pile', e.c); else await sleep(250);
    if (T && r !== 0) T.drawFan(r, (G.counts[e.seat] || 14));
  } else if (e.a === 'discard' || e.a === 'close') {
    if (T) await T.flyDiscard(r, e.c); else await sleep(250);
    SFX.play('place');
    pileStack.push(e.c); if (T) T.drawPile(e.c, pileStack.length);
    if (e.a === 'discard') await sleep(r === 0 ? 50 : 250);
  } else if (e.a === 'reshuffle') {
    SFX.play('shuffle'); toast('הקופה נגמרה — האבנים שנזרקו עורבבו מחדש');
    pileStack = pileStack.slice(-1); deckShown = st.deck_count + 1; if (T) { T.drawDeck(deckShown); T.drawPile(pileStack.at(-1), 1); }
    await sleep(500);
  } else if (e.a === 'timeout') {
    toast(`הזמן של ${st.names[e.seat]} נגמר — שיחקנו בשבילו`);
  }
}

function drawTableState(st) {
  if (!T) return;
  T.drawDeck(st.deck_count); deckShown = st.deck_count;
  T.drawPile(st.pile_top, st.pile_count);
  if (st.pile_top != null && pileStack.at(-1) !== st.pile_top) pileStack = [st.pile_top];
  for (let s = 0; s < st.n; s++) if (rel(s) !== 0) T.drawFan(rel(s), st.counts[s]);
}

function render(st, prev) {
  drawTableState(st);
  const myTurn = st.status === 'playing' && st.turn === st.me;
  const wasMyTurn = prev && prev.status === 'playing' && prev.turn === prev.me && prev.phase === st.phase;
  if (myTurn && st.phase === 'draw' && !(prev && prev.turn === st.me && prev.phase === 'draw')) {
    SFX.play('turn'); try { navigator.vibrate && navigator.vibrate(60); } catch (e) { /* ignore */ }
  }
  void wasMyTurn;
  // banner
  const b = $('turnBanner');
  if (st.status !== 'playing') b.textContent = 'המשחק נגמר';
  else if (myTurn) b.textContent = st.phase === 'draw' ? 'התור שלך — שלוף אבן מהקופה או קח את האבן הפתוחה' : 'בחר אבן לזרוק — או סדר הכול וסגור';
  else b.textContent = `התור של ${st.names[st.turn]}`;
  b.classList.toggle('mine', myTurn);
  // timer
  deadlineAt = st.deadline_ms != null ? Date.now() + st.deadline_ms : 0;
  // rack: keep my own arrangement; new tiles go to a free slot
  const server = st.hand || [];
  const before = new Set(hand);
  syncSlots(server, !prev);
  newCards = new Set(prev ? server.filter((c) => !before.has(c)) : []);
  const revealTile = revealNext && newCards.size === 1 ? [...newCards][0] : null;
  if (newCards.size) revealNext = false;
  if (selected != null && !server.includes(selected)) selected = null;
  if (!(myTurn && st.phase === 'discard')) selected = null;
  renderHand();
  if (revealTile != null) reveal(revealTile);
  // piles clickable
  const canDraw = myTurn && st.phase === 'draw' && !st.away;
  $('poolBtn').disabled = !canDraw; $('poolBtn').classList.toggle('glow', canDraw);
  $('deckBtn').classList.toggle('can', canDraw);
  $('pileBtn').classList.toggle('can', canDraw && st.pile_top != null);
  $('closeBtn').classList.toggle('hidden', !(myTurn && st.phase === 'discard'));
  $('awayBar').classList.toggle('hidden', !st.away || st.status !== 'playing');
  placeHud();
  // end
  if (st.status === 'over') showEnd(st);
}

function placeHud() {
  if (!G) return;
  if (T) {
    const d = T.deckScreen(), p = T.pileScreen();
    Object.assign($('deckBtn').style, { left: d.x + 'px', top: d.y + 'px' });
    Object.assign($('pileBtn').style, { left: p.x + 'px', top: p.y + 'px' });
    $('pileBtn').classList.toggle('has', G.pile_top != null);
    $('pileBtn').style.backgroundImage = G.pile_top != null ? `url(${Cards.faceURL(G.pile_top)})` : 'none';
  } else {
    Object.assign($('deckBtn').style, { left: '42%', top: '42%' }); Object.assign($('pileBtn').style, { left: '58%', top: '42%' });
  }
  $('deckCount').textContent = `${G.deck_count} בקופה`;
  const tags = $('tags'); tags.innerHTML = '';
  for (let s = 0; s < G.n; s++) {
    const r = rel(s); if (r === 0) continue;
    const pos = T ? T.seatScreen(r) : { x: (r / G.n) * innerWidth, y: 60 };
    const el = document.createElement('div'); el.className = 'tag' + (G.turn === s && G.status === 'playing' ? ' turn' : ''); el.dataset.seat = s;
    el.appendChild(avatar(G.names[s], G.bots[s] || G.autos[s]));
    const nm = document.createElement('span'); nm.textContent = G.names[s]; el.appendChild(nm);
    const c = document.createElement('span'); c.className = 'cnt'; c.textContent = `${G.counts[s]} אבנים`; el.appendChild(c);
    if (G.online && !G.online[s]) { const o = document.createElement('i'); o.className = 'off'; o.title = 'לא מחובר'; el.appendChild(o); }
    let x = pos.x, y = Math.max(56, pos.y);
    // keep name tags off the pool and the open tile
    if (T) {
      const d = T.deckScreen(), p = T.pileScreen();
      if (y > Math.min(d.y, p.y) - 70 && y < Math.max(d.y, p.y) + 60 && x > d.x - 110 && x < p.x + 110) {
        // move it up next to the turn banner (between the menu button and the banner)
        const bl = $('turnBanner').getBoundingClientRect(), mb = $('menuBtn').getBoundingClientRect();
        x = (mb.right + bl.left) / 2; y = bl.top + bl.height / 2;
        if (bl.left - mb.right < 150) { x = d.x - 150; y = Math.max(56, pos.y); }
      }
    }
    el.style.left = Math.max(60, Math.min(innerWidth - 60, x)) + 'px'; el.style.top = y + 'px';
    tags.appendChild(el);
  }
}
window.addEventListener('resize', () => { setTimeout(() => { placeHud(); renderHand(); }, 120); });

function tickTimer() {
  const bar = $('timerBar').firstElementChild;
  if (!G || G.status !== 'playing' || !deadlineAt) { bar.style.transform = 'scaleX(0)'; $('clock').textContent = ''; return; }
  const left = deadlineAt - Date.now();
  $('clock').textContent = Math.max(0, Math.ceil(left / 1000));
  $('clock').classList.toggle('late', left < 6000);
  const full = (G.turn_secs || 30) * 1000;
  bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / full))})`;
  $('timerBar').classList.toggle('late', left < Math.min(10000, full / 3));
  if (left < -1500 && tickedFor !== deadlineAt) {
    tickedFor = deadlineAt;
    rpc('rummy_tick', { p_game: gameId }).then(refresh, () => {});
  }
}

// ----- my rack: two rows of free slots, the player arranges every tile himself -----
const COLS = 16, ROWS = 2, NSLOT = COLS * ROWS;
let wantSlot = -1;          // slot chosen by dragging the open tile onto the rack
let revealNext = false;     // show a tile drawn from the pool big in the middle first
let slots = new Array(NSLOT).fill(null);   // tile id or null
let dragging = false;
let geom = { tw: 50, th: 66, gap: 4, padX: 10, padY: 8, rowH: 80 };

function rackKey() { return 'rummy_rack_' + gameId; }
function saveRackLocal() { try { localStorage.setItem(rackKey(), JSON.stringify(slots)); } catch (e) { /* ignore */ } }
function loadRackLocal() {
  try { const a = JSON.parse(localStorage.getItem(rackKey()) || 'null'); if (Array.isArray(a) && a.length === NSLOT) return a; } catch (e) { /* ignore */ }
  return null;
}
// keep the slots in step with the tiles the server says I hold
function syncSlots(server, fromStart) {
  if (fromStart) { const saved = loadRackLocal(); slots = saved || new Array(NSLOT).fill(null); }
  const have = new Set(server);
  for (let i = 0; i < NSLOT; i++) if (slots[i] != null && !have.has(slots[i])) slots[i] = null;
  // a tile may appear in two slots only by a bug; keep the first
  const seen = new Set();
  for (let i = 0; i < NSLOT; i++) { if (slots[i] != null) { if (seen.has(slots[i])) slots[i] = null; else seen.add(slots[i]); } }
  const missing = server.filter((c) => !seen.has(c));
  if (seen.size === 0 && missing.length) {          // first time: top row, in the server order
    missing.forEach((c, i) => { slots[i < COLS ? i : i] = c; });
  } else {
    for (const c of missing) {                      // a new tile: first free slot in the bottom row, else anywhere
      let i = (wantSlot >= 0 && slots[wantSlot] == null) ? wantSlot : slots.findIndex((x, k) => x == null && k >= COLS);
      wantSlot = -1;
      if (i < 0) i = slots.findIndex((x) => x == null);
      slots[i] = c;
    }
  }
  hand = slots.filter((x) => x != null);
  saveRackLocal();
}

// a group = tiles next to each other in one row with no empty slot between them
function groupsOnRack() {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    let cur = [];
    for (let c = 0; c <= COLS; c++) {
      const t = c < COLS ? slots[r * COLS + c] : null;
      if (t != null) cur.push({ t, i: r * COLS + c });
      else if (cur.length) { out.push(cur); cur = []; }
    }
  }
  return out;
}
// is one group a legal set or run (same rules as the server)
function validGroup(ts) {
  if (ts.length < 3) return false;
  const real = ts.filter((t) => !Cards.isJoker(t));
  if (real.length < 2) return false;
  const nums = real.map(Cards.rankOf), cols = real.map(Cards.suitOf);
  if (ts.length <= 4 && nums.every((n) => n === nums[0]) && new Set(cols).size === cols.length) return true;   // set
  if (!cols.every((c) => c === cols[0])) return false;                                                          // run
  // run in the order the player placed them (left to right)
  let start = null;
  for (let k = 0; k < ts.length; k++) if (!Cards.isJoker(ts[k])) { start = Cards.rankOf(ts[k]) - k; break; }
  if (start < 1 || start + ts.length - 1 > 13) return false;
  return ts.every((t, k) => Cards.isJoker(t) || Cards.rankOf(t) === start + k);
}

function layoutRack() {
  // the real room inside the rack area (phones in landscape keep space for the notch on both sides)
  const hw = $('handWrap'), cs = getComputedStyle(hw);
  const inner = hw.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  const W = Math.min((inner > 100 ? inner : innerWidth - 16), 1200);
  const gap = Math.max(3, Math.round(W / 250));
  let tw = Math.floor((W - 20 - gap * (COLS - 1)) / COLS);
  const maxTh = Math.floor((innerHeight * (innerHeight < 500 ? 0.47 : 0.42) - 34) / ROWS) - 14;   // rack ≈ 45% of the screen height
  tw = Math.min(tw, Math.floor(maxTh / 1.333), 92);
  const th = Math.round(tw * 1.333), rowH = th + 14;
  geom = { tw, th, gap, padX: Math.round((W - (tw * COLS + gap * (COLS - 1))) / 2), padY: 8, rowH, W };
  const root = document.documentElement.style;
  root.setProperty('--tw', tw + 'px'); root.setProperty('--rackW', W + 'px'); root.setProperty('--rowH', rowH + 'px');
  root.setProperty('--rackH', (rowH * ROWS + 12) + 'px');
}
function slotXY(i) {
  const r = Math.floor(i / COLS), c = i % COLS;
  return { x: geom.padX + c * (geom.tw + geom.gap), y: geom.padY + r * geom.rowH };
}
function slotAt(px, py) {     // px, py relative to the rack
  const c = Math.round((px - geom.padX - geom.tw / 2) / (geom.tw + geom.gap));
  const r = Math.round((py - geom.padY - geom.th / 2) / geom.rowH);
  if (px < 0 || py < -20 || px > geom.W + 10) return -1;
  return Math.max(0, Math.min(ROWS - 1, r)) * COLS + Math.max(0, Math.min(COLS - 1, c));
}

function renderHand() {
  if (dragging) return;
  layoutRack();
  const box = $('hand'); box.innerHTML = '';
  if (!G || G.me == null) return;
  // the two shelves
  for (let r = 0; r < ROWS; r++) {
    const sh = document.createElement('div'); sh.className = 'shelf'; sh.style.top = (geom.padY + r * geom.rowH + geom.th - 2) + 'px';
    box.appendChild(sh);
  }
  // green line under groups that are already a legal set or run
  for (const g of groupsOnRack()) {
    if (!validGroup(g.map((x) => x.t))) continue;
    const a = slotXY(g[0].i), b = slotXY(g[g.length - 1].i);
    const ok = document.createElement('div'); ok.className = 'okline';
    Object.assign(ok.style, { left: a.x + 'px', top: (a.y + geom.th + 2) + 'px', width: (b.x - a.x + geom.tw) + 'px' });
    box.appendChild(ok);
  }
  slots.forEach((c, i) => {
    if (c == null) return;
    const p = slotXY(i);
    const el = document.createElement('div');
    el.className = 'card' + (c === selected ? ' sel' : '') + (newCards.has(c) ? ' new' : '');
    el.style.backgroundImage = `url(${Cards.faceURL(c)})`;
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.dataset.c = c;
    attachCard(el, c, i);
    box.appendChild(el);
  });
  const db_ = $('discardBtn');
  if (selected != null && G.turn === G.me && G.phase === 'discard') {
    const i = slots.indexOf(selected), p = slotXY(i), r = box.getBoundingClientRect();
    db_.classList.remove('hidden');
    db_.style.left = (r.left + p.x + geom.tw / 2) + 'px';
    db_.style.top = (r.top + p.y - 46) + 'px';
  } else db_.classList.add('hidden');
}

let orderTimer;
function saveOrder() {
  hand = slots.filter((x) => x != null);
  saveRackLocal();
  clearTimeout(orderTimer);
  orderTimer = setTimeout(() => { rpc('rummy_hand_order', { p_game: gameId, p_cards: hand }).catch(() => {}); }, 600);
}

// dropping a tile anywhere on the table (above the rack) throws it
function overPile(x, y) {
  const top = $('handTools').getBoundingClientRect().top;
  return y < top - 4;
}

function attachCard(el, c, from) {
  let sx = 0, sy = 0, moved = false, ox = 0, oy = 0, pid = null;
  el.addEventListener('pointerdown', (ev) => {
    pid = ev.pointerId; sx = ev.clientX; sy = ev.clientY; moved = false;
    ox = parseFloat(el.style.left); oy = parseFloat(el.style.top);
    el.setPointerCapture(pid);
  });
  el.addEventListener('pointermove', (ev) => {
    if (pid !== ev.pointerId) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 8) { moved = true; dragging = true; el.classList.add('drag'); newCards.delete(c); }
    if (moved) {
      el.style.left = ox + dx + 'px'; el.style.top = oy + dy + 'px';
      const canThrow = G && G.turn === G.me && G.phase === 'discard';
      $('pileBtn').classList.toggle('drop', canThrow && overPile(ev.clientX, ev.clientY));
    }
  });
  const end = (ev) => {
    if (pid !== ev.pointerId) return; pid = null;
    if (!moved) { onCardTap(c); return; }
    dragging = false; el.classList.remove('drag'); $('pileBtn').classList.remove('drop');
    // dropped on the open pile = throw it (only on my turn after drawing)
    if (G && G.turn === G.me && G.phase === 'discard' && overPile(ev.clientX, ev.clientY)) { discard(c); return; }
    const to = slotAt(parseFloat(el.style.left) + geom.tw / 2, parseFloat(el.style.top) + geom.th / 2);
    if (to >= 0 && to !== from) {
      const other = slots[to];
      slots[to] = c; slots[from] = other;          // empty slot: move; full slot: swap
      SFX.play('click'); saveOrder();
    }
    renderHand();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', (ev) => { if (pid === ev.pointerId) { pid = null; dragging = false; el.classList.remove('drag'); renderHand(); } });
}

function onCardTap(c) {
  SFX.unlock();
  newCards.delete(c);
  if (!G || G.status !== 'playing') { renderHand(); return; }
  if (G.turn !== G.me || G.phase === 'draw') {
    // outside the throwing moment a tap just picks the tile up for moving — show how
    toast(G.turn !== G.me ? 'גרור אבנים כדי לסדר את הכן — בינתיים זה לא התור שלך' : 'קודם שולפים אבן מהקופה או את האבן הפתוחה');
    renderHand(); return;
  }
  if (selected === c) { discard(c); return; }
  selected = c; SFX.play('click'); renderHand();
}

async function act(fn, args) {
  if (acting) return; acting = true;
  try { const st = await rpc(fn, { p_game: gameId, ...args }); queueState(st); }
  catch (e) { toast(errText(e)); refresh(); }
  finally { acting = false; }
}
// the tile I just drew from the pool: big in the middle for a second, then it flies to its slot
function reveal(c) {
  const el = document.querySelector(`#hand .card[data-c="${c}"]`); if (!el) return;
  el.style.visibility = 'hidden';
  const big = document.createElement('div'); big.className = 'reveal';
  big.style.backgroundImage = `url(${Cards.faceURL(c)})`;
  document.body.appendChild(big);
  requestAnimationFrame(() => big.classList.add('in'));
  setTimeout(() => {
    const r = el.getBoundingClientRect();
    const b = big.getBoundingClientRect();
    big.style.transition = 'transform .45s cubic-bezier(.3,.8,.3,1)';
    big.style.transform = `translate(${r.left + r.width / 2 - (b.left + b.width / 2)}px, ${r.top + r.height / 2 - (b.top + b.height / 2)}px) scale(${r.width / b.width})`;
    setTimeout(() => { big.remove(); el.style.visibility = ''; SFX.play('place'); }, 470);
  }, 1000);
}

function draw(src) {
  SFX.unlock();
  if (processing) { toast('רגע — עוד רואים את התור הקודם'); return; }
  if (!G || G.turn !== G.me || G.phase !== 'draw' || G.status !== 'playing') {
    if (G && G.status === 'playing') toast(G.turn !== G.me ? `עכשיו התור של ${G.names[G.turn]}` : 'כבר שלפת — עכשיו זורקים אבן');
    return;
  }
  if (src === 'pile' && G.pile_top == null) return;
  revealNext = src === 'deck';
  act('rummy_draw', { p_src: src, p_seq: G.seq });
}
function discard(c) {
  if (!G || G.turn !== G.me || G.phase !== 'discard') return;
  selected = null; const i = slots.indexOf(c); if (i >= 0) slots[i] = null; saveRackLocal();
  hand = slots.filter((x) => x != null); renderHand();
  act('rummy_discard', { p_card: c, p_seq: G.seq });
}
// closing is the player's own call: he picks the tile to throw and says "close"; the server checks the other 14
function closeHand() {
  if (!G || G.turn !== G.me || G.phase !== 'discard') return;
  if (selected == null) { toast('בחר את האבן שאתה זורק, ואז לחץ סגירה'); return; }
  const c = selected;
  act('rummy_close', { p_card: c, p_seq: G.seq });
}
$('deckBtn').onclick = () => draw('deck');
let pileDragged = false;
$('pileBtn').onclick = () => { if (pileDragged) { pileDragged = false; return; } draw('pile'); };
$('poolBtn').onclick = () => draw('deck');
(function pileDrag() {
  const pb = $('pileBtn'); let pid = null, sx = 0, sy = 0, ghost = null;
  pb.addEventListener('pointerdown', (ev) => {
    if (!G || G.turn !== G.me || G.phase !== 'draw' || G.pile_top == null) return;
    pid = ev.pointerId; sx = ev.clientX; sy = ev.clientY; pileDragged = false; pb.setPointerCapture(pid);
  });
  pb.addEventListener('pointermove', (ev) => {
    if (pid !== ev.pointerId) return;
    if (!ghost && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 8) {
      pileDragged = true;
      ghost = document.createElement('div'); ghost.className = 'card drag drag-ghost';
      ghost.style.backgroundImage = `url(${Cards.faceURL(G.pile_top)})`; document.body.appendChild(ghost);
      layoutRack();
    }
    if (ghost) { ghost.style.left = (ev.clientX - geom.tw / 2) + 'px'; ghost.style.top = (ev.clientY - geom.th / 2) + 'px'; }
  });
  const end = (ev) => {
    if (pid !== ev.pointerId) return; pid = null;
    if (!ghost) return;
    ghost.remove(); ghost = null;
    const hr = $('hand').getBoundingClientRect();
    if (ev.clientY > hr.top - 10) {
      const slot = slotAt(ev.clientX - hr.left, ev.clientY - hr.top);
      wantSlot = slot >= 0 && slots[slot] == null ? slot : -1;
      draw('pile');
    }
    setTimeout(() => { pileDragged = false; }, 50);
  };
  pb.addEventListener('pointerup', end);
  pb.addEventListener('pointercancel', (ev) => { if (pid === ev.pointerId) { pid = null; if (ghost) { ghost.remove(); ghost = null; } } });
})();
$('discardBtn').onclick = () => { if (selected != null) discard(selected); };
$('closeBtn').onclick = closeHand;
function arrange(sorted, key) {
  // groups of the same colour / number stay together on one shelf, with an empty slot between groups
  const groups = [];
  for (const c of sorted) {
    const k = key(c), last = groups[groups.length - 1];
    if (last && last.k === k) last.t.push(c); else groups.push({ k, t: [c] });
  }
  const out = new Array(NSLOT).fill(null);
  let row = 0, col = 0;
  for (const g of groups) {
    let need = g.t.length;
    if (col > 0 && col + need > COLS && need <= COLS && row + 1 < ROWS) { row++; col = 0; }
    for (const c of g.t) {
      if (col >= COLS) { row = Math.min(ROWS - 1, row + 1); col = 0; }
      while (out[row * COLS + col] != null) { col++; if (col >= COLS) { row = (row + 1) % ROWS; col = 0; } }
      out[row * COLS + col] = c; col++;
    }
    col++;                                     // gap after the group
    if (col >= COLS && row + 1 < ROWS) { row++; col = 0; }
  }
  // anything that did not fit (very rare) goes to any free slot
  const placed = new Set(out.filter((x) => x != null));
  for (const c of sorted) if (!placed.has(c)) out[out.indexOf(null)] = c;
  slots = out; selected = null; saveOrder(); renderHand();
}
$('sortSuit').onclick = () => arrange(Cards.sortBySuit(hand), (c) => Cards.suitOf(c));
$('sortRank').onclick = () => arrange(Cards.sortByRank(hand), (c) => Cards.rankOf(c));
$('resumeBtn').onclick = () => act('rummy_resume', {});

// menu
$('menuBtn').onclick = () => { $('menu').classList.remove('hidden'); $('soundBtn').textContent = 'צלילים: ' + (SFX.isOn() ? 'פועל' : 'כבוי'); };
$('menuClose').onclick = () => $('menu').classList.add('hidden');
$('soundBtn').onclick = () => { $('soundBtn').textContent = 'צלילים: ' + (SFX.toggle() ? 'פועל' : 'כבוי'); };
let quitArmed = false;
$('quitBtn').onclick = async () => {
  if (!quitArmed) { quitArmed = true; $('quitBtn').textContent = 'לחץ שוב כדי לצאת'; setTimeout(() => { quitArmed = false; $('quitBtn').innerHTML = 'יציאה מהמשחק<small>בוט ימשיך במקומך</small>'; }, 3000); return; }
  quitArmed = false;
  try { await rpc('rummy_room_leave'); } catch (e) { /* ignore */ }
  $('menu').classList.add('hidden'); openLobby();
};

// end of game
let endShownFor = null;
// end of the round: everybody's rack for 5 seconds, names beside them, the winner's rack highlighted
function showRacks(st) {
  return new Promise((done) => {
    const hands = st.all_hands; if (!hands || !hands.length) { done(); return; }
    const list = $('racksList'); list.innerHTML = '';
    const order = [...Array(st.n).keys()].sort((a, b) => (b === st.winner) - (a === st.winner));
    for (const s of order) {
      const row = document.createElement('div'); row.className = 'rack-row' + (s === st.winner ? ' win' : '');
      const who = document.createElement('div'); who.className = 'who';
      who.appendChild(avatar(st.names[s], st.bots[s]));
      const nm = document.createElement('span'); nm.textContent = st.names[s] + (s === st.me ? ' (אתה)' : ''); who.appendChild(nm);
      if (s === st.winner) { const c = document.createElement('img'); c.src = 'assets/img/crown.webp'; c.className = 'crown'; who.appendChild(c); }
      row.appendChild(who);
      const tiles = document.createElement('div'); tiles.className = 'mini-rack';
      // winner: his groups with a gap between them; me: my own arrangement; others: as they hold them
      let groups;
      if (s === st.winner && st.winner_melds) groups = st.winner_melds;
      else if (s === st.me && slots.some((x) => x != null)) groups = groupsOnRack().map((g) => g.map((x) => x.t));
      else groups = [hands[s]];
      for (const g of groups) {
        const gEl = document.createElement('div'); gEl.className = 'mini-group';
        for (const c of g) { const im = document.createElement('img'); im.src = Cards.faceURL(c); gEl.appendChild(im); }
        tiles.appendChild(gEl);
      }
      row.appendChild(tiles); list.appendChild(row);
    }
    $('racksTitle').textContent = st.winner == null ? 'תיקו — הכנים של כולם' : `${st.names[st.winner]} סגר! — הכנים של כולם`;
    const bar = document.querySelector('.racks-bar i');
    bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)';
    $('racks').classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = 'transform 5s linear'; bar.style.transform = 'scaleX(0)'; }));
    const finish = () => { $('racks').classList.add('hidden'); done(); };
    const t = setTimeout(finish, 5000);
    $('racks').onclick = () => { clearTimeout(t); finish(); };          // a tap skips ahead
  });
}

async function showEnd(st) {
  if (endShownFor === st.id) return; endShownFor = st.id;
  if (st.winner != null) SFX.play('win');
  await showRacks(st);
  $('turnBanner').textContent = 'המשחק נגמר';
  const win = st.winner != null;
  $('endCrown').classList.toggle('hidden', !win);
  $('endTitle').textContent = !win ? (st.ended_reason === 'draw' ? 'תיקו — הקופה נגמרה 3 פעמים' : 'המשחק הסתיים')
    : st.winner === st.me ? 'ניצחת!' : `${st.names[st.winner]} ניצח/ה!`;
  const box = $('endMelds'); box.innerHTML = '';
  for (const meld of st.winner_melds || []) {
    const g = document.createElement('div'); g.className = 'meld';
    for (const c of meld) { const im = document.createElement('img'); im.src = Cards.faceURL(c); g.appendChild(im); }
    box.appendChild(g);
  }
  $('end').classList.remove('hidden');
  $('againBtn').classList.add('hidden'); $('againWait').classList.add('hidden');
  const check = async () => {
    try {
      const r = await rpc('rummy_room_get', { p_room: st.room_id });
      if (!r.in_room) { $('againBtn').classList.add('hidden'); $('againWait').textContent = 'יצאת מהשולחן'; $('againWait').classList.remove('hidden'); return; }
      if (r.status === 'playing' && r.game_id && r.game_id !== st.id) { clearInterval(endRoomPoll); endRoomPoll = null; openGame(r.game_id); return; }
      $('againBtn').classList.toggle('hidden', !r.is_host);
      $('againWait').classList.toggle('hidden', r.is_host);
    } catch (e) { /* keep trying */ }
  };
  await check();
  if (endRoomPoll) clearInterval(endRoomPoll);
  endRoomPoll = setInterval(check, 3000);
}
$('againBtn').onclick = async () => {
  const b = $('againBtn'); b.disabled = true;
  try { const gid = await rpc('rummy_game_start', { p_room: G.room_id }); openGame(gid); }
  catch (e) { toast(errText(e)); } finally { b.disabled = false; }
};
$('toLobbyBtn').onclick = async () => {
  if (endRoomPoll) { clearInterval(endRoomPoll); endRoomPoll = null; }
  try { await rpc('rummy_room_leave'); } catch (e) { /* ignore */ }
  $('end').classList.add('hidden'); openLobby();
};

// small read-only view for tests and bug reports
window.__rummyDebug = () => ({ pileTop: G && G.pile_top, seq: G && G.seq, turn: G && G.turn, me: G && G.me, phase: G && G.phase, acting, processing, lastSeq, hand: hand.length });

// ---------- start ----------
(async function boot() {
  window.__rummyReady = true;
  try {
    const { data } = await db.auth.getSession();
    if (data.session) { await afterLogin(); return; }
  } catch (e) {
    if (e && e.code === 'not_logged_in') { await db.auth.signOut(); }
    else if (e && e.code === 'network') { $('bootMsg').textContent = MSG.network; $('bootReload').classList.remove('hidden'); return; }
  }
  try { $('nick').value = localStorage.getItem('rummy_nick') || ''; } catch (e) { /* ignore */ }
  show('login');
})();
