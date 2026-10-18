// Static HTML dashboard (principle 6.4): outcomes and stability lead, activity comes last.
// One self-contained document: inline CSS, no scripts, no network resources. Every interpolated value is escaped by the
// `html` tag below, so names, ids and states written by users or agents can never become markup.

const DASH = '—';

// ---------------------------------------------------------------------------------------------------------------------
// Escaping

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

class SafeHtml {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

function interpolate(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

// Tagged template: literal parts are markup; every interpolated value is escaped unless it is a fragment built by this
// tag. Arrays are concatenated; null, undefined and false render nothing.
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// ---------------------------------------------------------------------------------------------------------------------
// Values: anything that is not a finite number or a non-empty string renders as a dash.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asObject = (v) => (isObject(v) ? v : {});
const asList = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function str(v) {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return null;
}

const text = (v) => str(v) ?? DASH;

// toFixed without a negative zero ("-0.0").
function fixed(v, digits) {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? s.replace('-', '') : s;
}

// Thousands separators on a plain decimal string, independent of the machine's locale.
function group(s) {
  const [whole, frac] = s.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = whole.slice(sign.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? sign + digits : `${sign}${digits}.${frac}`;
}

function formatNumber(value, maxDecimals = 1) {
  const v = num(value);
  if (v === null) return DASH;
  const whole = Number.isInteger(Number(v.toFixed(maxDecimals)));
  return group(fixed(v, whole ? 0 : maxDecimals));
}

function formatPercent(rate) {
  const v = num(rate);
  return v === null ? DASH : `${group(fixed(v * 100, 1))}%`;
}

// US dollars with 2 decimals; 4 decimals when 0 < |x| < 0.01 so sub-cent agent costs stay visible.
export function formatUsd(value) {
  const v = num(value);
  if (v === null) return DASH;
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  const body = abs.toFixed(digits);
  return `${v < 0 && Number(body) !== 0 ? '-' : ''}$${group(body)}`;
}

function formatMs(value) {
  const v = num(value);
  return v === null ? DASH : formatNumber(v, Math.abs(v) < 10 ? 1 : 0);
}

function approxDuration(minutes) {
  if (minutes === null || Math.abs(minutes) < 60) return '';
  if (Math.abs(minutes) < 1440) return `≈ ${fixed(minutes / 60, 1)} h`;
  return `≈ ${group(fixed(minutes / 1440, 1))} d`;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ISO timestamps render as "YYYY-MM-DD HH:MM UTC"; anything else is shown as given (escaped), missing as a dash.
function formatTime(value) {
  let date = null;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && ISO_TIMESTAMP.test(value)) date = new Date(value);
  if (date && !Number.isNaN(date.getTime())) {
    const iso = date.toISOString();
    return html`<time datetime="${iso}">${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC</time>`;
  }
  return html`${text(value)}`;
}

function formatWindow(range) {
  if (!isObject(range)) return DASH;
  const from = formatTime(range.from);
  const to = formatTime(range.to);
  if (from.value === DASH && to.value === DASH) return DASH;
  return html`${from} → ${to}`;
}

// Bar width in percent: always finite and within 0..100.
function share(part, whole) {
  const p = num(part);
  const w = num(whole);
  if (p === null || w === null || w <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (p / w) * 100)) * 10) / 10;
}

// Run state → tone, first match wins. Keywords must start a word ('-', '_' and spaces separate words), so 'abandoned'
// is not 'done'. The CSS class comes from this fixed list, never from the state string itself.
const STATE_TONES = [
  ['bad', 'fail|reject|error|abort|abandon|incident|rolled|rollback|cancel|kill|stop|time(?:d|out)|refus'],
  ['warn', 'needs|human|await|wait|pending|approval|pause|block|escalat|not-earned'],
  ['good', 'accept|releas|pass|done|complet|succe|merg|approved'],
  ['info', 'run|build|plan|review|gat(?:e|ing)|holdout|queue|start|progress|active'],
].map(([tone, words]) => [tone, new RegExp(`(?:^|[^a-z])(?:${words})`)]);

function stateTone(state) {
  const s = (str(state) ?? '').toLowerCase();
  for (const [tone, pattern] of STATE_TONES) if (pattern.test(s)) return tone;
  return 'neutral';
}

// ---------------------------------------------------------------------------------------------------------------------
// Building blocks

const marker = (glyph) => html`<span class="sig" aria-hidden="true">${glyph}</span>`;
const empty = (message) => html`<p class="empty">${message}</p>`;

function joinNotes(parts) {
  const present = parts.filter((p) => p !== '' && p !== null && p !== undefined);
  return present.flatMap((p, i) => (i ? [' · ', p] : [p]));
}

// `span` sets the panel's share of the desktop grid: full row, or a 2/5 or 3/5 column.
function section({ id, index, title, principle, sub, span = 'full' }, body) {
  return html`<section class="panel panel-${span}" id="${id}" data-section="${id}" aria-labelledby="${id}-title">
<div class="panel-head"><h2 id="${id}-title"><span class="idx">${index}</span>${title}</h2><span class="tag" title="Factory principle ${principle}">P${principle}</span></div>
<p class="panel-sub">${sub}</p>
${body}
</section>
`;
}

// `head` entries: [label, numeric?, colspan?].
function table({ labelledBy, className, head, rows }) {
  const headCells = head.map(([label, numeric, colspan]) => html`<th scope="col"${colspan ? html` colspan="${colspan}"` : ''}${numeric ? html` class="num"` : ''}>${label}</th>`);
  return html`<div class="table-wrap" tabindex="0" role="region" aria-labelledby="${labelledBy}">
<table class="${className}">
<thead><tr>${headCells}</tr></thead>
<tbody>
${rows}</tbody>
</table>
</div>`;
}

// A value above `limit` is a bad signal; at or below it is within bounds; a missing value carries no signal.
function limitCheck(value, limit, limitText) {
  if (value === null) return { signal: null, note: `limit ${limitText}` };
  if (value > limit) return { signal: 'bad', note: html`${marker('▲')}above the ${limitText} limit` };
  return { signal: 'ok', note: html`${marker('●')}within the ${limitText} limit` };
}

function tile({ metric, label, value, unit = '', notes = [], signal = null }) {
  const lines = joinNotes(notes);
  return html`<article class="tile" data-metric="${metric}"${signal ? html` data-signal="${signal}"` : ''}>
<h3 class="tile-label">${label}</h3>
<p class="tile-value">${value}${unit && value !== DASH ? html`<span class="unit">${unit}</span>` : ''}</p>
${lines.length ? html`<p class="tile-note">${lines}</p>` : ''}
</article>
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sections, in reading order: outcomes and stability first, activity last.

function renderHeader(m) {
  return html`<header class="masthead">
<p class="eyebrow">principled-factory</p>
<h1>Factory dashboard</h1>
<p class="lede">Outcomes and stability first, activity last (principle 6.4).</p>
<dl class="meta">
<div><dt>Generated</dt><dd>${formatTime(m.generatedAt)}</dd></div>
<div><dt>Window</dt><dd>${formatWindow(m.window)}</dd></div>
</dl>
</header>
`;
}

function renderOutcomes(m) {
  const o = asObject(m.outcomes);
  const cost = asObject(m.cost);
  const runs = num(o.runs);
  const accepted = num(o.accepted);
  const released = num(o.released);
  const changeFailure = num(o.changeFailureRate);
  const failedShare = num(cost.failedShare);
  const overfitGap = num(o.overfitGapPts);
  const leadTime = num(o.medianLeadTimeMinutes);
  const humanMinutes = num(o.humanMinutesPerChange);
  const totalUsd = num(cost.totalUsd);
  const failedUsd = num(cost.failedUsd);

  const changeFailureCheck = limitCheck(changeFailure, 0.15, '15%');
  const failedShareCheck = limitCheck(failedShare, 0.5, '50%');
  const overfitCheck = limitCheck(overfitGap, 10, '10 pts');

  let acceptedNote = '';
  if (accepted !== null && runs !== null) acceptedNote = `${formatNumber(accepted)} of ${formatNumber(runs)} runs`;
  else if (runs !== null) acceptedNote = `${formatNumber(runs)} runs`;

  let failedSpendNote = '';
  if (failedUsd !== null && totalUsd !== null) failedSpendNote = `${formatUsd(failedUsd)} of ${formatUsd(totalUsd)}`;
  else if (failedUsd !== null) failedSpendNote = formatUsd(failedUsd);

  const tiles = [
    tile({ metric: 'accepted-rate', label: 'Accepted rate', value: formatPercent(o.acceptedRate), notes: [acceptedNote] }),
    tile({ metric: 'first-pass-rate', label: 'First-pass rate', value: formatPercent(o.firstPassRate) }),
    tile({
      metric: 'change-failure-rate', label: 'Change-failure rate', value: formatPercent(changeFailure),
      signal: changeFailureCheck.signal,
      notes: [changeFailureCheck.note, released !== null ? `${formatNumber(released)} released` : ''],
    }),
    tile({
      metric: 'escaped-defects', label: 'Escaped defects', value: formatNumber(o.escapedDefects),
      notes: ['found after release'],
    }),
    tile({
      metric: 'cost-per-accepted-change', label: 'Cost per accepted change', value: formatUsd(cost.perAcceptedChangeUsd),
      notes: [totalUsd !== null ? `total spend ${formatUsd(totalUsd)}` : ''],
    }),
    tile({
      metric: 'failed-spend-share', label: 'Spend on failed attempts', value: formatPercent(failedShare),
      signal: failedShareCheck.signal, notes: [failedShareCheck.note, failedSpendNote],
    }),
    tile({
      metric: 'median-lead-time', label: 'Median lead time', value: formatNumber(leadTime), unit: 'min',
      notes: [approxDuration(leadTime)],
    }),
    tile({
      metric: 'human-minutes-per-change', label: 'Human minutes per change', value: formatNumber(humanMinutes), unit: 'min',
      notes: [approxDuration(humanMinutes)],
    }),
    tile({
      metric: 'overfit-gap', label: 'Overfit gap', value: overfitGap === null ? DASH : group(fixed(overfitGap, 1)),
      unit: 'pts', signal: overfitCheck.signal, notes: [overfitCheck.note, 'visible − holdout pass rate'],
    }),
  ];

  return section({
    id: 'outcomes', index: '01', title: 'Outcomes and stability', principle: '6.4',
    sub: 'What was accepted, what it cost, and whether it held.',
  }, html`<div class="tiles">
${tiles}</div>`);
}

function renderReview(m) {
  const meta = {
    id: 'review', index: '02', title: 'Review capacity', principle: '8.1', span: 'narrow',
    sub: 'Runs waiting for a person (plan or release approvals, escalations) against the WIP limit.',
  };
  if (!isObject(m.review)) return section(meta, empty('No review data in this window.'));

  const wip = num(m.review.wip);
  const limit = num(m.review.wipLimit);
  const oldest = num(m.review.oldestWaitingMinutes);
  const known = wip !== null && limit !== null;
  const atLimit = known && wip >= limit;

  let note = '';
  if (atLimit) {
    const state = wip > limit ? `Over the WIP limit by ${formatNumber(wip - limit)}` : 'At the WIP limit';
    note = html`${marker('▲')}${state} · new runs are refused until people clear the queue`;
  } else if (known) {
    note = html`${marker('●')}${formatNumber(limit - wip)} of ${formatNumber(limit)} review slots free`;
  }
  let signal = null;
  if (atLimit) signal = 'bad';
  else if (known) signal = 'ok';
  const label = known
    ? `${formatNumber(wip)} of ${formatNumber(limit)} review slots in use`
    : 'Review slots in use: unknown';
  const oldestHint = approxDuration(oldest);

  return section(meta, html`<div class="capacity" data-metric="review-wip"${signal ? html` data-signal="${signal}"` : ''}>
<p class="capacity-figure"><span class="capacity-wip">${formatNumber(wip)}</span><span class="capacity-limit">/ ${formatNumber(limit)}</span><span class="capacity-caption">waiting for a person</span></p>
<div class="meter" role="img" aria-label="${label}"><span style="width:${atLimit ? 100 : share(wip, limit)}%"></span></div>
${note ? html`<p class="capacity-note">${note}</p>` : ''}
</div>
<dl class="facts">
<div><dt>Oldest waiting</dt><dd>${formatNumber(oldest)}${oldest !== null ? html`<span class="unit">min</span>` : ''}${oldestHint ? html`<span class="hint">${oldestHint}</span>` : ''}</dd></div>
</dl>`);
}

function renderAutonomy(m) {
  const meta = {
    id: 'autonomy', index: '03', title: 'Autonomy', principle: '7.1', span: 'broad',
    sub: 'Tier per change class, and the tier its track record has earned.',
  };
  const rows = asList(m.autonomy);
  if (!rows.length) return section(meta, empty('No autonomy data recorded yet.'));
  return section(meta, table({
    labelledBy: 'autonomy-title',
    className: 'autonomy-table',
    head: [['Change class'], ['Tier'], ['Earned tier'], ['Clean streak', true]],
    rows: rows.map((row) => html`<tr>
<td class="mono">${text(row.class)}</td>
<td><span class="chip">${text(row.tier)}</span></td>
<td><span class="chip">${text(row.earnedTier)}</span></td>
<td class="num">${formatNumber(row.cleanStreak)}</td>
</tr>
`),
  }));
}

function renderGates(m) {
  const meta = {
    id: 'gates', index: '04', title: 'Gate statistics', principle: '9.3', span: 'broad',
    sub: 'Which gates fail first, how often nothing was verified, and what each costs in time.',
  };
  const rows = asList(m.gates);
  if (!rows.length) return section(meta, empty('No gate evaluations in this window.'));
  const maxFirst = rows.reduce((max, gate) => Math.max(max, num(gate.failedFirst) ?? 0), 0);
  return section(meta, table({
    labelledBy: 'gates-title',
    className: 'gates-table',
    head: [['Gate'], ['Evaluated', true], ['First failures', true, 2], ['NOT-EARNED', true], ['Avg ms', true]],
    rows: rows.map((gate) => {
      const notEarned = num(gate.notEarned);
      const warn = notEarned !== null && notEarned > 0;
      return html`<tr>
<td class="mono">${text(gate.id)}</td>
<td class="num">${formatNumber(gate.evaluated)}</td>
<td class="bar-cell"><span class="bar" aria-hidden="true"><span style="width:${share(gate.failedFirst, maxFirst)}%"></span></span></td>
<td class="num">${formatNumber(gate.failedFirst)}</td>
<td class="num"${warn ? html` data-signal="warn"` : ''}>${warn ? marker('▲') : ''}${formatNumber(notEarned)}</td>
<td class="num">${formatMs(gate.avgMs)}</td>
</tr>
`;
    }),
  }));
}

function renderCost(m) {
  const meta = {
    id: 'cost', index: '05', title: 'Cost by role', principle: '6.3', span: 'narrow',
    sub: 'Agent spend per role in this window, failed attempts included.',
  };
  const cost = asObject(m.cost);
  const roles = (isObject(cost.byRole) ? Object.entries(cost.byRole) : [])
    .map(([role, usd]) => ({ role, usd: num(usd) }))
    .sort((a, b) => {
      const diff = (b.usd ?? -Infinity) - (a.usd ?? -Infinity);
      if (diff) return diff;
      return a.role < b.role ? -1 : a.role > b.role ? 1 : 0;
    });
  const max = roles.reduce((top, r) => Math.max(top, r.usd ?? 0), 0);
  const total = roles.reduce((sum, r) => sum + Math.max(0, r.usd ?? 0), 0);
  const unknown = num(cost.unknownCostRuns);
  const unknownWarn = unknown !== null && unknown > 0;

  const bars = roles.length
    ? html`<ul class="bars">
${roles.map((r) => html`<li><span class="bars-label">${text(r.role)}</span><span class="bar" aria-hidden="true"><span style="width:${share(r.usd, max)}%"></span></span><span class="bars-value">${formatUsd(r.usd)}${total > 0 && r.usd !== null ? html`<span class="bars-share">${formatPercent(r.usd / total)}</span>` : ''}</span></li>
`)}</ul>`
    : empty('No cost recorded by role.');

  return section(meta, html`${bars}
<dl class="facts">
<div><dt>Total spend</dt><dd>${formatUsd(cost.totalUsd)}</dd></div>
<div data-metric="unknown-cost-runs"${unknownWarn ? html` data-signal="warn"` : ''}><dt>Runs with unknown cost</dt><dd>${unknownWarn ? marker('▲') : ''}${formatNumber(unknown)}</dd></div>
</dl>
${unknownWarn ? html`<p class="facts-note">Runs with unknown cost are not priced, so spend figures may be understated.</p>` : ''}`);
}

function renderRuns(m) {
  const rows = asList(m.runs);
  const meta = {
    id: 'runs', index: '06', title: 'Recent runs', principle: '6.4',
    sub: rows.length ? `Activity, listed last on purpose · ${formatNumber(rows.length)} shown.` : 'Activity, listed last on purpose.',
  };
  if (!rows.length) return section(meta, empty('No runs in this window.'));
  return section(meta, table({
    labelledBy: 'runs-title',
    className: 'runs-table',
    head: [['Run'], ['Task'], ['State'], ['Attempts', true], ['Cost', true], ['Change class'], ['Started']],
    rows: rows.map((run) => html`<tr>
<td class="mono">${text(run.id)}</td>
<td class="wrap">${text(run.task)}</td>
<td><span class="pill pill-${stateTone(run.state)}">${text(run.state)}</span></td>
<td class="num">${formatNumber(run.attempts)}</td>
<td class="num">${formatUsd(run.costUsd)}</td>
<td class="mono">${text(run.changeClass)}</td>
<td class="mono">${formatTime(run.startedAt)}</td>
</tr>
`),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Styles: dark «Greenfield» palette, system fonts only. Kept free of url(), @import and @font-face.

const CSS = `
:root {
  --bg: #07080B;
  --surface: #0F1218;
  --surface-2: #131821;
  --line: #242C38;
  --line-soft: #1A2029;
  --text: #EDF1F5;
  --muted: #8C95A4;
  --green: #5BF59A;
  --cyan: #54DCF6;
  --amber: #FFC24B;
  --rose: #FF7A8D;
  --violet: #B393FF;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(1000px 460px at 10% -10%, rgba(91, 245, 154, 0.08), transparent 70%) no-repeat;
  color: var(--text);
  font: 15px/1.5 var(--sans);
  font-variant-numeric: tabular-nums;
}
::selection { background: rgba(91, 245, 154, 0.28); }
.page { max-width: 1200px; margin: 0 auto; padding: 40px 24px 48px; }

.masthead { margin-bottom: 28px; }
.eyebrow {
  display: flex; align-items: center; gap: 8px; margin: 0 0 10px;
  font: 500 12px/1.4 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--green);
}
.eyebrow::before {
  content: ''; width: 8px; height: 8px; border-radius: 50%;
  background: var(--green); box-shadow: 0 0 0 3px rgba(91, 245, 154, 0.18);
}
h1 { margin: 0; font: 650 clamp(28px, 5vw, 40px)/1.1 var(--sans); letter-spacing: -0.02em; }
.lede { margin: 10px 0 0; max-width: 62ch; color: var(--muted); }
.meta { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 20px 0 0; }
.meta > div { min-width: 0; }
.meta dt, .facts dt {
  font: 500 11px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
}
.meta dd { margin: 4px 0 0; font: 14px/1.4 var(--mono); overflow-wrap: anywhere; }

.layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 1100px) {
  .layout { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .panel-full { grid-column: 1 / -1; }
  .panel-narrow { grid-column: span 2; }
  .panel-broad { grid-column: span 3; }
}
.panel { min-width: 0; padding: 20px; background: var(--surface); border: 1px solid var(--line-soft); border-radius: 14px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.panel-head h2 { display: flex; align-items: baseline; gap: 10px; min-width: 0; margin: 0; font: 600 17px/1.3 var(--sans); }
.idx { font: 500 12px/1 var(--mono); color: var(--green); }
.tag {
  flex: none; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px;
  font: 500 11px/1.6 var(--mono); color: var(--muted);
}
.panel-sub { margin: 4px 0 16px; font-size: 13px; color: var(--muted); }
.empty { margin: 0; padding: 16px; border: 1px solid var(--line-soft); border-radius: 10px; font-size: 14px; color: var(--muted); }

.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 12px; }
.tile { min-width: 0; margin: 0; padding: 14px 16px 16px; background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 10px; }
.tile-label { margin: 0; font: 500 11px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.tile-value { margin: 10px 0 0; font: 600 28px/1.15 var(--mono); letter-spacing: -0.02em; overflow-wrap: anywhere; }
.unit, .hint { margin-left: 6px; font-size: 13px; font-weight: 500; letter-spacing: 0; color: var(--muted); }
.tile-note { margin: 8px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); }
.sig { margin-right: 5px; }
[data-signal="ok"] .sig { color: var(--green); }
[data-signal="warn"] .sig { color: var(--amber); }
[data-signal="bad"] .sig { color: var(--rose); }
.tile[data-signal="bad"] { border-color: rgba(255, 122, 141, 0.55); box-shadow: inset 0 3px 0 var(--rose); }
.tile[data-signal="bad"] .tile-value, .tile[data-signal="bad"] .tile-note { color: var(--rose); }

.capacity-figure { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; }
.capacity-wip { font: 600 40px/1 var(--mono); }
.capacity-limit { font: 500 20px/1 var(--mono); color: var(--muted); }
.capacity-caption { font-size: 13px; color: var(--muted); }
.meter { height: 10px; margin: 14px 0 10px; overflow: hidden; background: rgba(91, 245, 154, 0.14); border-radius: 2px 5px 5px 2px; }
.meter > span { display: block; height: 100%; background: var(--green); border-radius: 0 5px 5px 0; }
.capacity-note { margin: 0; font-size: 13px; color: var(--muted); }
.capacity[data-signal="bad"] .meter { background: rgba(255, 122, 141, 0.16); }
.capacity[data-signal="bad"] .meter > span { background: var(--rose); }
.capacity[data-signal="bad"] .capacity-wip, .capacity[data-signal="bad"] .capacity-note { color: var(--rose); }

.facts { display: flex; flex-wrap: wrap; gap: 12px 32px; margin: 18px 0 0; }
.facts > div { min-width: 0; }
.facts dd { margin: 4px 0 0; font: 600 18px/1.3 var(--mono); overflow-wrap: anywhere; }
.facts [data-signal="warn"] dd { color: var(--amber); }
.facts-note { margin: 8px 0 0; font-size: 13px; color: var(--amber); }

.table-wrap { overflow-x: auto; border: 1px solid var(--line-soft); border-radius: 10px; }
.table-wrap:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 10px 14px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--line-soft); }
thead th {
  background: var(--surface-2); white-space: nowrap;
  font: 500 11px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
}
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: rgba(237, 241, 245, 0.025); }
th.num, td.num { text-align: right; }
td.num, td.mono { font-family: var(--mono); font-size: 13px; white-space: nowrap; }
td.wrap { min-width: 14rem; overflow-wrap: anywhere; }
td[data-signal="warn"] { color: var(--amber); }
.runs-table { min-width: 760px; }
.gates-table { min-width: 520px; }

