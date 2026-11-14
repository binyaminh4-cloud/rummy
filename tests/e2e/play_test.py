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
    if page.is_visible("#closeBtn"):
        page.click("#closeBtn")
        return "closed"
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

        # 2. play some turns online
        actions = 0
        t0 = time.time()
        refreshed = False
        while time.time() - t0 < 120 and actions < 16:
            if ended(alice) or ended(bob):
                break
            for pg in (alice, bob):
                if my_turn(pg) and "שלוף" in pg.inner_text("#turnBanner"):
                    play_turn(pg); actions += 1
                    if actions == 3:
                        shot(pg, "09_after_discard")
            if actions == 6 and not refreshed:
                refreshed = True
                before = bob.locator("#hand .card").count()
                bob.reload(); bob.wait_for_selector("#game.show", timeout=15000)
                wait_js(bob, "document.querySelectorAll('#hand .card').length > 0", timeout=20000); time.sleep(1)
                after = bob.locator("#hand .card").count()
                assert before == after, f"refresh changed hand {before} -> {after}"
                shot(bob, "10_bob_after_refresh")
            time.sleep(0.6)
        print("online actions:", actions)

        # 3. force a winning hand for whoever is on turn to draw, then close
        gid = sql("select max(id) from rummy_games")
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
        for _ in range(30):
            for pg in (alice, bob):
                if my_turn(pg) and "שלוף" in pg.inner_text("#turnBanner"):
                    pg.click("#deckBtn", force=True); time.sleep(1.2)
                    if pg.is_visible("#closeBtn"):
                        shot(pg, "11_close_ready"); pg.click("#closeBtn"); winner_page = pg
            if winner_page:
                break
            time.sleep(0.8)
        assert winner_page, "close button never appeared"
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
        while not ended(carol) and time.time() - t0 < 240:
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
