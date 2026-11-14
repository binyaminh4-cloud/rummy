-- =====================================================================
-- Rummy (without lay-downs) — core server: tables, lobby, rooms, game,
-- hand check, bots.
-- Safe to run more than once.
--
-- UNDO (removes the whole game from the server) — run supabase/undo/0001_undo.sql
-- =====================================================================

-- ---------- tables ----------
create table if not exists rummy_profiles (
  id uuid primary key,
  nickname text not null unique,
  wins int not null default 0,
  games int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists rummy_rooms (
  id bigserial primary key,
  name text not null,
  host uuid,
  status text not null default 'waiting',      -- waiting | playing | closed
  max_seats int not null default 4,
  game_id bigint,
  next_starter int not null default -1,
  version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists rummy_room_seats (
  room_id bigint not null references rummy_rooms(id) on delete cascade,
  seat int not null,
  user_id uuid,                -- null = bot
  bot_name text,
  joined_at timestamptz not null default now(),
  primary key (room_id, seat)
);
create unique index if not exists rummy_room_seats_user on rummy_room_seats(user_id) where user_id is not null;

create table if not exists rummy_games (
  id bigserial primary key,
  room_id bigint not null references rummy_rooms(id) on delete cascade,
  status text not null default 'playing',      -- playing | over
  n int not null,
  turn int not null default 0,
  phase text not null default 'draw',          -- draw | discard
  seq int not null default 0,
  pile int[] not null default '{}',            -- discard pile, last = top (public)
  deck_count int not null default 0,
  counts int[] not null default '{}',          -- cards per seat (public)
  names text[] not null default '{}',
  bots boolean[] not null default '{}',
  autos boolean[] not null default '{}',
  reshuffles int not null default 0,
  deadline timestamptz,
  winner int,                                  -- seat, null = draw/none
  winner_melds jsonb,
  ended_reason text,                           -- win | draw | abandoned
  log jsonb not null default '[]',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- private: hands and players (no read policy; only through functions)
create table if not exists rummy_players (
  game_id bigint not null references rummy_games(id) on delete cascade,
  seat int not null,
  user_id uuid,
  name text not null,
  is_bot boolean not null default false,
  auto boolean not null default false,
  left_game boolean not null default false,
  misses int not null default 0,
  last_seen timestamptz not null default now(),
  cards int[] not null default '{}',
  primary key (game_id, seat)
);

create table if not exists rummy_secret (
  game_id bigint primary key references rummy_games(id) on delete cascade,
  deck int[] not null
);

create table if not exists rummy_errors (
  id bigserial primary key,
  user_id uuid,
  msg text,
  detail text,
  ua text,
  url text,
  created_at timestamptz not null default now()
);

alter table rummy_profiles   enable row level security;
alter table rummy_rooms      enable row level security;
alter table rummy_room_seats enable row level security;
alter table rummy_games      enable row level security;
alter table rummy_players    enable row level security;
alter table rummy_secret     enable row level security;
alter table rummy_errors     enable row level security;

drop policy if exists rummy_rooms_read on rummy_rooms;
create policy rummy_rooms_read on rummy_rooms for select to authenticated using (true);
drop policy if exists rummy_games_read on rummy_games;
create policy rummy_games_read on rummy_games for select to authenticated using (true);
drop policy if exists rummy_profiles_read on rummy_profiles;
create policy rummy_profiles_read on rummy_profiles for select to authenticated using (true);

grant select on rummy_rooms, rummy_games, rummy_profiles to authenticated;

-- live updates: rooms (lobby/room screens) and games (table)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='rummy_rooms') then
      execute 'alter publication supabase_realtime add table rummy_rooms';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='rummy_games') then
      execute 'alter publication supabase_realtime add table rummy_games';
    end if;
  end if;
end $$;

-- ---------- cards ----------
-- 0..103 = two decks: suit = (c%52)/13 (0 spades,1 hearts,2 diamonds,3 clubs), rank = c%13+1 (1=A..13=K)
-- 104..107 = jokers
create or replace function rummy_is_joker(c int) returns boolean language sql immutable as $$ select c >= 104 $$;
create or replace function rummy_suit(c int) returns int language sql immutable as $$ select case when c >= 104 then -1 else (c % 52) / 13 end $$;
create or replace function rummy_rank(c int) returns int language sql immutable as $$ select case when c >= 104 then 0 else c % 13 + 1 end $$;

-- remove one occurrence (by array index)
create or replace function rummy__del(a int[], i int) returns int[] language sql immutable as
$$ select coalesce(a[1:i-1], '{}') || coalesce(a[i+1:], '{}') $$;

-- remove one occurrence of a value
create or replace function rummy__remove(a int[], v int) returns int[] language plpgsql immutable as $$
declare i int := array_position(a, v);
begin
  if i is null then return null; end if;
  return rummy__del(a, i);
end $$;

-- ---------- hand check ----------
-- r: real cards sorted by (suit, rank); j: jokers available.
-- Returns melds as jsonb (jokers as -1) or null when impossible.
-- Rules: set = 3-4 cards same rank, different suits; run = 3+ same suit consecutive,
-- ace low (A23) or high (QKA), no wrap; jokers replace anything; every meld needs >= 2 real cards.
create or replace function rummy__walk(rem int[], j int, s int, v int, c int, p int, meld int[], nreal int)
returns jsonb language plpgsql immutable as $$
declare
  res jsonb; idx int; rk int; maxhi int;
begin
  maxhi := case when v = 1 then 13 else 14 end;
  -- close the run here (c already placed, length >= 3, >= 2 real cards)
  if p > v and cardinality(meld) >= 3 and nreal >= 2 then
    res := rummy__solve(rem, j);
    if res is not null then return jsonb_build_array(to_jsonb(meld)) || res; end if;
  end if;
  if p > maxhi then return null; end if;
  if p = v then
    return rummy__walk(rem, j, s, v, c, p + 1, meld || c, nreal + 1);
  end if;
  rk := case when p = 14 then 1 else p end;
  idx := null;
  for i in 1 .. coalesce(cardinality(rem), 0) loop
    if rem[i] < 104 and (rem[i] % 52) / 13 = s and rem[i] % 13 + 1 = rk then idx := i; exit; end if;
  end loop;
  if idx is not null then
    res := rummy__walk(rummy__del(rem, idx), j, s, v, c, p + 1, meld || rem[idx], nreal + 1);
    if res is not null then return res; end if;
  end if;
  if j > 0 then
    return rummy__walk(rem, j - 1, s, v, c, p + 1, meld || -1, nreal);
  end if;
  return null;
end $$;

create or replace function rummy__solve(r int[], j int) returns jsonb language plpgsql immutable as $$
declare
  c int; s int; k int; rest int[]; res jsonb;
  opt int[] := '{}'; m int; chosen int[]; rem int[]; nreal int; jn int; sz int;
  v int; lo int; minlo int; need int; rk int;
begin
  if r is null or cardinality(r) = 0 then
    return case when j = 0 then '[]'::jsonb else null end;
  end if;
  c := r[1]; s := (c % 52) / 13; k := c % 13 + 1;
  rest := r[2:];

  -- sets with c
  for t in 0..3 loop
    if t <> s then
      for i in 1 .. coalesce(cardinality(rest), 0) loop
        if (rest[i] % 52) / 13 = t and rest[i] % 13 + 1 = k then opt := opt || rest[i]; exit; end if;
      end loop;
    end if;
  end loop;
  for m in 0 .. (1 << cardinality(opt)) - 1 loop
    chosen := '{}'; rem := rest;
    for i in 1 .. cardinality(opt) loop
      if (m >> (i - 1)) & 1 = 1 then chosen := chosen || opt[i]; rem := rummy__remove(rem, opt[i]); end if;
    end loop;
    nreal := 1 + cardinality(chosen);
    if nreal >= 2 then
      for sz in greatest(3, nreal) .. 4 loop
        jn := sz - nreal;
        if jn <= j then
          res := rummy__solve(rem, j - jn);
          if res is not null then
            return jsonb_build_array(to_jsonb(array[c] || chosen || array_fill(-1, array[jn]))) || res;
          end if;
        end if;
      end loop;
    end if;
  end loop;

  -- runs with c (c at value v; ace can be 1 or 14)
  foreach v in array (case when k = 1 then array[1, 14] else array[k] end) loop
    minlo := case when v = 14 then 2 else 1 end;
    lo := v; need := 0;
    while lo >= minlo loop
      if lo < v then
        rk := case when lo = 14 then 1 else lo end;
        if not exists (select 1 from unnest(rest) x where x < 104 and (x % 52) / 13 = s and x % 13 + 1 = rk) then
          need := need + 1;
        end if;
        exit when need > j;
      end if;
      res := rummy__walk(rest, j, s, v, c, lo, '{}', 0);
      if res is not null then return res; end if;
      lo := lo - 1;
    end loop;
  end loop;
  return null;
end $$;

-- all cards (any order, may include jokers) -> melds or null
create or replace function rummy_melds(cards int[]) returns jsonb language plpgsql immutable as $$
declare r int[]; j int; res jsonb; jk int[]; out jsonb := '[]'; meld jsonb; m int[]; ji int := 1; xv int;
begin
  select coalesce(array_agg(x order by x % 52), '{}') into r from unnest(cards) x where x < 104;
  select coalesce(array_agg(x), '{}') into jk from unnest(cards) x where x >= 104;
  j := cardinality(jk);
  res := rummy__solve(r, j);
  if res is null then return null; end if;
  -- put the real joker ids back in place of -1
  for meld in select * from jsonb_array_elements(res) loop
    m := '{}';
    for xv in select (e)::int from jsonb_array_elements_text(meld) e loop
      if xv = -1 then m := m || jk[ji]; ji := ji + 1; else m := m || xv; end if;
    end loop;
    out := out || jsonb_build_array(to_jsonb(m));
  end loop;
  return out;
end $$;

-- a full winning hand = exactly 14 cards that all fit in melds
create or replace function rummy_is_win(cards int[]) returns boolean language sql immutable as
$$ select cardinality(cards) = 14 and rummy_melds(cards) is not null $$;

-- with 15 cards: which card can be thrown to close (null = none). Prefers keeping jokers.
create or replace function rummy_close_card(cards int[]) returns int language plpgsql immutable as $$
declare c int; tried int[] := '{}';
begin
  if cardinality(cards) <> 15 then return null; end if;
  for c in select x from unnest(cards) x order by (x >= 104), x loop
    if c = any(tried) then continue; end if;
    tried := tried || c;
    if rummy_is_win(rummy__remove(cards, c)) then return c; end if;
  end loop;
  return null;
end $$;

-- ---------- bot brain ----------
-- value of one card inside a hand: how well it connects to the others
create or replace function rummy__card_value(hand int[], c int) returns int language plpgsql immutable as $$
declare s int; k int; best int := 0; x int; xs int; xk int; d int; same_rank_suits int[] := '{}';
begin
  if c >= 104 then return 100; end if;
  s := (c % 52) / 13; k := c % 13 + 1;
  foreach x in array hand loop
    if x >= 104 then continue; end if;
    xs := (x % 52) / 13; xk := x % 13 + 1;
    if xs = s then
      d := abs(xk - k);
      if k = 1 then d := least(d, abs(xk - 14)); end if;
      if xk = 1 then d := least(d, abs(14 - k)); end if;
      if d = 1 then best := best + 3;
      elsif d = 2 then best := best + 1; end if;
    elsif xk = k and not xs = any(same_rank_suits) then
      same_rank_suits := same_rank_suits || xs;
      best := best + 3;
    end if;
  end loop;
  return best;
end $$;

create or replace function rummy__hand_value(hand int[]) returns int language sql immutable as
$$ select coalesce(sum(least(rummy__card_value(hand, x), 6)), 0)::int from unnest(hand) x $$;

-- which card a bot throws from 15 cards
create or replace function rummy__bot_discard(hand int[]) returns int language plpgsql volatile as $$
declare c int; best int; bestv int := 1000000; v int;
begin
  for c in select x from unnest(hand) x order by random() loop
    if c >= 104 then continue; end if;
    v := rummy__card_value(rummy__remove(hand, c), c);
    if v < bestv then bestv := v; best := c; end if;
  end loop;
  if best is null then best := hand[1]; end if;
  return best;
end $$;

-- ---------- helpers ----------
create or replace function rummy__me() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_logged_in'; end if;
  return u;
end $$;

create or replace function rummy__touch_room(rid bigint) returns void language sql as
$$ update rummy_rooms set version = version + 1, updated_at = now() where id = rid $$;

create or replace function rummy__log(g rummy_games, e jsonb) returns jsonb language plpgsql immutable as $$
declare l jsonb := g.log || jsonb_build_array(e);
begin
  if jsonb_array_length(l) > 60 then
    l := (select jsonb_agg(x order by i) from jsonb_array_elements(l) with ordinality t(x, i) where i > jsonb_array_length(l) - 60);
  end if;
  return l;
end $$;

-- ---------- profile ----------
create or replace function rummy_profile_ensure(p_nick text) returns rummy_profiles
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); p rummy_profiles; nick text := btrim(p_nick);
begin
  select * into p from rummy_profiles where id = u;
  if found then return p; end if;
  if nick is null or char_length(nick) < 2 or char_length(nick) > 14 then raise exception 'bad_nick'; end if;
  if exists (select 1 from rummy_profiles where lower(nickname) = lower(nick)) then raise exception 'nick_taken'; end if;
  insert into rummy_profiles(id, nickname) values (u, nick) returning * into p;
  return p;
