import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, formatUsd } from '../src/dashboard.mjs';

const SECTION_ORDER = ['outcomes', 'review', 'autonomy', 'gates', 'cost', 'runs'];
const LEAKED_WORDS = /\b(NaN|undefined|null|Infinity)\b/;

const FULL = {
  generatedAt: '2026-10-18T02:30:00.000Z',
  window: { from: '2026-10-11T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' },
  outcomes: {
    runs: 24, accepted: 18, released: 15, acceptedRate: 0.75, firstPassRate: 0.5, changeFailureRate: 0.0667,
    escapedDefects: 1, medianLeadTimeMinutes: 42.5, humanMinutesPerChange: 6.2, overfitGapPts: 4,
  },
  cost: {
    totalUsd: 3.84, failedUsd: 0.92, perAcceptedChangeUsd: 0.21, failedShare: 0.2396,
    byRole: { builder: 2.9, planner: 0.31, reviewer: 0.63 }, unknownCostRuns: 0,
  },
  review: { wip: 2, wipLimit: 5, oldestWaitingMinutes: 37 },
  autonomy: [
    { class: 'docs', tier: 2, earnedTier: 2, cleanStreak: 9 },
    { class: 'feature', tier: 1, earnedTier: 0, cleanStreak: 1 },
  ],
  gates: [
    { id: 'integrity', evaluated: 30, failedFirst: 1, notEarned: 0, avgMs: 41 },
    { id: 'profile-checks', evaluated: 29, failedFirst: 7, notEarned: 0, avgMs: 5310 },
    { id: 'holdout', evaluated: 20, failedFirst: 3, notEarned: 2, avgMs: 9120 },
  ],
  runs: [
    {
      id: 'run-20261017091500-a1b2c3', task: 'slugify handles unicode', state: 'released', attempts: 1,
      costUsd: 0.0012, changeClass: 'feature', startedAt: '2026-10-17T09:15:00.000Z',
    },
    {
      id: 'run-20261017101500-d4e5f6', task: 'fix date parsing', state: 'needs-human', attempts: 3,
      costUsd: 0.42, changeClass: 'bugfix', startedAt: '2026-10-17T10:15:00.000Z',
    },
  ],
};

// The document without its <style> block, so CSS selectors and properties don't count as rendered markup.
function markup(doc) {
  const stripped = doc.replace(/<style>[\s\S]*?<\/style>/, '');
  assert.notEqual(stripped, doc, 'style block found');
  return stripped;
}

// The opening tag of the element carrying data-metric="<metric>".
function openingTag(doc, metric) {
  const match = doc.match(new RegExp(`<[a-z]+[^>]*\\sdata-metric="${metric}"[^>]*>`));
  assert.ok(match, `no element with data-metric="${metric}"`);
  return match[0];
}

// The whole <article> of an outcome tile.
function tileHtml(doc, metric) {
  const match = doc.match(new RegExp(`<article[^>]*\\sdata-metric="${metric}"[^>]*>[\\s\\S]*?</article>`));
  assert.ok(match, `no tile with data-metric="${metric}"`);
  return match[0];
}

function assertNoLeakedWords(doc, label) {
  const leaked = doc.match(LEAKED_WORDS);
  assert.equal(leaked, null, `${label}: rendered "${leaked?.[0]}" near …${leaked ? doc.slice(Math.max(0, leaked.index - 80), leaked.index + 40) : ''}…`);
}

test('[P6.4] renders a complete self-contained HTML document as a plain string', () => {
  const doc = renderDashboard(FULL);
  assert.equal(typeof doc, 'string');
  assert.match(doc, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">/);
  assert.match(doc, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(doc, /<title>Factory dashboard<\/title>/);
  assert.match(doc, /<h1>Factory dashboard<\/h1>/);
  assert.match(doc, /<time datetime="2026-10-18T02:30:00.000Z">2026-10-18 02:30 UTC<\/time>/, 'generatedAt shown');
  assert.match(doc, /2026-10-11 00:00 UTC<\/time> → <time[^>]*>2026-10-18 00:00 UTC/, 'window shown');
  assert.match(doc, /<\/html>\n$/);
});

test('[P6.4] outcomes and stability come before activity: section order is fixed', () => {
  for (const [label, metrics] of [['full', FULL], ['empty', {}]]) {
    const doc = renderDashboard(metrics);
    const positions = [doc.indexOf('<h1>Factory dashboard</h1>'), ...SECTION_ORDER.map((id) => doc.indexOf(`data-section="${id}"`))];
    for (const [i, pos] of positions.entries()) assert.ok(pos >= 0, `${label}: section ${i} missing`);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i - 1] < positions[i], `${label}: section ${i} rendered out of order`);
    }
  }
  const doc = renderDashboard(FULL);
  const outcomes = doc.indexOf('data-metric="accepted-rate"');
  const firstRun = doc.indexOf('run-20261017091500-a1b2c3');
  assert.ok(outcomes >= 0 && firstRun >= 0, 'outcome tile and run row both rendered');
  assert.ok(outcomes < firstRun, 'outcome tiles precede the runs table');
  assert.ok(doc.indexOf('<table class="runs-table">') > doc.indexOf('data-metric="overfit-gap"'), 'runs table after the last tile');
});

