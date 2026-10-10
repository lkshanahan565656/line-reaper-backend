'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../webhook');

const ALERT = '🐋 B-grade sharp bought Matheus Camilo at 63¢ · 1u at Kalshi: YES Camilo 64¢ <https://kalshi.com/markets/kxufcfight/x>';

test('webhook kind: ntfy, Telegram and Slack by host; anything else gets the Discord format', () => {
  assert.equal(W.webhookKind('https://ntfy.sh/line-reaper-x7q2'), 'ntfy');
  assert.equal(W.webhookKind('https://ntfy.example.com/alerts'), 'ntfy', 'a self-hosted ntfy');
  assert.equal(W.webhookKind('https://api.telegram.org/bot123:abc/sendMessage?chat_id=42'), 'telegram');
  assert.equal(W.webhookKind('https://hooks.slack.com/services/T/B/x'), 'slack');
  assert.equal(W.webhookKind('https://discord.com/api/webhooks/1/abc'), 'discord');
  assert.equal(W.webhookKind('not a url'), null);
});

test('each kind gets the alert in its own format; an ntfy push opens the alert\'s first link', () => {
  const n = W.webhookRequest('https://ntfy.sh/line-reaper-x7q2', ALERT);
  assert.equal(n.url, 'https://ntfy.sh/line-reaper-x7q2');
  assert.equal(n.data, ALERT.replace(/<|>/g, ''), 'plain text, emoji and all, the link unwrapped');
  assert.deepEqual(n.headers, { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Line Reaper', Click: 'https://kalshi.com/markets/kxufcfight/x' });
  assert.equal(W.webhookRequest('https://ntfy.sh/t', 'no link here').headers.Click, undefined);
  assert.equal(W.webhookRequest('https://ntfy.sh/t', 'x', { title: 'Line Reaper ⚡' }).headers.Title, 'Line Reaper', 'headers are ASCII');

  const t = W.webhookRequest('https://api.telegram.org/bot123:abc/sendMessage?chat_id=42', ALERT);
  assert.equal(t.url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.deepEqual(t.data, { chat_id: '42', text: ALERT.replace(/<|>/g, ''), disable_web_page_preview: true });

  assert.deepEqual(W.webhookRequest('https://hooks.slack.com/services/T/B/x', ALERT).data, { text: ALERT });
  assert.deepEqual(W.webhookRequest('https://discord.com/api/webhooks/1/abc', ALERT).data, { username: 'Line Reaper', content: ALERT });
  assert.equal(W.webhookRequest('https://discord.com/api/webhooks/1/abc', 'x'.repeat(5000)).data.content.length, 1900, "Discord's 2,000-character limit");
});

test('createWebhook: every configured hook gets each alert; a failing one is logged and the rest still go', async () => {
  const posts = [], warned = [];
  const post = async (url, data, opts) => { if (url.includes('slack')) throw new Error('410 Gone'); posts.push({ url, data, opts }); };
  const hook = W.createWebhook({ urls: 'https://ntfy.sh/t1, https://hooks.slack.com/services/T/B/x,,nope', post, log: { warn: m => warned.push(m) } });
  assert.equal(hook.enabled, true);
  assert.deepEqual(hook.kinds, ['ntfy', 'slack']);
  assert.equal(await hook.send(ALERT, 'Tail alerts'), 1);
  assert.deepEqual(posts.map(p => [p.url, p.opts.headers.Title, p.opts.timeout]), [['https://ntfy.sh/t1', 'Line Reaper', 10000]]);
  assert.match(warned[0], /^Tail alerts: webhook \(slack\) failed: 410 Gone/);
  assert.deepEqual({ ...hook.stats(), lastAt: null }, { sent: 1, failed: 1, lastError: 'slack: 410 Gone', lastAt: null });
  assert.equal(await hook.send('   '), 0, 'nothing to say: nothing sent');

  const off = W.createWebhook({ urls: '', post });
  assert.equal(off.enabled, false);
  assert.equal(await off.send(ALERT), 0);
});