end $$;

-- ---------- errors from browsers ----------
create or replace function rummy_log_error(p_msg text, p_detail text, p_ua text, p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if (select count(*) from rummy_errors where created_at > now() - interval '1 hour'
        and user_id is not distinct from u) >= 50 then return; end if;
  insert into rummy_errors(user_id, msg, detail, ua, url)
  values (u, left(p_msg, 500), left(p_detail, 2000), left(p_ua, 300), left(p_url, 300));
end $$;

-- ---------- lobby ----------
create or replace function rummy_lobby() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); rooms jsonb; mine bigint; me rummy_profiles;
begin
  select * into me from rummy_profiles where id = u;
  select room_id into mine from rummy_room_seats where user_id = u;
  select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]') into rooms from (
    select jsonb_build_object(
      'id', r.id, 'name', r.name, 'status', r.status, 'max', r.max_seats,
      'humans', (select count(*) from rummy_room_seats s where s.room_id = r.id and s.user_id is not null),
      'bots', (select count(*) from rummy_room_seats s where s.room_id = r.id and s.user_id is null),
      'host', (select nickname from rummy_profiles where id = r.host)
    ) x
    from rummy_rooms r
    where r.status <> 'closed' and r.updated_at > now() - interval '3 hours'
    order by r.id desc limit 50
  ) t;
  return jsonb_build_object('rooms', rooms, 'my_room', mine,
    'me', jsonb_build_object('nickname', me.nickname, 'wins', me.wins, 'games', me.games));
