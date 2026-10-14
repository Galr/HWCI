// Falsification: search a requirement's scenario envelope for the case that
// minimises robustness. Latin-hypercube sweep for breadth, Nelder-Mead from the
// worst few points for depth. Every evaluation is logged for coverage and plots.

import { evaluate } from './oracle.js';
import { mulberry32 } from './rng.js';

function latinHypercube(n, dim, rand) {
  const pts = Array.from({ length: n }, () => new Float64Array(dim));
  for (let d = 0; d < dim; d++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < n; i++) pts[i][d] = (perm[i] + rand()) / n;
  }
  return pts;
}

/** Minimise f over the unit box (f clips internally). Returns nothing; f logs its own history. */
function nelderMead(f, x0, { maxfev = 40, step = 0.08 } = {}) {
  const dim = x0.length;
  let simplex = [Float64Array.from(x0)];
  for (let i = 0; i < dim; i++) {
    const p = Float64Array.from(x0);
    p[i] = p[i] + step <= 1 ? p[i] + step : p[i] - step;
    simplex.push(p);
  }
  let vals = simplex.map((p) => f(p));
  let fev = vals.length;
  const comb = (a, b, t) => a.map((ai, i) => ai + t * (b[i] - ai));
  while (fev < maxfev) {
    const order = vals.map((v, i) => i).sort((i, j) => vals[i] - vals[j]);
    simplex = order.map((i) => simplex[i]);
    vals = order.map((i) => vals[i]);
    if (Math.abs(vals[dim] - vals[0]) < 1e-6) break;
    const centroid = new Float64Array(dim);
    for (let i = 0; i < dim; i++) for (let d = 0; d < dim; d++) centroid[d] += simplex[i][d] / dim;
    const worst = simplex[dim];
    const xr = comb(centroid, worst, -1); const fr = f(xr); fev++;
    if (fr < vals[0]) {
      const xe = comb(centroid, worst, -2); const fe = f(xe); fev++;
      if (fe < fr) { simplex[dim] = xe; vals[dim] = fe; } else { simplex[dim] = xr; vals[dim] = fr; }
    } else if (fr < vals[dim - 1]) {
      simplex[dim] = xr; vals[dim] = fr;
    } else {
      const xc = fr < vals[dim] ? comb(centroid, worst, -0.5) : comb(centroid, worst, 0.5);
      const fc = f(xc); fev++;
      if (fc < Math.min(fr, vals[dim])) { simplex[dim] = xc; vals[dim] = fc; }
      else {
        for (let i = 1; i <= dim; i++) { simplex[i] = comb(simplex[0], simplex[i], 0.5); vals[i] = f(simplex[i]); fev++; }
      }
    }
  }
}

function toParams(req, u) {
  const out = {};
  Object.entries(req.envelope).forEach(([name, [lo, hi]], i) => {
    const x = Math.min(1, Math.max(0, u[i]));
    const v = lo + x * (hi - lo);
    out[name] = name === 'seed' ? Math.round(v) : v;
  });
  return out;
}

/** Share of envelope cells (bins per parameter) holding at least one evaluated scenario. */
export function binnedCoverage(req, history, bins = 3) {
  const names = Object.keys(req.envelope);
  const seen = new Set();
  for (const h of history) {
    seen.add(names.map((n) => {
      const [lo, hi] = req.envelope[n];
      const x = hi > lo ? (h.params[n] - lo) / (hi - lo) : 0;
      return Math.min(bins - 1, Math.floor(x * bins));
    }).join(','));
  }
  return seen.size / bins ** names.length;
}

export function falsify(req, design, fidelity = 'high', { nSweep = 60, nLocal = 3, localEvals = 40, seed = 1, onEval } = {}) {
  const history = [];
  const f = (u) => {
    const params = toParams(req, u);
    const rho = evaluate(req, design, params, fidelity);
    history.push({ params, rho });
    if (onEval) onEval(history.length);
    return rho;
  };
  const dim = Object.keys(req.envelope).length;
  const sweep = latinHypercube(nSweep, dim, mulberry32(seed * 7919 + 3));
  const rhos = sweep.map(f);
  const starts = rhos.map((r, i) => i).sort((a, b) => rhos[a] - rhos[b]).slice(0, nLocal);
  for (const i of starts) nelderMead(f, sweep[i], { maxfev: localEvals });
  let worst = history[0];
  for (const h of history) if (h.rho < worst.rho) worst = h;
  return {
    reqId: req.id, fidelity,
    worstParams: worst.params, worstRho: worst.rho, worstMargin: worst.rho / req.threshold,
    falsified: worst.rho < 0, evaluations: history.length,
    coverage: binnedCoverage(req, history), history,
  };
}

export const evalsPerSearch = ({ nSweep = 60, nLocal = 3, localEvals = 40 } = {}) => nSweep + nLocal * localEvals;