.bar { display: block; height: 6px; overflow: hidden; background: rgba(84, 220, 246, 0.14); border-radius: 0 3px 3px 0; }
.bar > span { display: block; height: 100%; background: var(--cyan); border-radius: 0 3px 3px 0; }
td.bar-cell { width: 1%; padding-right: 0; }
td.bar-cell .bar { width: 72px; }
.bars { display: grid; grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) auto; gap: 12px; margin: 0; padding: 0; list-style: none; }
.bars li {
  display: grid; grid-column: 1 / -1; align-items: center; column-gap: 12px;
  grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 9rem;
  grid-template-columns: subgrid;
}
.bars-label { font: 13px/1.3 var(--mono); overflow-wrap: anywhere; }
.bars .bar { height: 8px; border-radius: 0 4px 4px 0; }
.bars .bar > span { border-radius: 0 4px 4px 0; }
.bars-value { font: 13px/1.3 var(--mono); text-align: right; white-space: nowrap; }
.bars-share { margin-left: 8px; color: var(--muted); }

.pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 1px 9px;
  border: 1px solid var(--line); border-radius: 999px; font: 12px/1.6 var(--mono); white-space: nowrap;
}
.pill::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
.pill-good::before { background: var(--green); }
.pill-info::before { background: var(--cyan); }
.pill-warn { border-color: rgba(255, 194, 75, 0.4); }
.pill-warn::before { background: var(--amber); }
.pill-bad { border-color: rgba(255, 122, 141, 0.45); }
.pill-bad::before { background: var(--rose); }
.chip {
  display: inline-block; padding: 0 8px; border: 1px solid rgba(179, 147, 255, 0.4); border-radius: 6px;
  font: 12.5px/1.7 var(--mono); white-space: nowrap;
}