end $$;

-- ---------- rooms ----------
create or replace function rummy__leave_all(u uuid) returns void language plpgsql as $$
declare rid bigint; g rummy_games; nh int; newhost uuid;
begin
  select room_id into rid from rummy_room_seats where user_id = u;
  if rid is null then return; end if;
  delete from rummy_room_seats where user_id = u;
  -- if a game is running, a bot takes the seat
  select * into g from rummy_games where room_id = rid and status = 'playing' order by id desc limit 1;
  if found then
    update rummy_players set auto = true, left_game = true where game_id = g.id and user_id = u;
    update rummy_games set autos = (select array_agg(auto order by seat) from rummy_players where game_id = g.id),
      updated_at = now() where id = g.id;
  end if;
  select count(*) into nh from rummy_room_seats where room_id = rid and user_id is not null;
  if nh = 0 then
    update rummy_rooms set status = 'closed' where id = rid;
    if g.id is not null then
      update rummy_games set status = 'over', ended_reason = 'abandoned', deadline = null, updated_at = now() where id = g.id;
    end if;
  else
    select user_id into newhost from rummy_room_seats where room_id = rid and user_id is not null order by joined_at limit 1;
    update rummy_rooms set host = newhost where id = rid and host = u;
    if g.id is not null then perform rummy__run_bots(g.id); end if;
  end if;
  perform rummy__touch_room(rid);
