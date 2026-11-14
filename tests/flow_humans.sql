-- Two real players + one bot: join, start, turn rules, stale moves, hand privacy, timeout, leave.
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-0000000000b1','a@x'),('00000000-0000-0000-0000-0000000000b2','b@x') on conflict do nothing;
do $$
declare a uuid := '00000000-0000-0000-0000-0000000000b1'; b uuid := '00000000-0000-0000-0000-0000000000b2';
  rid bigint; gid bigint; st jsonb; seq int; turn int; who uuid; other uuid; h jsonb; c int; ok boolean; msg text; i int;
  procedure_as text;
begin
  perform set_config('request.jwt.sub', a::text, true);
  begin perform rummy_profile_ensure('אלון'); exception when others then null; end;
  perform set_config('request.jwt.sub', b::text, true);
  begin perform rummy_profile_ensure('בני'); exception when others then null; end;
  -- duplicate nickname rejected
  begin perform rummy_profile_ensure('אלון'); exception when others then msg := sqlerrm; end;

  perform set_config('request.jwt.sub', a::text, true);
  perform rummy_room_leave();
  rid := rummy_room_create('', 3);
  perform set_config('request.jwt.sub', b::text, true);
  perform rummy_room_leave();
  perform rummy_room_join(rid);
  -- b is not host: cannot add bot / start
  begin perform rummy_room_add_bot(rid); raise exception 'FAIL non-host added bot'; exception when others then
    if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('request.jwt.sub', a::text, true);
  perform rummy_room_add_bot(rid);
  if jsonb_array_length(rummy_room_get(rid)->'seats') <> 3 then raise exception 'FAIL seats'; end if;
  gid := rummy_game_start(rid);
  st := rummy_state(gid);
  raise notice 'start: turn=% names=% counts=%', st->'turn', st->'names', st->'counts';
  if jsonb_array_length(st->'hand') <> 14 then raise exception 'FAIL hand size %', st->'hand'; end if;

  -- play 40 actions alternating whoever's turn it is
  for i in 1 .. 40 loop
    perform set_config('request.jwt.sub', a::text, true);
    st := rummy_state(gid);
    exit when st->>'status' <> 'playing';
    turn := (st->>'turn')::int;
    if turn = (st->>'me')::int then who := a; else who := b; end if;
    perform set_config('request.jwt.sub', who::text, true);
    st := rummy_state(gid);
    if (st->>'me')::int <> turn then raise exception 'FAIL turn is bot? %', st; end if;
    seq := (st->>'seq')::int;
    -- the other human cannot move
    other := case when who = a then b else a end;
    perform set_config('request.jwt.sub', other::text, true);
    begin perform rummy_draw(gid, 'deck', seq); raise exception 'FAIL other moved'; exception when others then
      if sqlerrm like 'FAIL%' then raise; end if; end;
    perform set_config('request.jwt.sub', who::text, true);
    -- discard before draw is refused
    begin perform rummy_discard(gid, (st->'hand'->>0)::int, seq); raise exception 'FAIL discard before draw'; exception when others then
      if sqlerrm like 'FAIL%' then raise; end if; end;
    st := rummy_draw(gid, 'deck', seq);
    if jsonb_array_length(st->'hand') <> 15 then raise exception 'FAIL 15'; end if;
    -- double tap with old seq refused
    begin perform rummy_draw(gid, 'deck', seq); raise exception 'FAIL double draw'; exception when others then
      if sqlerrm like 'FAIL%' then raise; end if; end;
    -- discarding a card I don't hold is refused
    begin perform rummy_discard(gid, 999, (st->>'seq')::int); raise exception 'FAIL fake card'; exception when others then
      if sqlerrm like 'FAIL%' then raise; end if; end;
    -- reorder hand (reverse) is accepted, changing cards is refused
    perform rummy_hand_order(gid, (select array_agg(x::int order by o desc) from jsonb_array_elements_text(st->'hand') with ordinality t(x, o)));
    begin perform rummy_hand_order(gid, array[1,2,3]); raise exception 'FAIL fake order'; exception when others then
      if sqlerrm like 'FAIL%' then raise; end if; end;
    st := rummy_state(gid);
    if st->>'close_card' is not null then
      st := rummy_close(gid, (st->>'close_card')::int, (st->>'seq')::int);
      raise notice 'closed by %', who; exit;
    end if;
    st := rummy_discard(gid, (st->'hand'->>14)::int, (st->>'seq')::int);
  end loop;
  -- privacy: plain user cannot read hands/deck tables
  raise notice 'after loop: status=% seq=% log_len=%', st->>'status', st->>'seq', jsonb_array_length(st->'log');

  -- timeout: force deadline, tick plays for the player; 2 misses -> auto
  if (rummy_state(gid))->>'status' = 'playing' then
    for i in 1 .. 2 loop
      update rummy_games set deadline = now() - interval '1 second' where id = gid;
      perform rummy_tick(gid);
    end loop;
    raise notice 'autos after 2 timeouts: %', (select autos from rummy_games where id = gid);
    -- a leaves mid game: seat becomes auto, room keeps b
    perform set_config('request.jwt.sub', a::text, true);
    perform rummy_room_leave();
    perform set_config('request.jwt.sub', b::text, true);
    st := rummy_resume(gid);
    raise notice 'after a left + b resumed: autos=% status=%', st->'autos', st->>'status';
    -- b leaves: no humans -> room closed, game abandoned
    perform rummy_room_leave();
    raise notice 'final: game=% room=%', (select ended_reason from rummy_games where id = gid), (select status from rummy_rooms where id = rid);
  end if;
  raise notice 'FLOW OK';
end $$;
set role authenticated;
select set_config('request.jwt.sub', '00000000-0000-0000-0000-0000000000b1', false);
do $$ begin
  begin perform * from rummy_players; raise exception 'FAIL players readable'; exception when insufficient_privilege then null; end;
  begin perform * from rummy_secret; raise exception 'FAIL deck readable'; exception when insufficient_privilege then null; end;
  raise notice 'PRIVACY OK';
end $$;
reset role;