test('[P6.4] an empty metrics object renders without NaN, undefined or null text', () => {
  for (const [label, metrics] of [['{}', {}], ['no argument', undefined], ['null', null]]) {
    const doc = renderDashboard(metrics);
    assertNoLeakedWords(doc, label);
    for (const word of ['NaN', 'undefined', 'null']) assert.ok(!doc.includes(word), `${label}: contains "${word}"`);
    assert.ok(doc.includes('—'), `${label}: missing values render as a dash`);
    assert.equal(tileHtml(doc, 'accepted-rate').match(/<p class="tile-value">([^<]*)<\/p>/)[1], '—');
    assert.match(doc, /No runs in this window\./, `${label}: empty runs state`);
  }
});

test('[P6.4] degenerate values (nulls, zeros, non-finite numbers, bad dates, wrong types) never leak or break bars', () => {
  const degenerate = {
    generatedAt: 'not a date',
    window: { from: null, to: '2026-99-99T99:99:00Z' },
    outcomes: {
      runs: 0, accepted: 0, released: 0, acceptedRate: null, firstPassRate: NaN, changeFailureRate: undefined,
      escapedDefects: Infinity, medianLeadTimeMinutes: -Infinity, humanMinutesPerChange: 'abc', overfitGapPts: null,
    },
    cost: {
      totalUsd: 0, failedUsd: null, perAcceptedChangeUsd: NaN, failedShare: null,
      byRole: { builder: 0, planner: null, reviewer: NaN, '': 1, refund: -2 }, unknownCostRuns: null,
    },
    review: { wip: 0, wipLimit: 0, oldestWaitingMinutes: null },
    autonomy: [null, 42, { class: null, tier: undefined, earnedTier: NaN, cleanStreak: null }],
    gates: [
      { id: null, evaluated: 0, failedFirst: 0, notEarned: null, avgMs: NaN },
      { id: 'zero', evaluated: 0, failedFirst: null, notEarned: 0, avgMs: 0 },
    ],
    runs: [{ id: null, task: undefined, state: null, attempts: NaN, costUsd: null, changeClass: undefined, startedAt: 'yesterday' }, null],
  };
  const wrongTypes = {
    generatedAt: 12, window: 'last week', outcomes: [], cost: { byRole: [1, 2] }, review: 'x',
    autonomy: { class: 'docs' }, gates: {}, runs: 'oops',
  };
  for (const [label, metrics] of [['degenerate', degenerate], ['wrong types', wrongTypes]]) {
    const doc = renderDashboard(metrics);
    assertNoLeakedWords(doc, label);
    const styles = [...markup(doc).matchAll(/style="([^"]*)"/g)].map((match) => match[1]);
    assert.ok(styles.length > 0 || label === 'wrong types', `${label}: bars rendered`);
    for (const style of styles) {
      const width = style.match(/^width:([^%]*)%$/);
      assert.ok(width, `${label}: unexpected inline style "${style}"`);
      const value = Number(width[1]);
      assert.ok(width[1] !== '' && Number.isFinite(value) && value >= 0 && value <= 100, `${label}: bad bar width "${width[1]}"`);
    }
  }
  const doc = renderDashboard(degenerate);
  assert.match(doc, /<dd>not a date<\/dd>/, 'unparseable timestamps are shown as given');
  assert.match(doc, /<td class="mono">yesterday<\/td>/);
});