.foot { margin: 28px 0 0; font: 12px/1.5 var(--mono); color: var(--muted); }

@media (max-width: 560px) {
  .page { padding: 24px 16px 40px; }
  .panel { padding: 16px; border-radius: 12px; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .tile { padding: 12px; }
  .tile-value { font-size: 21px; }
  .capacity-wip { font-size: 34px; }
  .bars { grid-template-columns: minmax(0, 6.5rem) minmax(0, 1fr) auto; gap: 10px; }
  .bars li { column-gap: 10px; }
  th, td { padding: 8px 10px; }
  thead th { white-space: normal; }
}
@media (max-width: 340px) {
  .tiles { grid-template-columns: minmax(0, 1fr); }
}
`;

// ---------------------------------------------------------------------------------------------------------------------

// Render the whole dashboard as one HTML document string. Every section is optional; missing values render as a dash.
export function renderDashboard(metrics) {
  const m = asObject(metrics);
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="dark">
<title>Factory dashboard</title>
<style>${new SafeHtml(CSS)}</style>
</head>
<body>
<div class="page">
${renderHeader(m)}<main class="layout">
${renderOutcomes(m)}${renderReview(m)}${renderAutonomy(m)}${renderGates(m)}${renderCost(m)}${renderRuns(m)}</main>
<footer class="foot">Static report: inline styles only, no scripts, no network requests.</footer>
</div>
</body>
</html>
`;
  return doc.value;
}
