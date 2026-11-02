/* Line Reaper widgets: https://line-reaper-backend-production.up.railway.app/developers#widgets */
(function () {
  var base = "https://line-reaper-backend-production.up.railway.app";
  var KINDS = { 'best-price': 220, 'line-move': 330, 'record': 260 };
  var ATTRS = ['league', 'market', 'venue', 'n', 'game', 'side', 'state', 'odds', 'handle'];
  function mount(el) {
    if (el.getAttribute('data-lr-mounted')) return;
    var kind = el.getAttribute('data-line-reaper');
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return;
    el.setAttribute('data-lr-mounted', '1');
    var q = [];
    for (var i = 0; i < ATTRS.length; i++) { var v = el.getAttribute('data-' + ATTRS[i]); if (v) q.push(ATTRS[i] + '=' + encodeURIComponent(v)); }
    var id = 'lr' + Math.random().toString(36).slice(2, 10);
    q.push('_id=' + id);
    var f = document.createElement('iframe');
    f.src = base + '/embed/' + kind + '?' + q.join('&');
    f.title = 'Line Reaper ' + kind.replace('-', ' ');
    f.loading = 'lazy';
    f.setAttribute('data-lr-id', id);
    f.style.cssText = 'display:block;width:100%;max-width:100%;border:0;background:#080b10;color-scheme:dark;height:' + KINDS[kind] + 'px';
    el.appendChild(f);
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== base || !e.data || typeof e.data.lrEmbed !== 'string') return;
    var f = document.querySelector('iframe[data-lr-id="' + e.data.lrEmbed.replace(/[^\w-]/g, '') + '"]');
    var h = Number(e.data.height);
    if (f && h > 40 && h < 4000) f.style.height = h + 'px';
  });
  function all() { var els = document.querySelectorAll('[data-line-reaper]'); for (var i = 0; i < els.length; i++) mount(els[i]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
})();