test('[P6.4] zero is a value, not a missing one; rates render as percentages', () => {
  const doc = renderDashboard({
    outcomes: { acceptedRate: 0, firstPassRate: 0.8333, changeFailureRate: 0, escapedDefects: 0 },
    cost: { perAcceptedChangeUsd: 0 },
    review: { wip: 0, wipLimit: 3 },
  });
  assert.match(tileHtml(doc, 'accepted-rate'), /<p class="tile-value">0\.0%<\/p>/);
  assert.match(tileHtml(doc, 'first-pass-rate'), /<p class="tile-value">83\.3%<\/p>/);
  assert.match(tileHtml(doc, 'change-failure-rate'), /<p class="tile-value">0\.0%<\/p>/);
  assert.match(tileHtml(doc, 'escaped-defects'), /<p class="tile-value">0<\/p>/);
  assert.match(tileHtml(doc, 'cost-per-accepted-change'), /<p class="tile-value">\$0\.00<\/p>/);
  assert.match(doc, /<span class="capacity-wip">0<\/span><span class="capacity-limit">\/ 3<\/span>/);
});

test('[P6.4] a task name containing <script> is escaped', () => {
  const doc = renderDashboard({ runs: [{ id: 'r1', task: '<script>alert("x")</script>', state: 'released' }] });
  assert.ok(!/<script/i.test(doc), 'no raw script tag');
  assert.ok(doc.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'escaped task name is shown');
});

