// The app script (public/app.js, about 900 KB) compressed once, off the main
// thread, so every visit after boot gets brotli-11 bytes (about a fifth of the
// size) without paying for the compression per request. Until both are ready
// the script goes out as is and the compression middleware handles it.
'use strict';
const zlib = require('zlib');
const { promisify } = require('util');

const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);

function pack(text) {
  const raw = Buffer.from(text, 'utf8');
  const out = { raw, br: null, gz: null };
  out.ready = Promise.all([
    brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }).then(b => { out.br = b; }),
    gzip(raw, { level: 9 }).then(b => { out.gz = b; }),
  ]).catch(e => console.warn('App bundle: compression failed, sending it uncompressed:', e.message));
  return out;
}

// the request's best encoding when its copy is ready: 'br', 'gzip', or null
// (not asked, or still compressing: the middleware then does it on the fly)
function pick(packed, acceptEncoding) {
  const ae = String(acceptEncoding || '');
  if (/\bbr\b/.test(ae)) return packed.br ? 'br' : null;
  if (/\bgzip\b/.test(ae)) return packed.gz ? 'gzip' : null;
  return null;
}

module.exports = { pack, pick };
