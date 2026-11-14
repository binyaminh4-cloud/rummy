"""Browser test: two real players + a bot play online, a solo game against 3 bots, refresh mid-game,
and a forced winning hand. Uses the mock Supabase (real SQL on local Postgres).
Run: python3 -I tests/e2e/play_test.py   (needs: docs served on :8765, mock on :8790)
Screenshots go to /tmp/shots.
"""
import os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

SITE = "http://localhost:8765/index.html"
OUT = "/tmp/shots"
os.makedirs(OUT, exist_ok=True)
errors = []
PSQL = ["psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", "t", "-At", "-c"]
run_id = str(int(time.time()))[-5:]


def sql(q):
    return subprocess.run(PSQL + [q], capture_output=True, text=True).stdout.strip()


def new_page(browser, name, w=844, h=390):
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, has_touch=False, locale="he-IL")
    page = ctx.new_page()
    page.route("**/js/config.js*", lambda r: r.fulfill(content_type="application/javascript",
               body='window.RUMMY_CONFIG={url:"http://localhost:8790",key:"test-key"};'))
    page.route(re.compile(r"^https?://(?!localhost).*"), lambda r: r.abort())
    page.on("pageerror", lambda e: errors.append(f"[{name}] pageerror {e}"))
    page.on("console", lambda m: errors.append(f"[{name}] console {m.text}") if m.type == "error" and "status of 400" not in m.text and "websocket" not in m.text.lower() and "realtime" not in m.text.lower() and "ERR_FAILED" not in m.text else None)
    return page


def wait_js(page, expr, timeout=10000, polling=None):
    """Poll from Python: background test pages may not run their own timers/animation frames."""
    end = time.time() + timeout / 1000
    while time.time() < end:
        try:
            if page.evaluate(expr):
                return True
        except Exception:
            pass
        time.sleep(0.2)
    raise TimeoutError("wait_js timeout: " + expr[:80])


def shot(page, name):
    page.screenshot(path=f"{OUT}/{name}.png")


def login(page, nick, pw="secret12"):
    page.goto(SITE)
    page.wait_for_selector("#login.show", timeout=15000)
    page.fill("#nick", nick)
    page.fill("#pass", pw)
    page.click("#loginBtn")
    page.wait_for_selector("#lobby.show, #room.show, #game.show", timeout=15000)


def my_turn(page):
    return page.evaluate("document.getElementById('turnBanner').classList.contains('mine')")


def play_turn(page):
    """Draw from the deck, then close if possible, else throw the last card in hand."""
    page.click("#deckBtn", force=True)
    try:
        wait_js(page, "!document.getElementById('turnBanner').textContent.includes('שלוף') || !document.getElementById('end').classList.contains('hidden')", timeout=10000, polling=200)
    except Exception:
        shot(page, "fail_draw")
        print("DRAW FAILED banner=", page.inner_text("#turnBanner"), "dbg=", page.evaluate("window.__rummyDebug()"))
        raise
    time.sleep(0.4)
    for _ in range(5):
        try:
            page.locator("#hand .card").last.click(timeout=3000)
            time.sleep(0.15)
            if page.locator("#hand .card.sel").count():
                page.locator("#hand .card.sel").click(timeout=3000)
            return "played"
        except Exception:
            time.sleep(0.4)
    return "failed"


def play_turn_after_draw(page):
    page.locator("#hand .card").last.click(timeout=3000); time.sleep(0.15)
    if page.locator("#hand .card.sel").count():
        page.locator("#hand .card.sel").click(timeout=3000)


def drag(page, sel_from, to_xy):
    b = page.locator(sel_from).bounding_box()
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2); page.mouse.down()
    for k in range(1, 9):
        page.mouse.move(b["x"] + b["width"] / 2 + (to_xy[0] - b["x"] - b["width"] / 2) * k / 8,
                        b["y"] + b["height"] / 2 + (to_xy[1] - b["y"] - b["height"] / 2) * k / 8)
        time.sleep(0.03)
    page.mouse.up(); time.sleep(0.4)


def ended(page):
    return page.evaluate("!document.getElementById('end').classList.contains('hidden')")