end $$;

create or replace function rummy_room_create(p_name text, p_max int) returns bigint
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); rid bigint; nm text := left(btrim(coalesce(p_name, '')), 24);
begin
  if not exists (select 1 from rummy_profiles where id = u) then raise exception 'no_profile'; end if;
  if exists (select 1 from rummy_room_seats s join rummy_rooms rr on rr.id = s.room_id
             where s.user_id = u and rr.status = 'playing') then raise exception 'in_game'; end if;
  perform rummy__leave_all(u);
  if nm = '' then nm := 'השולחן של ' || (select nickname from rummy_profiles where id = u); end if;
  insert into rummy_rooms(name, host, max_seats) values (nm, u, least(4, greatest(2, coalesce(p_max, 4))))
  returning id into rid;
  insert into rummy_room_seats(room_id, seat, user_id) values (rid, 0, u);
  return rid;
end $$;

create or replace function rummy_room_join(p_room bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); r rummy_rooms; free int;
begin
  if not exists (select 1 from rummy_profiles where id = u) then raise exception 'no_profile'; end if;
  if exists (select 1 from rummy_room_seats where user_id = u and room_id = p_room) then return p_room; end if;
  if exists (select 1 from rummy_room_seats s join rummy_rooms rr on rr.id = s.room_id
             where s.user_id = u and rr.status = 'playing') then raise exception 'in_game'; end if;
  select * into r from rummy_rooms where id = p_room for update;
  if not found or r.status = 'closed' then raise exception 'room_gone'; end if;
  if r.status = 'playing' then raise exception 'room_playing'; end if;
  select min(g) into free from generate_series(0, r.max_seats - 1) g
   where g not in (select seat from rummy_room_seats where room_id = p_room and user_id is not null)
     and g not in (select seat from rummy_room_seats where room_id = p_room and user_id is null);
  if free is null then
    -- room full of bots? a human replaces the last bot
    select max(seat) into free from rummy_room_seats where room_id = p_room and user_id is null;
    if free is null then raise exception 'room_full'; end if;
    delete from rummy_room_seats where room_id = p_room and seat = free;
  end if;
  perform rummy__leave_all(u);
  insert into rummy_room_seats(room_id, seat, user_id) values (p_room, free, u);
  perform rummy__touch_room(p_room);
  return p_room;
end $$;

