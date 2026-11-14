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
function wheelPick(i, smooth) {
  i = Math.max(0, Math.min(wheelOpts.length - 1, i));
  turnSecs = Number(wheelOpts[i].dataset.v);
  wheelOpts.forEach((o, k) => o.classList.toggle('on', k === i));
  wheel.scrollTo({ top: i * 36, behavior: smooth ? 'smooth' : 'auto' });
}
let wheelT;
wheel.addEventListener('scroll', () => {
  const i = Math.round(wheel.scrollTop / 36);
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
  turnSecs = Number(wheelOpts[Math.max(0, Math.min(5, Math.round(wheel.scrollTop / 36)))].dataset.v) || turnSecs;
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
        const mod = await import('./table3d.js?v=1');
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
  gameId = gid; G = null; lastSeq = -1; hand = []; newCards.clear(); selected = null; pileStack = []; tickedFor = 0;
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
  const fast = entries.length > 14 || document.hidden;
  for (const e of entries) {
    if (!fast) await animateEntry(e, st);
    lastSeq = Math.max(lastSeq, e.n);
  }
  lastSeq = Math.max(lastSeq, st.seq);
  render(st, prev);
}

async function animateEntry(e, st) {
  const r = e.seat != null ? rel(e.seat) : 0;
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
    if (e.a === 'discard') await sleep(r === 0 ? 50 : 300);
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
  else if (myTurn) b.textContent = st.phase === 'draw' ? 'התור שלך — שלוף אבן מהקופה או קח את האבן הפתוחה' : (st.close_card != null ? 'יש לך יד מנצחת! לחץ סגירה' : 'בחר אבן לזרוק (לחיצה כפולה זורקת)');
  else b.textContent = `התור של ${st.names[st.turn]}`;
  b.classList.toggle('mine', myTurn);
  // timer
  deadlineAt = st.deadline_ms != null ? Date.now() + st.deadline_ms : 0;
  // hand: keep my local order when the cards are the same
  const server = st.hand || [];
  const same = server.length === hand.length && [...server].sort().join() === [...hand].sort().join();
  if (!same) {
    const known = new Set(hand);
    const added = server.filter((c) => !known.has(c));
    const kept = hand.filter((c) => server.includes(c));
    hand = kept.length ? kept.concat(added) : server.slice();
    newCards = new Set(prev ? added : []);
    if (selected != null && !server.includes(selected)) selected = null;
  }
  if (!(myTurn && st.phase === 'discard')) selected = null;
  renderHand();
  // piles clickable
  const canDraw = myTurn && st.phase === 'draw' && !st.away;
  $('deckBtn').classList.toggle('can', canDraw);
  $('pileBtn').classList.toggle('can', canDraw && st.pile_top != null);
  $('closeBtn').classList.toggle('hidden', !(myTurn && st.phase === 'discard' && st.close_card != null));
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
    const el = document.createElement('div'); el.className = 'tag' + (G.turn === s && G.status === 'playing' ? ' turn' : '');
    el.appendChild(avatar(G.names[s], G.bots[s] || G.autos[s]));
    const nm = document.createElement('span'); nm.textContent = G.names[s]; el.appendChild(nm);
    const c = document.createElement('span'); c.className = 'cnt'; c.textContent = `${G.counts[s]} אבנים`; el.appendChild(c);
    if (G.online && !G.online[s]) { const o = document.createElement('i'); o.className = 'off'; o.title = 'לא מחובר'; el.appendChild(o); }
    el.style.left = pos.x + 'px'; el.style.top = Math.max(60, pos.y) + 'px';
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

// ----- my hand -----
let dragging = false;
function renderHand() {
  if (dragging) return;
  const box = $('hand'); box.innerHTML = '';
  if (!G || G.me == null) return;
  // tiles sit side by side on the rack (no overlap) — size them to fit the screen
  const maxW = Math.min(innerWidth - 24, 1100), gap = 3, cnt = Math.max(hand.length, 14);
  const cw = Math.max(36, Math.min(innerHeight <= 460 ? 52 : 66, Math.floor((maxW - 16) / cnt) - gap));
  const step = cw + gap;
  const total = step * hand.length - gap;
  document.documentElement.style.setProperty('--tw', cw + 'px');
  box.style.width = Math.max(total, step * 14) + 16 + 'px';
  hand.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'card' + (c === selected ? ' sel' : '') + (newCards.has(c) ? ' new' : '');
    el.style.backgroundImage = `url(${Cards.faceURL(c)})`;
    el.style.left = 8 + i * step + 'px'; el.style.zIndex = i + 1;
    el.dataset.c = c;
    attachCard(el, c, i, step);
    box.appendChild(el);
  });
  const db_ = $('discardBtn');
  if (selected != null && G.turn === G.me && G.phase === 'discard') {
    const i = hand.indexOf(selected);
    const r = box.getBoundingClientRect();
    db_.classList.remove('hidden');
    db_.style.left = (r.left + 8 + i * step + cw / 2) + 'px';
    db_.style.bottom = (innerHeight - r.top + 30) + 'px';
  } else db_.classList.add('hidden');
}

