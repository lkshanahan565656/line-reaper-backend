// ─── MEMORY GUARD: restart on our own terms before memory runs away ─────────
// Railway bills memory and CPU by the minute. On 10-27/28 the server sat at a
// 1.8 GB heap and 2.5 GB RSS for hours, with garbage collection eating 20% of
// the CPU, until V8 ran out of heap and crashed. A crash also loses every
// record row since the last results backup (pulled every 20 minutes).
//
// The start script caps the heap (package.json: --max-old-space-size). This
// guard watches heap and RSS every 30 s:
//   soft   over the soft line for 10 minutes straight: wait for the next
//          backup pull (so no record row is lost), put pending store writes
//          on disk, exit 1. Railway's restart policy brings it back fresh.
//          If no pull comes within 25 minutes, it restarts anyway.
//   hard   heap at the hard line twice in a row (a minute): flush and exit 1
//          now, before V8 crashes mid-write. Not in the first 10 minutes,
//          while the boot restore peaks.
// Back under 90% of the soft line cancels a pending soft restart.
//
// On by default on Railway only (a laptop or the desktop app has nothing to
// restart it). Settings (all optional): MEM_GUARD=off|on; MEM_SOFT_MB,
// MEM_HARD_MB (heap); MEM_RSS_SOFT_MB. Defaults come from V8's heap cap.
'use strict';
const v8 = require('v8');

const MB = 1048576;
const offWord = v => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const onWord = v => /^(on|1|true|yes)$/i.test(String(v ?? '').trim());
const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

function limitsFromEnv(env = process.env, heapLimitMb = v8.getHeapStatistics().heap_size_limit / MB) {
  const cap = Math.round(heapLimitMb);
  const softMb = num(env.MEM_SOFT_MB) || Math.round(cap * 0.85);
  const hardMb = num(env.MEM_HARD_MB) || Math.round(cap * 0.96);
  const rssSoftMb = num(env.MEM_RSS_SOFT_MB) || cap + 512;
  const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID) && !env.LR_DESKTOP;
  return { on: onWord(env.MEM_GUARD) || (!offWord(env.MEM_GUARD) && onRailway), capMb: cap, softMb, hardMb: Math.max(hardMb, softMb), rssSoftMb };
}

function createMemGuard({
  limits = limitsFromEnv(),
  usage = () => process.memoryUsage(),
  lastBackupAt = () => null,       // ISO time of the last results backup export
  flush = async () => {},          // put pending store writes on disk
  exit = code => process.exit(code),
  now = () => Date.now(),
  sampleMs = 30e3, sustainMs = 10 * 60e3, backupWaitMs = 25 * 60e3, bootGraceMs = 10 * 60e3, flushMs = 8000,
  log = console,
} = {}) {
  const t0 = now();
  const state = { on: limits.on, ...limits, heapMb: null, rssMb: null, peakHeapMb: 0, peakRssMb: 0,
    overSince: null, pendingSince: null, hardHits: 0, exiting: null, checks: 0 };
  let timer = null;

  async function leave(reason) {
    if (state.exiting) return;
    state.exiting = { reason, at: new Date(now()).toISOString() };
    log.warn?.(`Memory guard: restarting (${reason}); heap ${state.heapMb} MB, RSS ${state.rssMb} MB`);
    let done = false;
    await Promise.race([
      Promise.resolve().then(flush).catch(e => log.warn?.(`Memory guard: flush failed: ${e.message}`)).then(() => { done = true; }),
      new Promise(r => setTimeout(r, flushMs).unref?.()),
    ]);
    if (!done) log.warn?.('Memory guard: flush still running, exiting anyway');
    exit(1);
  }

  function check() {
    if (!state.on || state.exiting) return null;
    const m = usage(), t = now();
    state.checks++;
    state.heapMb = Math.round(m.heapUsed / MB);
    state.rssMb = Math.round(m.rss / MB);
    state.peakHeapMb = Math.max(state.peakHeapMb, state.heapMb);
    state.peakRssMb = Math.max(state.peakRssMb, state.rssMb);
    const booting = t - t0 < bootGraceMs;

    if (!booting && state.heapMb >= state.hardMb) {
      if (++state.hardHits >= 2) { leave(`heap at the hard line ${state.hardMb} MB`); return 'hard'; }
    } else state.hardHits = 0;

    const over = state.heapMb >= state.softMb || state.rssMb >= state.rssSoftMb;
    const wellUnder = state.heapMb < state.softMb * 0.9 && state.rssMb < state.rssSoftMb * 0.9;
    if (over) state.overSince ??= t;
    else if (wellUnder) { state.overSince = null; state.pendingSince = null; }

    if (!state.pendingSince && state.overSince != null && t - state.overSince >= sustainMs) {
      state.pendingSince = t;
      log.warn?.(`Memory guard: over the soft line for ${Math.round((t - state.overSince) / 60e3)} min; restarting after the next results backup`);
    }
    if (state.pendingSince) {
      const b = Date.parse(lastBackupAt() || '');
      if (Number.isFinite(b) && b >= state.pendingSince) { leave('over the soft line; restarted right after a results backup'); return 'soft'; }
      if (t - state.pendingSince >= backupWaitMs) { leave(`over the soft line; no results backup in ${Math.round(backupWaitMs / 60e3)} min`); return 'soft'; }
    }
    return null;
  }

  function start() {
    if (timer || !state.on) return;
    check();
    timer = setInterval(check, sampleMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  function status() {
    const iso = x => (x != null ? new Date(x).toISOString() : null);
    return { on: state.on, capMb: state.capMb, softMb: state.softMb, hardMb: state.hardMb, rssSoftMb: state.rssSoftMb,
      heapMb: state.heapMb, rssMb: state.rssMb, peakHeapMb: state.peakHeapMb, peakRssMb: state.peakRssMb,
      overSince: iso(state.overSince), restartPendingSince: iso(state.pendingSince), exiting: state.exiting };
  }

  return { start, stop, check, status };
}

module.exports = { createMemGuard, limitsFromEnv };