create or replace function rummy_room_leave() returns void
language plpgsql security definer set search_path = public as $$
begin perform rummy__leave_all(rummy__me()); end $$;

create or replace function rummy_room_add_bot(p_room bigint) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); r rummy_rooms; free int; nm text;
begin
  select * into r from rummy_rooms where id = p_room for update;
  if not found or r.status <> 'waiting' then raise exception 'room_gone'; end if;
  if r.host <> u then raise exception 'not_host'; end if;
  select min(g) into free from generate_series(0, r.max_seats - 1) g
   where g not in (select seat from rummy_room_seats where room_id = p_room);
  if free is null then raise exception 'room_full'; end if;
  select x into nm from unnest(array['בוט דני','בוט מאיה','בוט יוסי','בוט נועה','בוט אבי','בוט שירה']) x
   where x not in (select coalesce(bot_name, '') from rummy_room_seats where room_id = p_room)
   order by random() limit 1;
  insert into rummy_room_seats(room_id, seat, user_id, bot_name) values (p_room, free, null, nm);
  perform rummy__touch_room(p_room);
end $$;

create or replace function rummy_room_remove_bot(p_room bigint, p_seat int) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); r rummy_rooms;
begin
  select * into r from rummy_rooms where id = p_room for update;
  if not found or r.status <> 'waiting' then raise exception 'room_gone'; end if;
  if r.host <> u then raise exception 'not_host'; end if;
  delete from rummy_room_seats where room_id = p_room and seat = p_seat and user_id is null;
  perform rummy__touch_room(p_room);
end $$;

create or replace function rummy_room_get(p_room bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); r rummy_rooms; seats jsonb;
begin
  select * into r from rummy_rooms where id = p_room;
  if not found then raise exception 'room_gone'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'seat', s.seat, 'bot', s.user_id is null,
      'name', coalesce(p.nickname, s.bot_name), 'me', s.user_id = u,
      'host', s.user_id = r.host) order by s.seat), '[]')
    into seats
    from rummy_room_seats s left join rummy_profiles p on p.id = s.user_id
   where s.room_id = p_room;
  return jsonb_build_object('id', r.id, 'name', r.name, 'status', r.status, 'max', r.max_seats,
    'game_id', r.game_id, 'is_host', r.host = u, 'seats', seats,
    'in_room', exists (select 1 from rummy_room_seats where room_id = p_room and user_id = u));
end $$;