let orderTimer;
function saveOrder() {
  clearTimeout(orderTimer);
  orderTimer = setTimeout(() => { rpc('rummy_hand_order', { p_game: gameId, p_cards: hand }).catch(() => {}); }, 500);
}

function attachCard(el, c, index, step) {
  let sx = 0, sy = 0, moved = false, startLeft = 0, pid = null;
  el.addEventListener('pointerdown', (ev) => {
    pid = ev.pointerId; sx = ev.clientX; sy = ev.clientY; startLeft = parseFloat(el.style.left); moved = false;
    el.setPointerCapture(pid);
  });
  el.addEventListener('pointermove', (ev) => {
    if (pid !== ev.pointerId) return;
    const dx = ev.clientX - sx;
    if (!moved && Math.abs(dx) + Math.abs(ev.clientY - sy) > 10) { moved = true; dragging = true; el.classList.add('drag'); }
    if (moved) el.style.left = startLeft + dx + 'px';
  });
  const end = (ev) => {
    if (pid !== ev.pointerId) return; pid = null;
    if (moved) {
      dragging = false; el.classList.remove('drag');
      const to = Math.max(0, Math.min(hand.length - 1, Math.round((parseFloat(el.style.left) - 8) / (step || 1))));
      if (to !== index) { hand.splice(index, 1); hand.splice(to, 0, c); saveOrder(); }
      renderHand();
    } else onCardTap(c);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', (ev) => { if (pid === ev.pointerId) { pid = null; dragging = false; el.classList.remove('drag'); renderHand(); } });
}

function onCardTap(c) {
  SFX.unlock();
  newCards.delete(c);
  if (!G || G.status !== 'playing') return;
  if (G.turn !== G.me) { toast('חכה לתור שלך — בינתיים אפשר לסדר את האבנים'); return; }
  if (G.phase === 'draw') { toast('קודם שולפים אבן מהקופה או את האבן הפתוחה'); return; }
  if (selected === c) { discard(c); return; }
  selected = c; SFX.play('click'); renderHand();
}

async function act(fn, args) {
  if (acting) return; acting = true;
  try { const st = await rpc(fn, { p_game: gameId, ...args }); queueState(st); }
  catch (e) { toast(errText(e)); refresh(); }
  finally { acting = false; }
}
function draw(src) {
  SFX.unlock();
  if (!G || G.turn !== G.me || G.phase !== 'draw' || G.status !== 'playing') {
    if (G && G.status === 'playing') toast(G.turn !== G.me ? `עכשיו התור של ${G.names[G.turn]}` : 'כבר שלפת — עכשיו זורקים אבן');
    return;
  }
  if (src === 'pile' && G.pile_top == null) return;
  act('rummy_draw', { p_src: src, p_seq: G.seq });
}
function discard(c) {
  if (!G || G.turn !== G.me || G.phase !== 'discard') return;
  selected = null; hand = hand.filter((x) => x !== c); renderHand();
  act('rummy_discard', { p_card: c, p_seq: G.seq });
}
$('deckBtn').onclick = () => draw('deck');
$('pileBtn').onclick = () => draw('pile');
$('discardBtn').onclick = () => { if (selected != null) discard(selected); };
$('closeBtn').onclick = () => { if (G && G.close_card != null) act('rummy_close', { p_card: G.close_card, p_seq: G.seq }); };
$('sortSuit').onclick = () => { hand = Cards.sortBySuit(hand); renderHand(); saveOrder(); };
$('sortRank').onclick = () => { hand = Cards.sortByRank(hand); renderHand(); saveOrder(); };
$('resumeBtn').onclick = () => act('rummy_resume', {});

// menu
$('menuBtn').onclick = () => { $('menu').classList.remove('hidden'); $('soundBtn').textContent = 'צלילים: ' + (SFX.isOn() ? 'פועל' : 'כבוי'); };
$('menuClose').onclick = () => $('menu').classList.add('hidden');
$('soundBtn').onclick = () => { $('soundBtn').textContent = 'צלילים: ' + (SFX.toggle() ? 'פועל' : 'כבוי'); };
let quitArmed = false;
$('quitBtn').onclick = async () => {
  if (!quitArmed) { quitArmed = true; $('quitBtn').textContent = 'לחץ שוב כדי לצאת'; setTimeout(() => { quitArmed = false; $('quitBtn').textContent = 'יציאה מהמשחק (בוט ימשיך במקומך)'; }, 3000); return; }
  quitArmed = false;
  try { await rpc('rummy_room_leave'); } catch (e) { /* ignore */ }
  $('menu').classList.add('hidden'); openLobby();
};

// end of game
let endShownFor = null;
async function showEnd(st) {
  if (endShownFor === st.id) return; endShownFor = st.id;
  $('turnBanner').textContent = 'המשחק נגמר';
  const win = st.winner != null;
  if (win) SFX.play('win');
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
window.__rummyDebug = () => ({ seq: G && G.seq, turn: G && G.turn, me: G && G.me, phase: G && G.phase, acting, processing, lastSeq, hand: hand.length });

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
