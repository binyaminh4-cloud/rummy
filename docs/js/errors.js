// Sends browser errors to the server so we know about problems on friends' phones.
(function () {
  var sent = 0;
  function report(msg, detail) {
    try {
      if (sent >= 20 || !window.supabase || !window.RUMMY_CONFIG) return;
      sent++;
      var db = window.__rummyDb || window.supabase.createClient(RUMMY_CONFIG.url, RUMMY_CONFIG.key);
      db.rpc('rummy_log_error', {
        p_msg: String(msg || '').slice(0, 500), p_detail: String(detail || '').slice(0, 2000),
        p_ua: navigator.userAgent.slice(0, 300), p_url: location.href.slice(0, 300)
      }).then(function () {}, function () {});
    } catch (e) { /* never break the page */ }
  }
  window.rummyReport = report;
  window.addEventListener('error', function (e) {
    report(e.message, (e.filename || '') + ':' + (e.lineno || '') + ' ' + (e.error && e.error.stack || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    report('promise: ' + (r.message || r), r.stack || '');
  });
})();
