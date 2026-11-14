-- Removes everything the rummy game added. Does not touch anything else.
drop table if exists rummy_errors, rummy_secret, rummy_players, rummy_games,
  rummy_room_seats, rummy_rooms, rummy_profiles cascade;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'rummy%' loop
    execute 'drop function if exists ' || f.sig || ' cascade';
  end loop;
end $$;