-- ---------- game ----------
create or replace function rummy_game_start(p_room bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  u uuid := rummy__me(); r rummy_rooms; np int; deck int[]; gid bigint; i int; s record;
  starter int; nm text[] := '{}'; bt boolean[] := '{}';
begin
  select * into r from rummy_rooms where id = p_room for update;
  if not found or r.status <> 'waiting' then raise exception 'room_gone'; end if;
  if r.host <> u then raise exception 'not_host'; end if;
  select count(*) into np from rummy_room_seats where room_id = p_room;
  if np < 2 then raise exception 'need_players'; end if;

  select array_agg(x order by random()) into deck from generate_series(0, 107) x;
  starter := case when r.next_starter < 0 then floor(random() * np)::int else r.next_starter % np end;

  insert into rummy_games(room_id, n, turn) values (p_room, np, starter) returning id into gid;
  i := 0;
  for s in select rs.*, p.nickname from rummy_room_seats rs left join rummy_profiles p on p.id = rs.user_id
            where rs.room_id = p_room order by rs.seat loop
    insert into rummy_players(game_id, seat, user_id, name, is_bot, auto, cards)
    values (gid, i, s.user_id, coalesce(s.nickname, s.bot_name), s.user_id is null, s.user_id is null,
            deck[i * 14 + 1 : i * 14 + 14]);
    nm := nm || coalesce(s.nickname, s.bot_name);
    bt := bt || (s.user_id is null);
    i := i + 1;
  end loop;
  insert into rummy_secret(game_id, deck) values (gid, deck[np * 14 + 2 :]);
  update rummy_games set
    pile = array[deck[np * 14 + 1]], deck_count = 108 - np * 14 - 1,
    counts = array_fill(14, array[np]), names = nm, bots = bt, autos = bt,
    deadline = now() + interval '50 seconds',
    log = jsonb_build_array(jsonb_build_object('n', 0, 'a', 'deal', 'turn', starter))
  where id = gid;
  update rummy_rooms set status = 'playing', game_id = gid, next_starter = starter + 1 where id = p_room;
  perform rummy__touch_room(p_room);
  -- if the first player is a bot, let the bots play until a human's turn
  perform rummy__run_bots(gid);
  return gid;
end $$;

-- end the game (win or draw), update stats, room back to waiting
create or replace function rummy__finish(gid bigint, wseat int, melds jsonb, reason text) returns void language plpgsql as $$
declare g rummy_games;
begin
  update rummy_games set status = 'over', winner = wseat, winner_melds = melds, ended_reason = reason,
    deadline = null, updated_at = now() where id = gid returning * into g;
  update rummy_profiles set games = games + 1
   where id in (select user_id from rummy_players where game_id = gid and user_id is not null and not left_game);
  if wseat is not null then
    update rummy_profiles set wins = wins + 1
     where id = (select user_id from rummy_players where game_id = gid and seat = wseat);
  end if;
  update rummy_rooms set status = case when status = 'closed' then 'closed' else 'waiting' end where id = g.room_id;
  perform rummy__touch_room(g.room_id);
end $$;

-- draw one card for the seat on turn. src: deck | pile. Returns the card, or null if the game ended in a draw.
create or replace function rummy__draw(gid bigint, src text) returns int language plpgsql as $$
declare g rummy_games; d int[]; c int; p rummy_players;
begin
  select * into g from rummy_games where id = gid for update;
  if src = 'pile' then
    if cardinality(g.pile) = 0 then raise exception 'pile_empty'; end if;
    c := g.pile[cardinality(g.pile)];
    g.pile := g.pile[1 : cardinality(g.pile) - 1];
  else
    select deck into d from rummy_secret where game_id = gid for update;
    if cardinality(d) = 0 then
      if g.reshuffles >= 3 or cardinality(g.pile) <= 1 then
        perform rummy__finish(gid, null, null, 'draw');
        return null;
      end if;
      select array_agg(x order by random()) into d from unnest(g.pile[1 : cardinality(g.pile) - 1]) x;
      g.pile := array[g.pile[cardinality(g.pile)]];
      g.reshuffles := g.reshuffles + 1;
      g.seq := g.seq + 1;
      g.log := rummy__log(g, jsonb_build_object('n', g.seq, 'a', 'reshuffle'));
    end if;
    c := d[1];
    update rummy_secret set deck = d[2:] where game_id = gid;
    g.deck_count := cardinality(d) - 1;
  end if;
  update rummy_players set cards = cards || c where game_id = gid and seat = g.turn;
  g.counts[g.turn + 1] := g.counts[g.turn + 1] + 1;
  g.seq := g.seq + 1;
  g.log := rummy__log(g, jsonb_build_object('n', g.seq, 'a', 'draw', 'seat', g.turn, 'src', src,
             'c', case when src = 'pile' then c end));
  update rummy_games set pile = g.pile, deck_count = g.deck_count, counts = g.counts, seq = g.seq,
    log = g.log, reshuffles = g.reshuffles, phase = 'discard', updated_at = now() where id = gid;
  return c;
end $$;

-- throw a card and pass the turn (the turn ends automatically)
create or replace function rummy__discard(gid bigint, c int) returns void language plpgsql as $$
declare g rummy_games; h int[]; nxt int; botturns int;
begin
  select * into g from rummy_games where id = gid for update;
  select cards into h from rummy_players where game_id = gid and seat = g.turn;
  h := rummy__remove(h, c);
  if h is null then raise exception 'not_your_card'; end if;
  update rummy_players set cards = h where game_id = gid and seat = g.turn;
  g.counts[g.turn + 1] := g.counts[g.turn + 1] - 1;
  g.seq := g.seq + 1;
  nxt := (g.turn + 1) % g.n;
  g.log := rummy__log(g, jsonb_build_object('n', g.seq, 'a', 'discard', 'seat', g.turn, 'c', c, 'next', nxt));
  update rummy_games set pile = pile || c, counts = g.counts, seq = g.seq, log = g.log,
    turn = nxt, phase = 'draw', deadline = now() + interval '45 seconds', updated_at = now()
  where id = gid;
end $$;

-- close with 15 cards: throw c, the other 14 must all fit
create or replace function rummy__close(gid bigint, c int) returns boolean language plpgsql as $$
declare g rummy_games; h int[]; rest int[]; melds jsonb;
begin
  select * into g from rummy_games where id = gid for update;
  select cards into h from rummy_players where game_id = gid and seat = g.turn;
  rest := rummy__remove(h, c);
  if rest is null or cardinality(h) <> 15 then return false; end if;
  melds := rummy_melds(rest);
  if melds is null or cardinality(rest) <> 14 then return false; end if;
  g.seq := g.seq + 1;
  update rummy_players set cards = rest where game_id = gid and seat = g.turn;
  g.counts[g.turn + 1] := 14;
  update rummy_games set pile = pile || c, counts = g.counts, seq = g.seq,
    log = rummy__log(g, jsonb_build_object('n', g.seq, 'a', 'close', 'seat', g.turn, 'c', c))
  where id = gid;
  perform rummy__finish(gid, g.turn, melds, 'win');
  return true;
end $$;

-- one full turn for a bot (or a player who is away)
create or replace function rummy__bot_turn(gid bigint) returns void language plpgsql as $$
declare g rummy_games; h int[]; top int; c int; cc int;
begin
  select * into g from rummy_games where id = gid;
  if g.status <> 'playing' then return; end if;
  select cards into h from rummy_players where game_id = gid and seat = g.turn;
  if g.phase = 'draw' then
    top := g.pile[cardinality(g.pile)];
    if top is not null and (top >= 104
        or rummy_close_card(h || top) is not null
        or rummy__card_value(h, top) >= 6) then
      perform rummy__draw(gid, 'pile');
    else
      if rummy__draw(gid, 'deck') is null then return; end if;  -- game ended (draw)
    end if;
    select cards into h from rummy_players where game_id = gid and seat = g.turn;
  end if;
  cc := rummy_close_card(h);
  if cc is not null then
    perform rummy__close(gid, cc);
    return;
  end if;
  c := rummy__bot_discard(h);
  perform rummy__discard(gid, c);
end $$;

-- let bots / away players play until it is a present human's turn. Gives the human
-- extra time for the bot moves the screens will animate (about 1.3 s each).
create or replace function rummy__run_bots(gid bigint) returns void language plpgsql as $$
declare g rummy_games; a boolean; k int := 0;
begin
  loop
    select * into g from rummy_games where id = gid;
    exit when g.status <> 'playing';
    select auto into a from rummy_players where game_id = gid and seat = g.turn;
    exit when not a;
    perform rummy__bot_turn(gid);
    k := k + 1;
    exit when k > 400;  -- safety
  end loop;
  if k > 0 then
    update rummy_games set deadline = now() + interval '45 seconds' + make_interval(secs => k * 1.3)
     where id = gid and status = 'playing';
  end if;
end $$;

-- who am I in this game
create or replace function rummy__my_seat(gid bigint, u uuid) returns int language sql stable as
$$ select seat from rummy_players where game_id = gid and user_id = u and not left_game $$;

-- full view of a game for me: public table + my own hand
create or replace function rummy_state(p_game bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); g rummy_games; me int; h int[]; cc int; away boolean;
begin
  select * into g from rummy_games where id = p_game;
  if not found then raise exception 'game_gone'; end if;
  me := rummy__my_seat(p_game, u);
  if me is not null then
    update rummy_players set last_seen = now() where game_id = p_game and seat = me
      returning cards, auto into h, away;
    if g.status = 'playing' and g.turn = me and g.phase = 'discard' then cc := rummy_close_card(h); end if;
  end if;
  return jsonb_build_object(
    'id', g.id, 'room_id', g.room_id, 'status', g.status, 'n', g.n, 'turn', g.turn, 'phase', g.phase,
    'seq', g.seq, 'pile_top', g.pile[cardinality(g.pile)], 'pile_count', cardinality(g.pile),
    'deck_count', g.deck_count, 'counts', to_jsonb(g.counts), 'names', to_jsonb(g.names),
    'bots', to_jsonb(g.bots), 'autos', to_jsonb(g.autos),
    'online', (select jsonb_agg(p.is_bot or p.last_seen > now() - interval '40 seconds' order by p.seat)
                 from rummy_players p where p.game_id = g.id),
    'deadline_ms', case when g.deadline is null then null
                        else greatest(0, floor(extract(epoch from (g.deadline - now())) * 1000))::bigint end,
    'reshuffles', g.reshuffles, 'winner', g.winner, 'winner_melds', g.winner_melds,
    'ended_reason', g.ended_reason, 'log', g.log,
    'me', me, 'hand', to_jsonb(h), 'away', away, 'close_card', cc);
end $$;

-- my current game or room (used after a refresh)
create or replace function rummy_current() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); rid bigint; gid bigint;
begin
  select room_id into rid from rummy_room_seats where user_id = u;
  select p.game_id into gid from rummy_players p join rummy_games g on g.id = p.game_id
   where p.user_id = u and not p.left_game and g.status = 'playing' order by p.game_id desc limit 1;
  return jsonb_build_object('room', rid, 'game', gid);
