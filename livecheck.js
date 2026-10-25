// ─── LIVE CHECK: the browser smoke test's last result, in /api/ops ──────────
// After a deploy, a GitHub Actions job (e2e/smoke.js on the diag-e2e-smoke
// branch) opens the live app in a real browser, clicks through every tab and
// writes what it found to the diag-e2e-smoke-out branch. It then asks this
// server to read that file (POST /api/ops/smoke). The server reads it from
// GitHub itself, so no secret is needed and nobody can post a result here:
// the only thing a caller can do is make us re-read the repo's file, at most
// once every 30 seconds.

function createLiveCheck(axios, { url, now = () => Date.now(), minGapMs = 30e3 } = {}) {
  const state = { url, last: null, readAt: null, error: null };
  let lastRead = 0, inFlight = null;

  // only what /api/ops needs: the verdict, counts and the first failures
  function trim(r) {
    if (!r || typeof r !== 'object') throw new Error('not a smoke result');
    const fails = Array.isArray(r.failures) ? r.failures : [];
    return {
      ok: !!r.ok, at: String(r.at || ''), version: r.version ? String(r.version) : null, want: r.want ? String(r.want) : null,
      run: r.run ? String(r.run) : null, clicks: Number(r.clicks) || 0, tabs: Number(r.tabs) || 0, ms: Number(r.ms) || 0,
      failures: fails.length, warnings: Number(r.warnings) || 0,
      first: fails.slice(0, 10).map(f => String(f.summary || f.what || '').slice(0, 200)),
    };
  }

  async function refresh() {
    if (!url) { state.error = 'no URL'; return state; }
    if (inFlight) return inFlight;
    if (now() - lastRead < minGapMs) return state;
    lastRead = now();
    inFlight = (async () => {
      try {
        const r = await axios.get(url, { timeout: 15000, params: { t: now() } });
        state.last = trim(typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
        state.readAt = new Date(now()).toISOString();
        state.error = null;
      } catch (e) { state.error = String(e.message || e).slice(0, 200); }
      inFlight = null;
      return state;
    })();
    return inFlight;
  }

  return { state, refresh, trim };
}

module.exports = { createLiveCheck };
