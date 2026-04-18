// Backend now runs on Vercel serverless (same origin as the frontend).
// BACKEND_ORIGIN is empty so /auth/* and /api/* stay relative and hit
// api/[...all].js via vercel.json rewrites. Webhooks continue to run on
// EC2 and are NOT called from the browser — third parties (Meta, Razorpay,
// Porter) post directly to the EC2 host.
(function () {
  var BACKEND_ORIGIN = '';
  var BACKEND_PREFIXES = ['/api/', '/auth/', '/webhooks/', '/admin/'];

  window.BACKEND_ORIGIN = BACKEND_ORIGIN;

  function rewrite(url) {
    if (typeof url !== 'string') return url;
    if (/^https?:\/\//i.test(url)) return url;
    for (var i = 0; i < BACKEND_PREFIXES.length; i++) {
      if (url.indexOf(BACKEND_PREFIXES[i]) === 0) return BACKEND_ORIGIN + url;
    }
    return url;
  }

  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rewrite(input);
    } else if (input && typeof input.url === 'string') {
      var rewritten = rewrite(input.url);
      if (rewritten !== input.url) input = new Request(rewritten, input);
    }
    return _fetch(input, init);
  };

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = rewrite(url);
    return _open.apply(this, arguments);
  };
})();