test('[P6.4] every user- or agent-supplied string is escaped, in text and in attributes', () => {
  const evil = '<script>alert(1)</script>';
  const breakout = '"><img src=x onerror=alert(1)>';
  const doc = renderDashboard({
    generatedAt: evil,
    window: { from: breakout, to: evil },
    cost: { byRole: { [evil]: 1, [breakout]: 2 } },
    autonomy: [{ class: evil, tier: breakout, earnedTier: evil, cleanStreak: 1 }],
    gates: [{ id: breakout, evaluated: 1, failedFirst: 1, notEarned: 1, avgMs: 1 }],
    runs: [{ id: breakout, task: evil, state: `failed ${breakout}`, attempts: 1, costUsd: 0.1, changeClass: evil, startedAt: breakout }],
  });
  assert.ok(!/<script/i.test(doc), 'no raw script tag');
  assert.ok(!/<img/i.test(doc), 'no attribute breakout into an img tag');
  assert.ok(doc.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(doc.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(doc, /<span class="pill pill-bad">failed &quot;&gt;&lt;img/, 'state class comes from a fixed list');
});

test('[P6.4] run states map to a fixed set of tones, matched at word starts', () => {
  const cases = {
    released: 'good', accepted: 'good', approved: 'good', abandoned: 'bad', failed: 'bad', gate_failed: 'bad',
    'rolled-back': 'bad', 'timed-out': 'bad', 'needs-human': 'warn', 'awaiting-approval': 'warn', 'NOT-EARNED': 'warn',
    running: 'info', 'in-progress': 'info', 'emergency-fix': 'neutral', bypassed: 'neutral', mystery: 'neutral',
  };
  const doc = renderDashboard({ runs: Object.keys(cases).map((state, i) => ({ id: `r${i}`, task: 't', state })) });
  for (const [state, tone] of Object.entries(cases)) {
    assert.ok(doc.includes(`<span class="pill pill-${tone}">${state}</span>`), `${state} → ${tone}`);
  }
});

test('[P6.4] loads no external resources: no http(s) URLs, scripts, links, imports or fonts', () => {
  for (const metrics of [FULL, {}]) {
    const doc = renderDashboard(metrics);
    assert.ok(!doc.includes('http://'), 'no http:// reference');
    assert.ok(!doc.includes('https://'), 'no https:// reference');
    assert.doesNotMatch(doc, /<(script|link|img|iframe|object|embed|audio|video|source|svg)\b/i);
    assert.doesNotMatch(doc, /\s(src|href|srcset|action|poster|xmlns)\s*=/i);
    assert.doesNotMatch(doc, /url\s*\(|@import|@font-face/i);
    assert.match(doc, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';/);
  }
});

test('[P6.4] bad signals are highlighted: change-failure rate > 15%, overfit gap > 10 pts, failed spend > 50%', () => {
  const bad = renderDashboard({
    outcomes: { changeFailureRate: 0.2, overfitGapPts: 12.5, acceptedRate: 0.1 },
    cost: { failedShare: 0.6 },
  });
  for (const metric of ['change-failure-rate', 'overfit-gap', 'failed-spend-share']) {
    assert.match(openingTag(bad, metric), /data-signal="bad"/, `${metric} flagged`);
    assert.match(tileHtml(bad, metric), /above the [^<]* limit/, `${metric} says why, not only by colour`);
  }
  assert.doesNotMatch(openingTag(bad, 'accepted-rate'), /data-signal/, 'tiles without a threshold carry no signal');
  assert.match(bad, /\.tile\[data-signal="bad"\] \{[^}]*var\(--rose\)/, 'bad tiles are styled rose');

  const edge = renderDashboard({ outcomes: { changeFailureRate: 0.15, overfitGapPts: 10 }, cost: { failedShare: 0.5 } });
  assert.doesNotMatch(markup(edge), /data-signal="bad"/, 'values exactly at the limit are not flagged');
  for (const metric of ['change-failure-rate', 'overfit-gap', 'failed-spend-share']) {
    assert.match(openingTag(edge, metric), /data-signal="ok"/);
  }
  assert.doesNotMatch(markup(renderDashboard(FULL)), /data-signal="bad"/, 'healthy fixture has no bad signal');
});

test('[P6.4] review capacity is highlighted when WIP reaches the limit', () => {
  for (const review of [{ wip: 5, wipLimit: 5 }, { wip: 7, wipLimit: 5 }]) {
    const doc = renderDashboard({ review });
    assert.match(openingTag(doc, 'review-wip'), /data-signal="bad"/, `wip ${review.wip} of ${review.wipLimit}`);
    assert.match(doc, /new runs are refused until people clear the queue/);
    assert.match(doc, /<span style="width:100%">/, 'meter full');
  }
  const under = renderDashboard({ review: { wip: 4, wipLimit: 5, oldestWaitingMinutes: 95 } });
  assert.doesNotMatch(openingTag(under, 'review-wip'), /data-signal="bad"/);
  assert.match(under, /<span style="width:80%">/);
  assert.match(under, /1 of 5 review slots free/);
  assert.match(under, /<dd>95<span class="unit">min<\/span><span class="hint">≈ 1\.6 h<\/span><\/dd>/);
});

test('[P6.4] money uses 2 decimals, or 4 below one cent', () => {
  assert.equal(formatUsd(0.05), '$0.05');
  assert.equal(formatUsd(0.0012), '$0.0012');
  assert.equal(formatUsd(0.00999), '$0.0100');
  assert.equal(formatUsd(0.01), '$0.01');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(3), '$3.00');
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(-0.5), '-$0.50');
  for (const missing of [null, undefined, NaN, Infinity, '0.05']) assert.equal(formatUsd(missing), '—');

  const doc = renderDashboard({
    cost: { perAcceptedChangeUsd: 0.05, totalUsd: 1234.5, byRole: { builder: 0.0012 } },
    runs: [{ id: 'r1', task: 't', costUsd: 0.0012 }, { id: 'r2', task: 't', costUsd: null }],
  });
  assert.match(tileHtml(doc, 'cost-per-accepted-change'), /<p class="tile-value">\$0\.05<\/p>/);
  assert.match(tileHtml(doc, 'cost-per-accepted-change'), /total spend \$1,234\.50/);
  assert.match(doc, /<td class="num">\$0\.0012<\/td>/, 'sub-cent run cost');
  assert.match(doc, /<td class="num">—<\/td>/, 'unknown run cost is a dash');
  assert.match(doc, /<span class="bars-value">\$0\.0012/, 'sub-cent role cost');
});

test('[P6.4] cost by role is a bar list sorted by spend, with the count of runs with unknown cost', () => {
  const doc = renderDashboard({ cost: { byRole: { planner: 0.5, builder: 2, reviewer: 1 }, unknownCostRuns: 2 } });
  const labels = [...doc.matchAll(/<span class="bars-label">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['builder', 'reviewer', 'planner']);
  assert.match(doc, /<span class="bars-label">builder<\/span><span class="bar" aria-hidden="true"><span style="width:100%">/);
  assert.match(doc, /<span class="bars-label">planner<\/span><span class="bar" aria-hidden="true"><span style="width:25%">/);
  assert.match(openingTag(doc, 'unknown-cost-runs'), /data-signal="warn"/);
  assert.match(doc, /Runs with unknown cost<\/dt><dd><span class="sig" aria-hidden="true">▲<\/span>2<\/dd>/);
});
