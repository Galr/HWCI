// Minimal dependency-free SVG charts: a time-series chart with crosshair readout
// and a scatter chart with per-point tooltips. Colors come from CSS variables
// so light and dark themes are handled by the stylesheet.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toPrecision(2));

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) out.push(+v.toFixed(10));
  return out;
}

function frame(container, { height = 260, xLabel, yLabel }) {
  container.innerHTML = '';
  const W = Math.max(320, container.clientWidth || 640), H = height;
  const m = { l: 66, r: 14, t: 12, b: 40 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'chart', role: 'img' });
  container.appendChild(svg);
  if (xLabel) el('text', { x: m.l + (W - m.l - m.r) / 2, y: H - 6, class: 'ax-label', 'text-anchor': 'middle' }, svg).textContent = xLabel;
  if (yLabel) {
    const t = el('text', { x: 12, y: m.t + (H - m.t - m.b) / 2, class: 'ax-label', 'text-anchor': 'middle', transform: `rotate(-90 12 ${m.t + (H - m.t - m.b) / 2})` }, svg);
    t.textContent = yLabel;
  }
  return { svg, W, H, m, pw: W - m.l - m.r, ph: H - m.t - m.b };
}

export function lineChart(container, opt) {
  const f = frame(container, opt);
  const { svg, m, pw, ph } = f;
  const xMax = opt.xMax ?? Math.max(...opt.series.map((s) => s.t[s.t.length - 1]));
  const floor = opt.logY ? (opt.yFloor ?? 0.1) : 0;
  const allY = opt.series.flatMap((s) => s.y);
  const yMax = opt.yMax ?? Math.max(...allY, opt.threshold?.value ?? 0) * 1.15;
  const yMin = opt.yMin ?? (opt.logY ? floor : Math.min(0, ...allY));
  const X = (t) => m.l + (t / xMax) * pw;
  const Y = opt.logY
    ? (v) => m.t + ph - ((Math.log10(Math.max(v, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * ph
    : (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

  if (opt.window) el('rect', { x: X(opt.window[0]), y: m.t, width: X(opt.window[1]) - X(opt.window[0]), height: ph, class: 'win' }, svg);
  const yt = opt.logY
    ? Array.from({ length: Math.floor(Math.log10(yMax)) - Math.ceil(Math.log10(yMin)) + 1 }, (_, i) => 10 ** (Math.ceil(Math.log10(yMin)) + i))
    : niceTicks(yMin, yMax);
  for (const v of yt) {
    el('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
    el('text', { x: m.l - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  for (const v of niceTicks(0, xMax, 6)) {
    el('line', { x1: X(v), x2: X(v), y1: m.t, y2: m.t + ph, class: 'grid' }, svg);
    el('text', { x: X(v), y: m.t + ph + 16, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = v;
  }
  el('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: 'axis' }, svg);
  if (opt.threshold) {
    el('line', { x1: m.l, x2: m.l + pw, y1: Y(opt.threshold.value), y2: Y(opt.threshold.value), class: 'limit' }, svg);
    el('text', { x: m.l + pw - 4, y: Y(opt.threshold.value) - 6, class: 'limit-label', 'text-anchor': 'end' }, svg).textContent = opt.threshold.label;
  }
  for (const s of opt.series) {
    let d = '';
    for (let i = 0; i < s.t.length; i++) if (s.t[i] <= xMax) d += `${i ? 'L' : 'M'}${X(s.t[i]).toFixed(1)},${Y(s.y[i]).toFixed(1)}`;
    el('path', { d, class: 'series', style: `stroke:${s.color}` }, svg);
  }

  // crosshair + readout
  const hair = el('line', { y1: m.t, y2: m.t + ph, class: 'hair', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);
  const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * f.W;
    const t = Math.max(0, Math.min(xMax, ((sx - m.l) / pw) * xMax));
    hair.setAttribute('x1', X(t)); hair.setAttribute('x2', X(t)); hair.setAttribute('visibility', 'visible');
    const rows = opt.series.map((s) => {
      let i = 0; while (i < s.t.length - 1 && s.t[i + 1] <= t) i++;
      return `<div><i style="background:${s.color}"></i>${s.name}<b>${fmt(s.y[i])} ${opt.unit || ''}</b></div>`;
    });
    tip.innerHTML = `<div class="tip-h">t = ${t.toFixed(3)} s</div>${rows.join('')}`;
    tip.hidden = false;
    const px = (X(t) / f.W) * r.width;
    tip.style.left = `${Math.min(px + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = '8px';
  });
  hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  return svg;
}

export function scatterChart(container, opt) {
  const f = frame(container, opt);
  const { svg, m, pw, ph } = f;
  const xs = opt.points.map((p) => p.x), ys = opt.points.map((p) => p.y);
  const [x0, x1] = opt.xRange ?? [Math.min(...xs), Math.max(...xs)];
  const yLo = Math.min(opt.yMin ?? -0.2, ...ys), yHi = Math.max(opt.yMax ?? 1, ...ys);
  const pad = (yHi - yLo) * 0.06;
  const yMin = yLo - pad, yMax = yHi + pad;
  const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * pw;
  const Y = (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;
  for (const v of niceTicks(yMin, yMax)) {
    el('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
    el('text', { x: m.l - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = opt.yFormat ? opt.yFormat(v) : fmt(v);
  }
  for (const v of niceTicks(x0, x1, 6)) {
    el('line', { x1: X(v), x2: X(v), y1: m.t, y2: m.t + ph, class: 'grid' }, svg);
    el('text', { x: X(v), y: m.t + ph + 16, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = fmt(v);
  }
  if (yMin < 0 && yMax > 0) {
    el('line', { x1: m.l, x2: m.l + pw, y1: Y(0), y2: Y(0), class: 'limit' }, svg);
    el('text', { x: m.l + pw - 4, y: Y(0) - 6, class: 'limit-label', 'text-anchor': 'end' }, svg).textContent = 'pass / fail';
  }
  el('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: 'axis' }, svg);
  for (const p of opt.points) {
    const c = el('circle', { cx: X(p.x), cy: Y(p.y), r: 4, class: 'dot', style: `fill:${opt.groups[p.group]}` }, svg);
    el('title', {}, c).textContent = p.label;
  }
  if (opt.highlight) {
    const h = opt.highlight;
    const c = el('circle', { cx: X(h.x), cy: Y(h.y), r: 7, class: 'dot hl', style: `fill:${h.color}` }, svg);
    el('title', {}, c).textContent = h.label;
  }
  return svg;
}
