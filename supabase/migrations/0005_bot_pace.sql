-- Each bot turn is shown for about 5 seconds, so the player's own clock starts only after the bots finish.
-- Safe to run more than once. UNDO: run 0003_turn_time.sql again.
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
    update rummy_games set deadline = now() + make_interval(secs => g.turn_secs + k * 5.0)
     where id = gid and status = 'playing';
  end if;
end $$;
