-- =====================================================================
-- Turn time chosen by the host when opening a table: 10..60 seconds, steps of 10 (default 30).
-- Safe to run more than once.
-- UNDO: run 0001 then 0002 again, then:
--   alter table rummy_rooms drop column if exists turn_secs; alter table rummy_games drop column if exists turn_secs;
--   drop function if exists rummy_room_create(text, int, int);
-- =====================================================================
alter table rummy_rooms add column if not exists turn_secs int not null default 30;
alter table rummy_games add column if not exists turn_secs int not null default 30;
drop function if exists rummy_room_create(text, int);


create or replace function rummy_room_create(p_name text, p_max int, p_secs int default 30) returns bigint
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); rid bigint; nm text := left(btrim(coalesce(p_name, '')), 24);
begin
  if not exists (select 1 from rummy_profiles where id = u) then raise exception 'no_profile'; end if;
  if exists (select 1 from rummy_room_seats s join rummy_rooms rr on rr.id = s.room_id
             where s.user_id = u and rr.status = 'playing') then raise exception 'in_game'; end if;
  perform rummy__leave_all(u);
  if nm = '' then nm := 'השולחן של ' || (select nickname from rummy_profiles where id = u); end if;
  insert into rummy_rooms(name, host, max_seats, turn_secs) values (nm, u, least(4, greatest(2, coalesce(p_max, 4))),
    least(60, greatest(10, (round(coalesce(p_secs, 30) / 10.0) * 10)::int)))
  returning id into rid;
  insert into rummy_room_seats(room_id, seat, user_id) values (rid, 0, u);
  return rid;
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

  insert into rummy_games(room_id, n, turn, turn_secs) values (p_room, np, starter, r.turn_secs) returning id into gid;
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
    deadline = now() + make_interval(secs => r.turn_secs + 5),
    log = jsonb_build_array(jsonb_build_object('n', 0, 'a', 'deal', 'turn', starter))
  where id = gid;
  update rummy_rooms set status = 'playing', game_id = gid, next_starter = starter + 1 where id = p_room;
  perform rummy__touch_room(p_room);
  -- if the first player is a bot, let the bots play until a human's turn
  perform rummy__run_bots(gid);
  return gid;
end $$;

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
    turn = nxt, phase = 'draw', deadline = now() + make_interval(secs => g.turn_secs), updated_at = now()
  where id = gid;
end $$;

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
    update rummy_games set deadline = now() + make_interval(secs => g.turn_secs + k * 1.3)
     where id = gid and status = 'playing';
  end if;
end $$;

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
    'reshuffles', g.reshuffles, 'turn_secs', g.turn_secs, 'winner', g.winner, 'winner_melds', g.winner_melds,
    'ended_reason', g.ended_reason, 'log', g.log,
    'me', me, 'hand', to_jsonb(h), 'away', away, 'close_card', cc);
end $$;

create or replace function rummy_lobby() returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := rummy__me(); rooms jsonb; mine bigint; me rummy_profiles;
begin
  select * into me from rummy_profiles where id = u;
  select room_id into mine from rummy_room_seats where user_id = u;
  select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]') into rooms from (
    select jsonb_build_object(
      'id', r.id, 'name', r.name, 'secs', r.turn_secs, 'status', r.status, 'max', r.max_seats,
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
  return jsonb_build_object('id', r.id, 'name', r.name, 'status', r.status, 'max', r.max_seats, 'secs', r.turn_secs,
    'game_id', r.game_id, 'is_host', r.host = u, 'seats', seats,
    'in_room', exists (select 1 from rummy_room_seats where room_id = p_room and user_id = u));
end $$;

grant execute on function rummy_room_create(text, int, int) to authenticated;

-- Bots never throw back the tile they just took from the open pile (stops bots passing one tile around forever).
create or replace function rummy__bot_discard(hand int[], p_excl int) returns int language plpgsql volatile as $$
declare c int; best int; bestv int := 1000000; v int; skipped boolean := false;
begin
  for c in select x from unnest(hand) x order by random() loop
    if c >= 104 then continue; end if;
    if c = p_excl and not skipped then skipped := true; continue; end if;
    v := rummy__card_value(rummy__remove(hand, c), c);
    if v < bestv then bestv := v; best := c; end if;
  end loop;
  if best is null then best := hand[1]; end if;
  return best;
end $$;

create or replace function rummy__bot_turn(gid bigint) returns void language plpgsql as $$
declare g rummy_games; h int[]; top int; c int; cc int; took int;
begin
  select * into g from rummy_games where id = gid;
  if g.status <> 'playing' then return; end if;
  select cards into h from rummy_players where game_id = gid and seat = g.turn;
  if g.phase = 'draw' then
    top := g.pile[cardinality(g.pile)];
    if top is not null and (top >= 104
        or rummy_close_card(h || top) is not null
        or rummy__card_value(h, top) >= 6) then
      perform rummy__draw(gid, 'pile'); took := top;
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
  c := rummy__bot_discard(h, took);
  perform rummy__discard(gid, c);
end $$;
revoke all on function rummy__bot_discard(int[], int), rummy__bot_turn(bigint) from public, anon, authenticated;
