// ─── ACCOUNT SYNC: WHAT SYNCS AND HOW TWO COPIES MERGE ───────────────────────
// A signed-in user's bets, slips, favorites, saved views, layout and alert
// choices follow them between devices. The browser's own localStorage stays
// the working copy (and the offline cache); the server keeps one document per
// user with the same keys, and this file decides how the two meet.
//
// Each device remembers a "base": a short hash of every key as it was the last
// time this device and the account agreed. With it a merge is three-way:
//
//   records (MY BETS, MY SLIPS): rows are matched by id. A row only one side
//     has is added to the other, unless the base shows this device had it and
//     deleted it (then the account drops it too, and keeps a tombstone so
//     other devices drop it). A row both sides changed keeps this device's.
//   map (slip grades): the server's own answers per leg; the two are unioned.
//   value (everything else, one setting each): whichever side changed since
//     the base wins. If both changed, or this is the first sign-in on this
//     device and the two differ, it is a CONFLICT: this device keeps its own
//     copy and nothing is sent until the user picks KEEP THIS DEVICE or USE
//     ACCOUNT.
//
// The first sign-in on a device has no base, so nothing counts as deleted:
// both sides' rows are kept (a union) and differing settings are conflicts.
//
// Pure functions, no I/O. The same file runs in Node (the server validates
// uploads with it; tests) and in the browser (served at /acctsync.js as
// window.LRSync).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRSync = factory();
}(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // localStorage key → what it is. Only these keys ever leave the browser.
  // Device-only things stay out: the login token, the last tab, browser
  // notification toggles (each browser asks its own permission), the slip tray.
  /** @type {Record<string, { kind: 'records'|'map'|'value', label: string, max: number }>} */
  const KEYS = {
    lr_bets: { kind: 'records', label: 'My bets', max: 3e6 },
    lr_slips: { kind: 'records', label: 'My slips', max: 3e6 },
    lr_slip_grades: { kind: 'map', label: 'Slip grades', max: 2e6 },
    lr_pikkit: { kind: 'value', label: 'Pikkit import', max: 2e6 },
    lr_shopper: { kind: 'value', label: 'Shopper filters and favorites', max: 2e4 },
    lr_shopper_views: { kind: 'value', label: 'Saved shopper views', max: 1e5 },
    lr_os: { kind: 'value', label: 'Odds screen filters', max: 2e4 },
    lr_mybooks: { kind: 'value', label: 'My books', max: 1e4 },
    lr_layout: { kind: 'value', label: 'Tab layout', max: 2e4 },
    lr_push_kinds: { kind: 'value', label: 'Alert kinds', max: 2e3 },
    lr_unit_usd: { kind: 'value', label: 'Unit size', max: 50 },
    lr_bankroll: { kind: 'value', label: 'Bankroll', max: 50 },
    lr_tail_day_units: { kind: 'value', label: 'Daily unit cap', max: 50 },
  };
  const KEY_LIST = Object.keys(KEYS);
  const TOTAL_MAX = 8e6;          // one account's whole document
  const TOMB_MAX = 3000;          // deleted ids kept per key
  const ID_MAX = 200;

  // FNV-1a over the string, with its length: short, stable, enough to tell
  // "changed" from "the same" for one user's data
  function hash(s) {
    if (s == null) return null;
    s = String(s);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${s.length.toString(36)}.${h.toString(36)}`;
  }

  const hasId = r => typeof r.id === 'string' && r.id.length > 0 && r.id.length <= ID_MAX;
  const parseArr = s => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter(r => r && typeof r === 'object') : null; } catch { return null; } };
  const parseObj = s => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

  // what a base remembers about one key's value
  function baseOf(key, s) {
    if (s == null) return { h: null };
    if (KEYS[key]?.kind === 'records') {
      const ids = {};
      for (const r of parseArr(s) || []) if (hasId(r)) ids[r.id] = hash(JSON.stringify(r));
      return { h: hash(s), ids };
    }
    return { h: hash(s) };
  }

  // records: three-way by id → { out: rows, dead: ids this device deleted }
  function mergeRecords(lStr, sStr, base, tomb, first) {
    // a row without an id can't be matched: this device keeps its own as they are
    const L = parseArr(lStr) || [], S = (parseArr(sStr) || []).filter(hasId);
    const B = first ? null : (base && base.ids) || null;
    const T = tomb || {};
    const sBy = new Map(S.map(r => [r.id, r]));
    const lIds = new Set(L.map(r => r.id));
    const out = [], dead = [];
    for (const r of L) {
      if (!hasId(r)) { out.push(r); continue; }
      const hl = hash(JSON.stringify(r));
      const s = sBy.get(r.id);
      if (s) {
        const hs = hash(JSON.stringify(s));
        // only the account's copy moved since we last agreed: take it
        out.push(hl !== hs && B && B[r.id] === hl ? s : r);
      } else if (T[r.id] && B && B[r.id] === hl) {
        // another device deleted it and this one never touched it since
      } else out.push(r);
    }
    for (const s of S) {
      if (lIds.has(s.id)) continue;
      if (B && B[s.id]) dead.push(s.id);   // this device had it and deleted it
      else out.push(s);
    }
    return { out, dead };
  }

  function mergeMap(lStr, sStr) {
    const L = parseObj(lStr) || {}, S = parseObj(sStr) || {};
    return { ...S, ...L };
  }

  // One sync. local: { key: string|null } read from localStorage; server: the
  // account document { rev, keys: { key: { v, at } }, tomb: { key: { id: at } } };
  // base: this device's { key: baseOf(...) } (empty on its first sign-in);
  // resolved: { key: 'local'|'account' } the user's answers to conflicts.
  // → { apply: write these to localStorage, push: send these to the account,
  //     tomb: deleted ids to send, base: the base once both sides hold the
  //     result, conflicts: keys still waiting on the user }
  /** @param {{ local?: Record<string, string|null>, server?: { rev?: number, keys?: Record<string, { v: string|null, at?: string }>, tomb?: Record<string, Record<string, string>> }, base?: Record<string, any>, resolved?: Record<string, string>, now?: number }} [opts] */
  function merge({ local = {}, server = {}, base = {}, resolved = {}, now = Date.now() } = {}) {
    const sk = server.keys || {}, st = server.tomb || {};
    const first = !base || !Object.keys(base).length;
    const apply = {}, push = {}, tomb = {}, nextBase = {}, conflicts = [];
    const at = new Date(now).toISOString();
    for (const key of KEY_LIST) {
      const spec = KEYS[key];
      const l = local[key] == null ? null : String(local[key]);
      const s = sk[key] && sk[key].v != null ? String(sk[key].v) : null;
      const b = base && base[key];
      let result;
      if (spec.kind === 'records') {
        if (l == null && s == null) continue;
        const { out, dead } = mergeRecords(l, s, b, st[key], first);
        result = JSON.stringify(out);
        if (dead.length) tomb[key] = Object.fromEntries(dead.map(id => [id, at]));
        // nothing changed for anyone: keep both strings exactly as they are
        if (l != null && sameRows(out, l)) result = l;
        else if (s != null && sameRows(out, s)) result = s;
      } else if (spec.kind === 'map') {
        if (l == null && s == null) continue;
        const m = mergeMap(l, s);
        result = l != null && sameObj(m, l) ? l : s != null && sameObj(m, s) ? s : JSON.stringify(m);
      } else {
        if (l === s) { if (l != null) nextBase[key] = baseOf(key, l); continue; }
        const hb = b ? b.h : undefined;   // undefined: the two never agreed on this key
        const lChanged = hb === undefined || hash(l) !== hb;
        const sChanged = hb === undefined || hash(s) !== hb;
        if (resolved[key] === 'local') result = l;
        else if (resolved[key] === 'account') result = s;
        else if (s == null && hb === undefined) result = l;       // the account never had it
        else if (l == null && hb === undefined) result = s;       // this device never had it
        else if (lChanged && !sChanged) result = l;
        else if (!lChanged && sChanged) result = s;
        else if (l == null) result = s;                           // deleted here, edited there: keep the edit
        else if (s == null) result = l;
        else {
          // both moved: this device keeps its copy, nothing sent, base unchanged
          conflicts.push(key);
          if (b) nextBase[key] = b;
          continue;
        }
      }
      if (result !== l) apply[key] = result;
      if (result !== s) push[key] = result;
      if (result != null || s != null) nextBase[key] = baseOf(key, result);
    }
    return { apply, push, tomb, base: nextBase, conflicts };
  }

  function sameRows(rows, str) {
    const a = parseArr(str);
    if (!a || a.length !== rows.length) return false;
    for (let i = 0; i < rows.length; i++) if (JSON.stringify(rows[i]) !== JSON.stringify(a[i])) return false;
    return true;
  }
  function sameObj(obj, str) {
    const o = parseObj(str);
    if (!o) return false;
    const ka = Object.keys(obj), kb = Object.keys(o);
    if (ka.length !== kb.length) return false;
    return ka.every(k => JSON.stringify(obj[k]) === JSON.stringify(o[k]));
  }

  // An upload from a browser, checked before it touches the account →
  // { ok: true } or { ok: false, error }. keys: { key: string|null };
  // tomb: { key: { id: iso } }.
  function validateUpload(keys, tomb) {
    if (keys != null && (typeof keys !== 'object' || Array.isArray(keys))) return { ok: false, error: 'keys must be an object' };
    for (const [k, v] of Object.entries(keys || {})) {
      const spec = KEYS[k];
      if (!spec) return { ok: false, error: `${k} is not something that syncs` };
      if (v === null) continue;
      if (typeof v !== 'string') return { ok: false, error: `${k} must be text` };
      if (v.length > spec.max) return { ok: false, error: `${spec.label} is too large to sync` };
      if (spec.kind === 'records' && !parseArr(v)) return { ok: false, error: `${spec.label} is not a list` };
      if (spec.kind === 'map' && !parseObj(v)) return { ok: false, error: `${spec.label} is not readable` };
    }
    if (tomb != null && (typeof tomb !== 'object' || Array.isArray(tomb))) return { ok: false, error: 'tomb must be an object' };
    for (const [k, ids] of Object.entries(tomb || {})) {
      if (KEYS[k]?.kind !== 'records') return { ok: false, error: `${k} has no deletions` };
      if (!ids || typeof ids !== 'object' || Object.keys(ids).length > TOMB_MAX) return { ok: false, error: 'too many deletions at once' };
      for (const id of Object.keys(ids)) if (id.length > ID_MAX) return { ok: false, error: 'id too long' };
    }
    return { ok: true };
  }

  // the account document after an upload; keeps the newest TOMB_MAX tombstones
  // per key and drops a tombstone whose row came back
  function applyUpload(doc, { keys = {}, tomb = {} }, now = Date.now()) {
    const at = new Date(now).toISOString();
    const next = { ...doc, keys: { ...(doc.keys || {}) }, tomb: { ...(doc.tomb || {}) } };
    for (const [k, v] of Object.entries(keys || {})) next.keys[k] = { v, at };
    for (const [k, ids] of Object.entries(tomb || {})) next.tomb[k] = { ...(next.tomb[k] || {}), ...ids };
    for (const k of Object.keys(next.tomb)) {
      const live = new Set((parseArr(next.keys[k]?.v) || []).filter(hasId).map(r => r.id));
      const kept = Object.entries(next.tomb[k]).filter(([id]) => !live.has(id)).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, TOMB_MAX);
      next.tomb[k] = Object.fromEntries(kept);
    }
    next.rev = (doc.rev || 0) + 1;
    next.updatedAt = at;
    return next;
  }

  const sizeOf = doc => Object.values(doc.keys || {}).reduce((n, e) => n + (e && e.v ? e.v.length : 0), 0);

  return { KEYS, KEY_LIST, TOTAL_MAX, TOMB_MAX, hash, baseOf, merge, mergeRecords, validateUpload, applyUpload, sizeOf };
}));
