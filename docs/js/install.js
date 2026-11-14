// Phones must add the game to the home screen (full screen, own icon). Computers are not asked.
(function () {
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var phone = (isIOS || isAndroid) && Math.min(screen.width, screen.height) < 820;
  var inApp = /FBAN|FBAV|Instagram|WhatsApp|Line\/|Telegram|; wv\)/.test(ua);
  var iosNotSafari = isIOS && /CriOS|FxiOS|EdgiOS/.test(ua);
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    var b = document.getElementById('installBtn'); if (b) b.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', function () { var o = document.getElementById('install'); if (o) o.classList.add('hidden'); });
  var skipped = false; try { skipped = sessionStorage.getItem('rummy_skip_install') === '1'; } catch (e) { /* ignore */ }
  if (standalone || !phone || skipped) return;

  function step(n, html) { return '<div class="istep"><b>' + n + '</b><span>' + html + '</span></div>'; }
  var share = '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align:-4px"><path fill="none" stroke="#6fb3ff" stroke-width="2" d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8"/></svg>';
  var steps;
  if (inApp) {
    steps = step(1, 'פתחת את הקישור מתוך אפליקציה (וואטסאפ וכו\'). לחץ על <b>⋮</b> או <b>…</b> ובחר <b>' + (isIOS ? 'פתח ב-Safari' : 'פתח ב-Chrome') + '</b>.') +
            step(2, 'שם תופיע ההוראה להוספה למסך הבית.');
  } else if (isIOS && iosNotSafari) {
    steps = step(1, 'באייפון מוסיפים למסך הבית רק מ-<b>Safari</b>. העתק את הקישור ופתח אותו ב-Safari.');
  } else if (isIOS) {
    steps = step(1, 'לחץ על כפתור השיתוף ' + share + ' בתחתית המסך (או למעלה באייפד).') +
            step(2, 'גלול ובחר <b>הוסף למסך הבית</b>.') +
            step(3, 'לחץ <b>הוסף</b> — ואז פתח את רמי מהאייקון החדש.');
  } else {
    steps = step(1, 'לחץ על הכפתור למטה, או בתפריט <b>⋮</b> בחר <b>הוסף למסך הבית / התקן אפליקציה</b>.') +
            step(2, 'פתח את רמי מהאייקון החדש.');
  }
  function show() {
    var o = document.getElementById('install'); if (!o) return;
    document.getElementById('installSteps').innerHTML = steps;
    if (deferred) document.getElementById('installBtn').classList.remove('hidden');
    o.classList.remove('hidden');
    // nobody gets stuck: after 20 seconds a small "continue anyway" link appears
    setTimeout(function () { document.getElementById('installSkip').classList.remove('hidden'); }, 20000);
    document.getElementById('installBtn').onclick = function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function (c) { if (c && c.outcome === 'accepted') o.classList.add('hidden'); deferred = null; });
    };
    document.getElementById('installSkip').onclick = function () {
      try { sessionStorage.setItem('rummy_skip_install', '1'); } catch (e) { /* ignore */ }
      o.classList.add('hidden');
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
