-- Simulate many full games with bots only. Prints outcome counts and timing.
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','sim@x') on conflict do nothing;
do $$
declare u uuid := '00000000-0000-0000-0000-00000000000a'; rid bigint; gid bigint; i int;
  wins int := 0; draws int := 0; other int := 0; t0 timestamptz := clock_timestamp(); g rummy_games;
  turns int := 0; bad int := 0; total int; nplayers int;
begin
  perform set_config('request.jwt.sub', u::text, true);
  begin perform rummy_profile_ensure('סימולציה'); exception when others then null; end;
  for i in 1 .. __G__ loop
    nplayers := 2 + (i % 3);
    rid := rummy_room_create('sim', nplayers);
    for k in 2 .. nplayers loop perform rummy_room_add_bot(rid); end loop;
    gid := rummy_game_start(rid);
    update rummy_players set auto = true where game_id = gid;   -- the human is played by a bot too
    perform rummy__run_bots(gid);
    select * into g from rummy_games where id = gid;
    -- invariants: 108 cards exactly, no duplicates
    select (select count(*) from rummy_players p, unnest(p.cards) where p.game_id = gid)
         + cardinality(g.pile) + (select cardinality(deck) from rummy_secret where game_id = gid) into total;
    if total <> 108 or exists (select x from (select unnest(cards) x from rummy_players where game_id = gid
                       union all select unnest(g.pile) union all select unnest(deck) from rummy_secret where game_id = gid) z
                       group by x having count(*) > 1) then bad := bad + 1; end if;
    if g.ended_reason = 'win' then
      wins := wins + 1;
      if not rummy_is_win((select cards from rummy_players where game_id = gid and seat = g.winner)) then bad := bad + 1; end if;
    elsif g.ended_reason = 'draw' then draws := draws + 1; else other := other + 1; end if;
    turns := turns + g.seq;
    perform rummy_room_leave();
  end loop;
  raise notice 'games=% wins=% draws=% other=% bad=% avg_actions=% ms_per_game=%', __G__, wins, draws, other, bad,
    turns / __G__, round(extract(epoch from clock_timestamp() - t0) * 1000 / __G__);
end $$;