def main():
    try:
        return run()
    finally:
        bad = [e for e in errors if "favicon" not in e]
        print("errors:", len(bad))
        for e in bad[:30]:
            print("  ", e)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
        alice = new_page(browser, "alice")
        bob = new_page(browser, "bob", 1280, 720)

        # 1. login + lobby
        alice.goto(SITE); alice.wait_for_selector("#login.show", timeout=15000); shot(alice, "01_login")
        login(alice, "אליס" + run_id)
        shot(alice, "02_lobby_empty")
        alice.click("#seatSeg button[data-n='3']")
        alice.fill("#roomName", "שולחן " + run_id)
        alice.click("#secsWheel .opt[data-v='20']"); time.sleep(0.8)
        shot(alice, "02b_wheel_20")
        alice.click("#createBtn")
        alice.wait_for_selector("#room.show", timeout=10000)
        wait_js(alice, "document.getElementById('roomTitle').textContent.includes('20 שניות')", timeout=10000)
        shot(alice, "03_room_alone")

        login(bob, "בוב" + run_id)
        bob.wait_for_selector(".room-card", timeout=10000)
        shot(bob, "04_bob_lobby")
        bob.locator(".room-card", has_text="שולחן " + run_id).locator("button").click()
        bob.wait_for_selector("#room.show", timeout=10000)
        wait_js(alice, "document.querySelectorAll('#seatList .seat:not(.empty)').length === 2", timeout=10000, polling=200)
        alice.click("#seatList .seat.empty button")
        wait_js(alice, "document.querySelectorAll('#seatList .seat:not(.empty)').length === 3", timeout=10000, polling=200)
        wait_js(bob, "document.querySelectorAll('#seatList .seat:not(.empty)').length === 3", timeout=10000, polling=200)
        shot(alice, "05_room_full_host"); shot(bob, "06_room_full_guest")
        alice.click("#startBtn")
        alice.wait_for_selector("#game.show", timeout=15000)
        bob.wait_for_selector("#game.show", timeout=15000)
        time.sleep(3)
        shot(alice, "07_game_alice"); shot(bob, "08_game_bob")
        assert alice.locator("#hand .card").count() in (14, 15), "alice hand size"
        # free arranging: drag the first tile to the far right of the bottom shelf
        first = alice.locator("#hand .card").first.get_attribute("data-c")
        hb = alice.locator("#hand").bounding_box()
        drag(alice, f"#hand .card[data-c='{first}']", (hb["x"] + hb["width"] - 30, hb["y"] + hb["height"] - 40))
        nb = alice.locator(f"#hand .card[data-c='{first}']").bounding_box()
        assert nb["y"] > hb["y"] + hb["height"] / 2 and nb["x"] > hb["x"] + hb["width"] * 0.8, f"drag did not move tile {nb}"
        shot(alice, "07b_rack_dragged")
        alice.reload(); alice.wait_for_selector("#game.show", timeout=15000)
        wait_js(alice, "document.querySelectorAll('#hand .card').length > 0", timeout=20000); time.sleep(0.8)
        nb2 = alice.locator(f"#hand .card[data-c='{first}']").bounding_box()
        assert abs(nb2["x"] - nb["x"]) < 4 and abs(nb2["y"] - nb["y"]) < 4, "rack layout lost after refresh"

        # 2. play some turns online
        actions = 0
        t0 = time.time()
        refreshed = False
        while time.time() - t0 < 300 and actions < 16:
            if ended(alice) or ended(bob):
                break
            for pg in (alice, bob):
                if my_turn(pg) and "שלוף" in pg.inner_text("#turnBanner"):
                    if actions == 4:
                        # pool button: the drawn tile is shown big in the middle, then lands on the rack
                        pg.click("#poolBtn")
                        wait_js(pg, "!!document.querySelector('.reveal')", timeout=8000)
                        shot(pg, "09b_reveal")
                        wait_js(pg, "!document.querySelector('.reveal') && document.querySelectorAll('#hand .card').length === 15", timeout=8000)
                        # throw by dragging a tile to the middle of the table
                        sb = pg.locator("#stage").bounding_box()
                        drag(pg, "#hand .card >> nth=3", (sb["x"] + sb["width"] * 0.3, sb["y"] + sb["height"] * 0.6))
                        wait_js(pg, "document.querySelectorAll('#hand .card').length === 14", timeout=10000)
                        actions += 1; continue
                    if actions == 8:
                        # drag the open tile onto an empty slot at the right end of the bottom shelf
                        top = pg.evaluate("window.__rummyDebug().pileTop")
                        hb = pg.locator("#hand").bounding_box()
                        drag(pg, "#pileBtn", (hb["x"] + hb["width"] - 25, hb["y"] + hb["height"] - 35))
                        wait_js(pg, "document.querySelectorAll('#hand .card').length === 15", timeout=10000); time.sleep(0.4)
                        tb = pg.locator(f"#hand .card[data-c='{top}']").bounding_box()
                        assert tb and tb["x"] > hb["x"] + hb["width"] * 0.85 and tb["y"] > hb["y"] + hb["height"] / 2, f"open tile not where dropped {tb}"
                        shot(pg, "09c_pile_dragged")
                        play_turn_after_draw(pg); actions += 1; continue
                    if actions == 2:
                        pg.click("#deckBtn", force=True)
                        wait_js(pg, "document.querySelectorAll('#hand .card').length === 15", timeout=10000)
                        pb = pg.locator("#pileBtn").bounding_box()
                        drag(pg, "#hand .card >> nth=0", (pb["x"] + pb["width"] / 2, pb["y"] + pb["height"] / 2))
                        wait_js(pg, "document.querySelectorAll('#hand .card').length === 14", timeout=10000)
                        actions += 1; continue
                    play_turn(pg); actions += 1
                    if actions == 3:
                        shot(pg, "09_after_discard")
            if actions == 6 and not refreshed:
                refreshed = True
                before = bob.locator("#hand .card").count()
                bob.reload(); bob.wait_for_selector("#game.show", timeout=15000)
                wait_js(bob, "document.querySelectorAll('#hand .card').length > 0", timeout=20000); time.sleep(1)
                after = bob.locator("#hand .card").count()
                gid_r = sql("select max(id) from rummy_games")
                srv = int(sql(f"select cardinality(p.cards) from rummy_players p join rummy_profiles f on f.id=p.user_id where p.game_id={gid_r} and f.nickname like 'בוב%'"))
                assert after == srv, f"after refresh the rack shows {after} tiles, server has {srv}"
                shot(bob, "10_bob_after_refresh")
            time.sleep(0.6)
        print("online actions:", actions)

        # 3. force a winning hand for whoever is on turn to draw, then close
        # (if the bot already won the online game, start another one first)
        if sql("select status from rummy_games order by id desc limit 1") != "playing":
            print("bot won the online game first — starting another one")
            alice.wait_for_selector("#againBtn:not(.hidden)", timeout=20000); alice.click("#againBtn")
            wait_js(alice, "document.getElementById('end').classList.contains('hidden')", timeout=15000)
            wait_js(bob, "document.getElementById('end').classList.contains('hidden')", timeout=20000)
            time.sleep(2)
        gid = sql("select max(id) from rummy_games")
        # keep the bot from winning during this step
        sql(f"update rummy_players set cards='{{3,17,31,45,59,73,87,101,7,21,35,49,63,77}}' where game_id={gid} and user_id is null")
        for _ in range(40):
            row = sql(f"select turn, phase, status from rummy_games where id={gid}")
            turn, phase, status = row.split("|")
            if status != "playing":
                break
            who = sql(f"select coalesce(user_id::text,'bot') from rummy_players where game_id={gid} and seat={turn}")
            if who != "bot" and phase == "draw":
                # 1-3 red, 4-8 blue, 9-11 orange, 11-13 black (14 tiles)
                sql(f"update rummy_players set cards='{{0,1,2,16,17,18,19,20,34,35,36,49,50,51}}' where game_id={gid} and seat={turn}")
                sql(f"update rummy_secret set deck = array_remove(array_remove(deck,0),1) where game_id={gid}")
                break
            time.sleep(1)
        winner_page = None
        for _ in range(80):
            for pg in (alice, bob):
                if my_turn(pg) and "שלוף" in pg.inner_text("#turnBanner"):
                    pg.click("#deckBtn", force=True); time.sleep(1.5)
                    gid_now = sql("select max(id) from rummy_games")
                    forced = sql(f"select cards[1:14] = '{{0,1,2,16,17,18,19,20,34,35,36,49,50,51}}' from rummy_players p join rummy_games g on g.id=p.game_id and p.seat=g.turn where g.id={gid_now}")
                    if forced == "t" and pg.is_visible("#closeBtn"):
                        # the player builds the groups himself: sort by colour, check the green lines, pick the drawn tile, close
                        drawn = sql(f"select cards[15] from rummy_players p join rummy_games g on g.id=p.game_id and p.seat=g.turn where g.id={gid_now}")
                        pg.click("#sortSuit"); time.sleep(0.6)
                        pg.locator(f"#hand .card[data-c='{drawn}']").click(); time.sleep(0.4)
                        shot(pg, "11_close_ready"); pg.click("#closeBtn"); winner_page = pg
                    elif pg.locator("#hand .card").count() == 15:
                        play_turn_after_draw(pg)
            if winner_page:
                break
            time.sleep(0.8)
        assert winner_page, "close button never appeared"
        winner_page.wait_for_selector("#racks:not(.hidden)", timeout=15000); time.sleep(1.5)
        assert winner_page.locator("#racks .rack-row").count() == 3, "all racks shown"
        assert winner_page.locator("#racks .rack-row.win").count() == 1, "winner rack highlighted"
        shot(winner_page, "11b_all_racks")
        winner_page.wait_for_selector("#end:not(.hidden)", timeout=15000); time.sleep(1)
        shot(winner_page, "12_end_winner")
        other = bob if winner_page is alice else alice
        other.wait_for_selector("#end:not(.hidden)", timeout=15000); time.sleep(1)
        shot(other, "13_end_other")
        assert "ניצחת" in winner_page.inner_text("#endTitle")

        # 4. play again (host) -> both move to the new game
        alice.wait_for_selector("#againBtn:not(.hidden)", timeout=10000)
        alice.click("#againBtn")
        wait_js(alice, "document.getElementById('end').classList.contains('hidden')", timeout=15000, polling=200)
        wait_js(bob, "document.getElementById('end').classList.contains('hidden')", timeout=15000, polling=200)
        time.sleep(2); shot(bob, "14_second_game")
        # Bob leaves mid-game -> a bot continues; Alice keeps playing
        bob.click("#menuBtn"); bob.click("#quitBtn"); bob.click("#quitBtn")
        bob.wait_for_selector("#lobby.show", timeout=10000)
        shot(bob, "15_bob_back_in_lobby")

        # 5. solo game vs 3 bots on a phone-sized screen, played to the end
        carol = new_page(browser, "carol", 844, 390)
        login(carol, "כרמל" + run_id)
        carol.click("#seatSeg button[data-n='4']"); carol.click("#createBtn")
        carol.wait_for_selector("#room.show")
        for i in range(3):
            carol.click("#seatList .seat.empty button")
            wait_js(carol, f"document.querySelectorAll('#seatList .seat:not(.empty)').length === {i + 2}", timeout=10000, polling=200)
        shot(carol, "16_room_bots")
        carol.click("#startBtn"); carol.wait_for_selector("#game.show", timeout=15000); time.sleep(3)
        shot(carol, "17_solo_game")
        moves = 0
        t0 = time.time()
        while not ended(carol) and time.time() - t0 < 900:
            if my_turn(carol) and "שלוף" in carol.inner_text("#turnBanner"):
                play_turn(carol); moves += 1
                if moves == 2:
                    time.sleep(1.5); shot(carol, "18_solo_mid")
            time.sleep(0.5)
        assert ended(carol), "solo game did not end"
        time.sleep(1); shot(carol, "19_solo_end")
        print("solo moves:", moves, "|", carol.inner_text("#endTitle"))

        # 6. portrait phone shows the rotate hint in game
        carol.set_viewport_size({"width": 390, "height": 844}); time.sleep(0.5); shot(carol, "20_portrait_hint")
        carol.click("#toLobbyBtn") if carol.is_visible("#toLobbyBtn") else None
        time.sleep(1); shot(carol, "21_lobby_portrait")
        browser.close()
    return 1 if [e for e in errors if "favicon" not in e] else 0


if __name__ == "__main__":
    sys.exit(main())
