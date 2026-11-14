-- Bot names without the word "בוט" (the robot icon already shows it is a bot). Safe to run more than once.
-- UNDO: run 0001_rummy_core.sql's rummy_room_add_bot again.
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
  select x into nm from unnest(array['דני','מאיה','יוסי','נועה','אבי','שירה']) x
   where x not in (select coalesce(bot_name, '') from rummy_room_seats where room_id = p_room)
   order by random() limit 1;
  insert into rummy_room_seats(room_id, seat, user_id, bot_name) values (p_room, free, null, nm);
  perform rummy__touch_room(p_room);
end $$;
