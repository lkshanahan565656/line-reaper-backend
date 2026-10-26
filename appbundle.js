// Page speed for /app on a phone (scripts/pagespeed.js measures it).
//  - The app's big inline script moves to /assets/app.<hash>.js: the same
//    code, run at the same spot in the page, but cached by the browser for a
//    year under a name that changes whenever the code does.
//  - The page and that script are compressed once at boot (brotli, gzip, off
//    the main thread so the boot never stalls; /app is sent as before until
//    that is done) and sent in whichever form the browser accepts, with an ETag so a revisit to
//    an unchanged page is a 304.
//  - compress() gzips or brotli-compresses every other answer (the API's
//    JSON), except event streams, which have to arrive as they are written.
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);

// the script must be at least this big to move out (the venue-link one stays inline)
const MIN_SPLIT = 50e3;

async function packed(body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const [br, gz] = await Promise.all([
    brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }),
    gzip(buf, { level: 9 }),
  ]);
  return { type, raw: buf, hash, etag: `"${hash.slice(0, 27)}"`, br, gz };
}

// html: the app page as server.js serves it. Returns the page with the big
// script swapped for a <script src>, and the assets by URL path.
async function build(html) {
  const assets = new Map();
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m, big = null;
  while ((m = re.exec(html))) if (m[1].length >= MIN_SPLIT && (!big || m[1].length > big[1].length)) big = m;
  let page = html;
  if (big) {
    const js = await packed(big[1], 'application/javascript; charset=utf-8');
    const url = `/assets/app.${js.hash.slice(0, 16)}.js`;
    assets.set(url, js);
    page = html.slice(0, big.index) + `<script src="${url}"></script>` + html.slice(big.index + big[0].length);
  }
  return { page: await packed(page, 'text/html; charset=utf-8'), assets };
}

// send one packed file: brotli, gzip or as it is, by Accept-Encoding
function send(req, res, f, cacheControl) {
  res.set({ 'Cache-Control': cacheControl, 'Content-Type': f.type, ETag: f.etag, Vary: 'Accept-Encoding' });
  if (req.fresh) return res.status(304).end();
  // brotli whenever the browser takes it (smaller), whatever order it lists them in
  const enc = req.acceptsEncodings('br') ? 'br' : req.acceptsEncodings('gzip') ? 'gzip' : 'identity';
  const body = enc === 'br' ? f.br : enc === 'gzip' ? f.gz : f.raw;
  if (enc === 'br' || enc === 'gzip') res.set('Content-Encoding', enc);
  res.set('Content-Length', String(body.length));
  return req.method === 'HEAD' ? res.end() : res.end(body);
}

// compression for everything else; event streams pass through untouched
function compress() {
  const compression = require('compression');
  return compression({
    threshold: 1024,
    filter: (req, res) => {
      const type = String(res.getHeader('Content-Type') || '');
      if (/text\/event-stream/i.test(type) || /text\/event-stream/i.test(req.get('accept') || '')) return false;
      return compression.filter(req, res);
    },
  });
}

module.exports = { build, send, compress, packed, MIN_SPLIT };
