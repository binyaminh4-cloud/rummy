# Rummy (without lay-downs) — rules for every chat / tool

- Read `claude/RUMMY_PLAN.md` in the Claude Project ("משחק רמי") first; it is the state file.
- Site: GitHub Pages from `docs/` (push to `main` = live). Server: Supabase project `zcjrollyvcvkvirqhbbf` (only for this game).
- All game rules run on the server (`supabase/migrations`). The page never decides a move.
- Migrations: new numbered file, safe to run twice, tested locally twice (`tests/`), undo file in `supabase/undo/`.
- No lay-downs: never add play-meld / place-set / place-run / lay-down features in this version.
- Tests before every push: `python3 tests/run_rules.py tests/rules_cases.json`, `python3 tests/fuzz_rules.py 1 3000`,
  `psql ... -f tests/flow_humans.sql`, the bot simulation, and the browser test in `tests/e2e`.
- Bump `?v=` on every changed JS/CSS file.
- Talk to Binyamin in simple Hebrew.
