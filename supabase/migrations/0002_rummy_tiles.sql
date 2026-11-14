-- =====================================================================
-- Rummy with TILES (like the Israeli rummy set): 4 colours x 1..13 x 2 + 2 jokers = 106 tiles.
-- Changes from 0001: no "ace high" (runs are 1..13 only, 13-1 is not allowed),
-- 2 jokers instead of 4, deck of 106. Colour = old "suit" (0 red, 1 blue, 2 orange, 3 black).
-- Safe to run more than once.
-- UNDO: run 0001_rummy_core.sql again (restores the playing-card version of these functions).
-- =====================================================================

create or replace function rummy__walk(rem int[], j int, s int, v int, c int, p int, meld int[], nreal int)
returns jsonb language plpgsql immutable as $$
declare
  res jsonb; idx int; rk int; maxhi int;
begin
  maxhi := 13;
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
  foreach v in array array[k] loop
    minlo := 1;
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
      if d = 1 then best := best + 3;
      elsif d = 2 then best := best + 1; end if;
    elsif xk = k and not xs = any(same_rank_suits) then
      same_rank_suits := same_rank_suits || xs;
      best := best + 3;
    end if;
  end loop;
  return best;
end $$;

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

  select array_agg(x order by random()) into deck from generate_series(0, 105) x;
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
    pile = array[deck[np * 14 + 1]], deck_count = 106 - np * 14 - 1,
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
