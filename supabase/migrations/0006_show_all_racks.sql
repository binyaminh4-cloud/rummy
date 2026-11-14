-- At the end of a game every player's rack is revealed to everyone at the table. Safe to run more than once.
-- UNDO: run 0003_turn_time.sql's rummy_state again.
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
    'me', me, 'hand', to_jsonb(h), 'away', away, 'close_card', cc,
    -- when the game is over everybody's rack is shown (names next to them, winner highlighted)
    'all_hands', case when g.status = 'over' then
      (select jsonb_agg(to_jsonb(p.cards) order by p.seat) from rummy_players p where p.game_id = g.id) end);
end $$;
