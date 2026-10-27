// Accessibility basics for every server-drawn page (the sales page, /learn,
// /pricing, /developers, /leagues, /r, /alerts, /lines, /status, /digest, the
// legal pages): a visible keyboard focus ring, a "Skip to content" link to
// the page's <main>, a screen-reader-only text class, and calm motion for
// viewers whose system asks for reduced motion. The app (/app) carries the
// same rules in its own stylesheet. Pure: decorate(html) returns the page
// with them added, once.
'use strict';

const MARK = 'id="lr-a11y"';

const CSS = `<style ${MARK}>
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
:focus-visible{outline:2px solid #34d399;outline-offset:2px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid #34d399;outline-offset:2px}
main:focus{outline:none}
.lr-skip{position:fixed;top:8px;left:8px;z-index:3000;padding:10px 14px;border-radius:8px;background:#e2e8f0;color:#080b10;font:700 13px system-ui,sans-serif;text-decoration:none;transform:translateY(-200%)}
.lr-skip:focus{transform:none}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
</style>`;

function decorate(html) {
  if (typeof html !== 'string' || html.includes(MARK) || !/<\/head>/i.test(html)) return html;
  let out = html.replace(/<\/head>/i, `${CSS}</head>`);
  // the skip link needs a target: the first <main>, given an id if it has none
  const m = out.match(/<main\b([^>]*)>/i);
  if (m) {
    const id = (m[1].match(/\bid="([^"]+)"/) || [])[1] || 'main';
    if (!/\bid="/.test(m[1])) out = out.replace(m[0], `<main id="main" tabindex="-1"${m[1]}>`);
    else if (!/\btabindex=/.test(m[1])) out = out.replace(m[0], `<main tabindex="-1"${m[1]}>`);
    out = out.replace(/<body\b([^>]*)>/i, b => `${b}<a class="lr-skip" href="#${id}">Skip to content</a>`);
  }
  return out;
}

// express: every text/html page sent as a string gets decorate()
function middleware(skip = () => false) {
  return (req, res, next) => {
    if (req.method !== 'GET' || skip(req)) return next();
    const send = res.send.bind(res);
    res.send = body => {
      if (typeof body === 'string' && /html/i.test(String(res.get('Content-Type') || ''))) body = decorate(body);
      return send(body);
    };
    next();
  };
}

module.exports = { decorate, middleware, CSS };