end $$;

create or replace function rummy__check_turn(p_game bigint, p_seq int, p_phase text) returns int
language plpgsql as $$
declare g rummy_games; me int;
begin
  select * into g from rummy_games where id = p_game for update;
  if not found then raise exception 'game_gone'; end if;
  if g.status <> 'playing' then raise exception 'game_over'; end if;
  me := rummy__my_seat(p_game, rummy__me());
  if me is null then raise exception 'not_in_game'; end if;
  if g.turn <> me then raise exception 'not_your_turn'; end if;
  if g.seq <> p_seq then raise exception 'stale'; end if;
  if g.phase <> p_phase then raise exception 'wrong_phase'; end if;
  update rummy_players set misses = 0, auto = false, last_seen = now() where game_id = p_game and seat = me;
  return me;
end $$;

create or replace function rummy_draw(p_game bigint, p_src text, p_seq int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform rummy__check_turn(p_game, p_seq, 'draw');
  if p_src not in ('deck', 'pile') then raise exception 'bad_source'; end if;
  perform rummy__draw(p_game, p_src);
  return rummy_state(p_game);
end $$;

create or replace function rummy_discard(p_game bigint, p_card int, p_seq int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform rummy__check_turn(p_game, p_seq, 'discard');
  perform rummy__discard(p_game, p_card);
  perform rummy__run_bots(p_game);
  return rummy_state(p_game);
end $$;

create or replace function rummy_close(p_game bigint, p_card int, p_seq int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform rummy__check_turn(p_game, p_seq, 'discard');
  if not rummy__close(p_game, p_card) then raise exception 'not_a_win'; end if;
  return rummy_state(p_game);
end $$;

-- save my own hand order (same cards, new order)
create or replace function rummy_hand_order(p_game bigint, p_cards int[]) returns void
language plpgsql security definer set search_path = public as $$
declare me int; h int[];
begin
  me := rummy__my_seat(p_game, rummy__me());
  if me is null then raise exception 'not_in_game'; end if;
  select cards into h from rummy_players where game_id = p_game and seat = me for update;
  if (select array_agg(x order by x) from unnest(h) x) is distinct from
     (select array_agg(x order by x) from unnest(p_cards) x) then raise exception 'stale'; end if;
  update rummy_players set cards = p_cards where game_id = p_game and seat = me;
end $$;

-- time ran out for the player on turn: play for them. After 2 misses a bot keeps playing for them.
create or replace function rummy_tick(p_game bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g rummy_games; h int[]; c int; m int;
begin
  perform rummy__me();
  select * into g from rummy_games where id = p_game for update;
  if not found or g.status <> 'playing' or g.deadline is null or g.deadline > now() then
    return jsonb_build_object('ok', false);
  end if;
  update rummy_players set misses = misses + 1 where game_id = p_game and seat = g.turn returning misses into m;
  if g.phase = 'draw' then
    c := rummy__draw(p_game, 'deck');
    if c is null then return jsonb_build_object('ok', true); end if;
  else
    select cards into h from rummy_players where game_id = p_game and seat = g.turn;
    c := h[cardinality(h)];
  end if;
  select * into g from rummy_games where id = p_game;
  g.seq := g.seq + 1;
  update rummy_games set seq = g.seq, log = rummy__log(g, jsonb_build_object('n', g.seq, 'a', 'timeout', 'seat', g.turn))
   where id = p_game;
  perform rummy__discard(p_game, c);
  if m >= 2 then
    update rummy_players set auto = true where game_id = p_game and seat = g.turn;
    update rummy_games set autos = (select array_agg(auto order by seat) from rummy_players where game_id = p_game)
     where id = p_game;
  end if;
  perform rummy__run_bots(p_game);
  return jsonb_build_object('ok', true);
end $$;

-- I'm back: stop the bot that plays for me
create or replace function rummy_resume(p_game bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me int;
begin
  me := rummy__my_seat(p_game, rummy__me());
  if me is null then raise exception 'not_in_game'; end if;
  update rummy_players set auto = false, misses = 0, last_seen = now() where game_id = p_game and seat = me;
  update rummy_games set autos = (select array_agg(auto order by seat) from rummy_players where game_id = p_game),
    updated_at = now() where id = p_game;
  return rummy_state(p_game);
end $$;

-- ---------- permissions ----------
revoke all on function rummy__solve(int[], int), rummy__walk(int[], int, int, int, int, int, int[], int),
  rummy__draw(bigint, text), rummy__discard(bigint, int), rummy__close(bigint, int),
  rummy__bot_turn(bigint), rummy__run_bots(bigint), rummy__finish(bigint, int, jsonb, text),
  rummy__leave_all(uuid), rummy__check_turn(bigint, int, text) from public, anon, authenticated;

grant execute on function rummy_profile_ensure(text), rummy_lobby(), rummy_room_create(text, int),
  rummy_room_join(bigint), rummy_room_leave(), rummy_room_add_bot(bigint), rummy_room_remove_bot(bigint, int),
  rummy_room_get(bigint), rummy_game_start(bigint), rummy_state(bigint), rummy_current(),
  rummy_draw(bigint, text, int), rummy_discard(bigint, int, int), rummy_close(bigint, int, int),
  rummy_hand_order(bigint, int[]), rummy_tick(bigint), rummy_resume(bigint) to authenticated;
grant execute on function rummy_log_error(text, text, text, text) to anon, authenticated;
