// Runs inside the page (added with addInitScript before the app loads).
// window.__e2e lists what a viewer can click, tells whether a click did
// anything, and reads the visible text for broken values.
module.exports = function installE2E() {
  if (window.__e2e) return;
  var noisy = new WeakSet();
  var mode = 'off'; // off | learn (mark what changes on its own) | armed (count changes after a click)
  var changed = 0;
  var lastChange = [];
  var seq = 0;
  function onMut(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'attributes' && (m.attributeName === 'data-e2e-id' || m.oldValue === m.target.getAttribute(m.attributeName))) continue;
      if (m.type === 'characterData' && m.oldValue === m.target.nodeValue) continue;
      var t = m.target.nodeType === 3 ? m.target.parentNode : m.target;
      if (!t) continue;
      if (mode === 'learn') { noisy.add(t); continue; }
      if (mode !== 'armed') continue;
      if (noisy.has(t)) continue;
      changed++;
      if (lastChange.length < 3) lastChange.push((t.id ? '#' + t.id : t.className ? '.' + String(t.className).split(' ')[0] : t.nodeName) + ':' + m.type);
    }
  }
  function observe() {
    new MutationObserver(onMut).observe(document, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
  }
  observe();

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  }
  var CLICKABLE = 'button, a[href], [onclick], [role="button"], [role="tab"], summary, input:not([type="hidden"]), select, textarea, label, th';
  function looksClickable(el) {
    if (el.matches('button, a[href], [onclick], [role="button"], [role="tab"], summary, select, input[type="checkbox"], input[type="radio"], input[type="file"], input[type="button"], input[type="submit"]')) return true;
    if (el.matches('input, textarea')) return false;
    var cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer') return false;
    // a child of something clickable inherits its pointer: only the outer one counts
    var p = el.parentElement;
    return !(p && getComputedStyle(p).cursor === 'pointer');
  }
  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }
  function family(el) {
    var on = el.getAttribute('onclick') || '';
    on = on.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '_').replace(/\b\d+(\.\d+)?\b/g, '#').replace(/\s+/g, '');
    var cls = String(el.className && el.className.baseVal == null ? el.className : '').split(/\s+/).filter(function (c) { return c && !/^(on|active|open|sel|selected|has-active|need|e2e)$/.test(c); }).sort().join('.');
    return el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + '.' + cls + '|' + on.slice(0, 80);
  }
  function label(el) {
    // a text box is named by what it asks for, never by what has been typed in it
    if (el.matches('input, textarea, select')) {
      var lab = el.closest('label') || (el.id ? document.querySelector('label[for="' + el.id + '"]') : null);
      if (!lab) { var fld = el.parentElement; lab = fld && fld.querySelector('label, span, b'); if (lab && lab.contains(el)) lab = null; }
      return norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || (lab ? lab.innerText : '') || el.type).slice(0, 60);
    }
    var t = norm(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || el.name || el.id);
    return t.slice(0, 60);
  }
  // the topmost thing covering the middle of the screen when it is not the
  // page itself: an open modal, menu or drawer
  function overlay() {
    // what sits on top in the middle of the screen; an open modal, menu or
    // drawer is a big fixed box there that is not the tab bar
    var pts = [[0.5, 0.5], [0.5, 0.3], [0.5, 0.7]];
    for (var i = 0; i < pts.length; i++) {
      var el = document.elementFromPoint(innerWidth * pts[i][0], innerHeight * pts[i][1]);
      for (var e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        var cs = getComputedStyle(e);
        if (cs.position !== 'fixed') continue;
        if (e.closest('.nav')) break;
        var r = e.getBoundingClientRect();
        if (r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.4) return e;
      }
    }
    return null;
  }
  // every selector the page's CSS gives a pointer cursor, read once
  var pointerSel = null;
  function pointerSelector() {
    if (pointerSel) return pointerSel;
    var sels = ['[style*="cursor:pointer"]', '[style*="cursor: pointer"]'];
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
      collect(rules, sels);
    }
    pointerSel = sels.filter(function (x) { try { document.querySelector(x); return true; } catch (e) { return false; } }).join(',');
    return pointerSel;
  }
  function collect(rules, sels) {
    for (var j = 0; j < rules.length; j++) {
      var r = rules[j];
      if (r.cssRules && !r.selectorText) { collect(r.cssRules, sels); continue; }
      if (r.style && r.style.cursor === 'pointer' && r.selectorText) r.selectorText.split(',').forEach(function (x) { sels.push(x.replace(/:(hover|focus|active|focus-visible)\b/g, '').trim()); });
    }
  }
  function roots(pageSel) {
    var o = overlay();
    if (o) return { overlay: true, list: [o], name: o.id || o.className };
    var list = [];
    var nav = document.querySelector('.nav');
    if (nav) list.push(nav);
    var pg = document.querySelector(pageSel);
    if (pg) list.push(pg);
    var menu = document.getElementById('moreMenu');
    if (menu && menu.classList.contains('open')) list.push(menu);
    document.querySelectorAll('.os-pop, .tray, .slip-bar, .sb-bar, [id$="Tray"], [id$="Bar"]').forEach(function (e) { if (visible(e) && list.indexOf(e) < 0 && !e.closest('.nav')) list.push(e); });
    return { overlay: false, list: list, name: pageSel };
  }
  function cands(pageSel) {
    var R = roots(pageSel);
    var out = [];
    var seen = new Set();
    R.list.forEach(function (root) {
      var els = root.querySelectorAll(CLICKABLE + ',' + pointerSelector());
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (seen.has(el)) continue;
        if (!looksClickable(el) && !el.matches('input, textarea, select')) continue;
        if (!visible(el)) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        seen.add(el);
        if (!el.hasAttribute('data-e2e-id')) el.setAttribute('data-e2e-id', String(++seq));
        var tag = el.tagName.toLowerCase();
        var kind = tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' || (tag === 'input' && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type)) ? 'text' : tag === 'input' ? el.type : 'click';
        out.push({
          id: el.getAttribute('data-e2e-id'), family: family(el), label: label(el), kind: kind,
          href: tag === 'a' ? el.getAttribute('href') : null, target: tag === 'a' ? el.getAttribute('target') : null,
          onclick: (el.getAttribute('onclick') || '').slice(0, 120), inNav: !!el.closest('.nav'),
          // the current choice: tapping it again may rightly do nothing
          active: /(^|\s)(active|on|sel|selected)(\s|$)/.test(String(el.className && el.className.baseVal == null ? el.className : '')) || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true',
        });
      }
    });
    return { overlay: R.overlay, root: R.name, list: out };
  }
  function state(id) {
    var el = document.querySelector('[data-e2e-id="' + id + '"]');
    return { url: location.href, scroll: Math.round(window.scrollY) + ':' + Math.round((document.scrollingElement || document.body).scrollLeft), checked: el ? !!el.checked : null, value: el && 'value' in el ? String(el.value) : null, open: el && 'open' in el ? !!el.open : null, focus: document.activeElement ? (document.activeElement.getAttribute('data-e2e-id') || document.activeElement.tagName) : '' };
  }
  // visible text with values a viewer should never see
  var BAD = [
    [/\bundefined\b/, 'undefined'], [/\bNaN\b/, 'NaN'], [/\[object Object\]/, '[object Object]'], [/(^|[\s:(=$])null($|[\s,).%])/, 'null'], [/(^|[^\w])-?Infinity\b/, 'Infinity'],
  ];
  function textIssues() {
    var out = [];
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      var s = n.nodeValue;
      if (!s || s.length < 3) continue;
      var p = n.parentElement;
      if (!p || p.closest('script, style, noscript, textarea, code, pre')) continue;
      for (var i = 0; i < BAD.length; i++) {
        if (BAD[i][0].test(s) && visible(p)) {
          var ctx = norm(p.closest('div, td, li, p, section') ? p.closest('div, td, li, p, section').innerText : s).slice(0, 160);
          out.push({ what: BAD[i][1], text: norm(s).slice(0, 120), ctx: ctx, where: where(p) });
        }
      }
    }
    return out;
  }
  function where(el) {
    var pg = el.closest('.page');
    var parts = [];
    for (var e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList[0] ? '.' + e.classList[0] : ''));
    return (pg ? pg.id + ' ' : '') + parts.join('>');
  }
  // "proven" said as a claim, not as "not proven"/"unproven"/"until proven"
  var NEG = /(not|n't|no|never|un|until|before|nothing|none|isn't|aren't|wasn't|yet to be|whether|if|once|only|needs?|to be|ever|anything|until it is|count as|what counts as|read|reads|marks?|call|called|rule|kinds? of play|proven so far|stays?|still|can be|may be|could be)\s*[\w\s,'-]{0,24}$/i;
  function provenClaims() {
    var out = [];
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      var s = n.nodeValue;
      if (!s || !/proven|guaranteed|sure thing|lock of|risk[- ]free/i.test(s)) continue;
      var p = n.parentElement;
      if (!p || p.closest('script, style, noscript') || !visible(p)) continue;
      var full = norm(p.innerText || s);
      var re = /proven|guaranteed|sure thing|lock of|risk[- ]free/ig, m;
      while ((m = re.exec(full))) {
        var before = full.slice(Math.max(0, m.index - 40), m.index);
        if (/^proven$/i.test(m[0]) && NEG.test(before)) continue;
        if (/^guaranteed$/i.test(m[0]) && /(not|no|never|don't|do not)\b[\w\s,'-]{0,30}$/i.test(before)) continue;
        if (/^risk[- ]free$/i.test(m[0]) && /(not|no|never|isn't|aren't)\b[\w\s,'-]{0,30}$/i.test(before)) continue;
        out.push({ word: m[0], text: full.slice(Math.max(0, m.index - 60), m.index + 40), badge: full.length < 30, where: where(p) });
      }
    }
    return out;
  }
  function empties(pageSel) {
    var pg = document.querySelector(pageSel);
    if (!pg) return [];
    var out = [];
    pg.querySelectorAll('.empty-wrap, .empty, .empty-big, .pb-empty, .os-empty, [class*="empty"]').forEach(function (e) {
      if (visible(e) && !e.closest('[class*="empty"]:not(:scope)')) out.push({ text: norm(e.innerText).slice(0, 140), where: where(e) });
    });
    return out;
  }
  // what sticks out past the screen's sides where nothing scrolls it into
  // view: the page itself scrolling sideways, or an element cut off by the
  // body (which hides overflow) or by a card that hides it. Wide tables inside
  // a sideways scroller that itself fits are fine; ellipsis text is meant to clip.
  function overflowIssues() {
    var vw = window.innerWidth, out = [];
    var sw = document.documentElement.scrollWidth;
    if (sw > vw + 1) out.push({ what: 'page scrolls sideways', width: sw, screen: vw });
    var roots = [document.querySelector('header'), document.querySelector('.page.active')];
    document.querySelectorAll('.lay-modal.open > *, .acct-modal.open > *, #moreMenu, #pkTray, #esSlipBar').forEach(function (e) { roots.push(e); });
    var hit = [];
    roots.forEach(function (root) {
      if (!root || !visible(root)) return;
      root.querySelectorAll('*').forEach(function (e) {
        if (out.length > 12) return;
        var r = e.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.textOverflow === 'ellipsis' || cs.position === 'fixed') return;
        for (var i = 0; i < hit.length; i++) if (hit[i].contains(e)) return;
        var clip = null, lim = { left: 0, right: vw };
        for (var p = e.parentElement; p; p = p.parentElement) {
          var ps = getComputedStyle(p);
          if (/auto|scroll/.test(ps.overflowX)) { clip = 'scroll'; lim = p.getBoundingClientRect(); break; }
          if (/hidden|clip/.test(ps.overflowX)) { clip = p === document.body || p === document.documentElement ? 'screen' : 'card'; if (clip === 'card') lim = p.getBoundingClientRect(); break; }
          if (ps.position === 'fixed') { clip = 'screen'; break; }
        }
        var bad = clip === 'scroll' ? (lim.right > vw + 2 || lim.left < -2) && !(r.right <= vw + 1 && r.left >= -1)
          : r.right > Math.min(lim.right, vw) + 2 || r.left < Math.max(lim.left, 0) - 2;
        if (!bad) return;
        // decorative bits (glows, rings) carry no text or control
        if (!norm(e.innerText) && !/^(BUTTON|INPUT|SELECT|A|TEXTAREA|CANVAS|SVG|IMG|TABLE)$/i.test(e.tagName)) return;
        hit.push(e);
        out.push({ what: clip === 'scroll' ? 'scroller wider than the screen' : clip === 'card' ? 'cut off by its card' : 'cut off at the screen edge', where: where(e), text: norm(e.innerText).slice(0, 60), left: Math.round(r.left), right: Math.round(r.right), limit: Math.round(Math.min(lim.right, vw)) });
      });
    });
    return out;
  }
  window.__e2e = {
    overflow: overflowIssues,
    cands: cands, state: state, textIssues: textIssues, provenClaims: provenClaims, empties: empties, overlay: function () { var o = overlay(); return o ? (o.id || String(o.className)) : null; },
    learn: function () { mode = 'learn'; },
    off: function () { mode = 'off'; },
    arm: function () { mode = 'armed'; changed = 0; lastChange = []; },
    changed: function () { return { n: changed, sample: lastChange.slice() }; },
    closeOverlay: function () {
      var o = overlay();
      if (!o) return false;
      o.classList.remove('open', 'show', 'on');
      if (overlay() === o) o.style.display = 'none';
      return true;
    },
  };
};
