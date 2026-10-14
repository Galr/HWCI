// Runs the full verification loop for one design:
//   1. design-point review   one nominal scenario per requirement
//   2. worst-case search     per requirement; shock models also searched at low fidelity
//                            to show what a surrogate-only check would have concluded
//   3. mutation testing      optional: seeded defects vs the requirement set
// Pure JS, no DOM: runs in a Web Worker, in Node, or in CI.

import { runOracle, fidelityFor, trace } from './oracle.js';
import { falsify, evalsPerSearch } from './falsify.js';
import { mutants } from './mutate.js';

const MAX_POINTS = 1500;

function downsample(arr, dt, tMax) {
  const n = Math.min(arr.length, Math.round(tMax / dt) + 1);
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  const t = [], y = [];
  for (let k = 0; k < n; k += step) {
    // keep the extreme inside each bucket so peaks survive downsampling
    let m = arr[k];
    for (let q = k + 1; q < Math.min(n, k + step); q++) if (arr[q] > m) m = arr[q];
    t.push(k * dt); y.push(m);
  }
  return { t, y };
}

function primarySignal(req) {
  const m = req.formula.match(/[A-Za-z_][A-Za-z0-9_]*(?=\s*(<=|>=|<|>))/);
  return m ? m[0] : null;
}

function tracesFor(req, design, nominal, worstParams) {
  const sig = primarySignal(req);
  const plotT = Math.min(req.horizon + 0.05, req.model === 'shock_response' ? 2.5 : req.horizon + 1);
  const pack = (params, fid) => {
    const tr = trace(req, design, params, fid);
    return { fidelity: fid, ...downsample(tr[sig], tr.dt, plotT) };
  };
  const out = { signal: sig, nominal: pack(nominal, fidelityFor(req)), worst: pack(worstParams, fidelityFor(req)) };
  if (fidelityFor(req) === 'high') out.worstLow = pack(worstParams, 'low');
  return out;
}

// Mutation runs use a lighter search: they only need to find *a* failure, not the worst one.
export const MUTATION_BUDGET = Object.freeze({ nSweep: 40, nLocal: 2, localEvals: 30 });

export function planCost(requirements, { budget = {}, mutation = true } = {}) {
  const comp = requirements.filter((r) => r.kind !== 'human_review');
  const searches = comp.reduce((a, r) => a + (fidelityFor(r) === 'high' ? 2 : 1), 0);
  return evalsPerSearch(budget) * searches + (mutation ? evalsPerSearch(MUTATION_BUDGET) * 6 * comp.length : 0);
}

export function runSuite(design, requirements, { budget = {}, mutation = true, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const comp = requirements.filter((r) => r.kind !== 'human_review');
  const total = planCost(requirements, { budget, mutation });
  let done = 0;
  const tick = (stage, label) => () => { done++; if (done % 20 === 0) onProgress({ stage, label, done, total }); };

  onProgress({ stage: 'review', label: 'Design-point review', done, total });
  const review = requirements.map((r) => runOracle(r, design));

  const searches = [];
  for (const r of comp) {
    const fid = fidelityFor(r);
    const entry = { reqId: r.id };
    if (fid === 'high') {
      const lo = falsify(r, design, 'low', { ...budget, onEval: tick('search', `${r.id} · low-fidelity search`) });
      entry.screen = { worstMargin: lo.worstMargin, worstParams: lo.worstParams, evaluations: lo.evaluations,
        history: lo.history.map((h) => ({ p: h.params, m: h.rho / r.threshold })) };
    }
    const s = falsify(r, design, fid, { ...budget, onEval: tick('search', `${r.id} · worst-case search`) });
    Object.assign(entry, {
      fidelity: fid, worstMargin: s.worstMargin, worstRho: s.worstRho, worstParams: s.worstParams,
      falsified: s.falsified, evaluations: s.evaluations, coverage: s.coverage,
      history: s.history.map((h) => ({ p: h.params, m: h.rho / r.threshold })),
      traces: tracesFor(r, design, r.nominal, s.worstParams),
    });
    searches.push(entry);
  }

  let mutation_ = null;
  if (mutation) {
    mutation_ = mutants(design).map((m) => {
      const d = { ...design, ...m.change };
      const worst = {}; const killedBy = [];
      for (const r of comp) {
        const s = falsify(r, d, fidelityFor(r), { ...MUTATION_BUDGET, onEval: tick('mutation', `${m.id} · ${m.description}`) });
        worst[r.id] = s.worstMargin;
        if (s.falsified) killedBy.push(r.id);
      }
      return { id: m.id, description: m.description, killed: killedBy.length > 0, killedBy, worst };
    });
  }

  const failed = searches.filter((s) => s.falsified).map((s) => s.reqId);
  const human = requirements.filter((r) => r.kind === 'human_review').map((r) => r.id);
  onProgress({ stage: 'done', label: 'Done', done: total, total });
  return {
    verdict: failed.length ? 'FAIL' : 'PASS', failed, human,
    review, searches, mutation: mutation_,
    runtimeMs: Date.now() - t0, evaluations: done,
  };
}
