// Oracle layer: requirement + design + scenario -> verdict, margin, confidence.

import { parse, horizon, robustness } from './stl.js';
import { MODELS, DEFAULT_SCENARIO } from './plant.js';

const INT_PARAMS = new Set(['seed']);
const BOOL_PARAMS = new Set(['encoder_a_failed']);
const SCENARIO_KEYS = new Set(Object.keys(DEFAULT_SCENARIO));

/** Validate and normalise one requirement object (as parsed from YAML). */
export function normalizeRequirement(r, index = 0) {
  const where = r && r.id ? r.id : `requirement #${index + 1}`;
  if (!r || typeof r !== 'object') throw new Error(`${where}: not an object`);
  if (!r.id) throw new Error(`${where}: missing "id"`);
  const out = {
    id: String(r.id), title: r.title || '', source: r.source || '', owner: r.owner || '',
    kind: r.kind === 'human_review' ? 'human_review' : 'computable',
    reason: r.reason || '',
  };
  if (out.kind === 'human_review') return out;

  if (!r.formula) throw new Error(`${where}: missing "formula"`);
  if (!MODELS[r.model]) throw new Error(`${where}: unknown model "${r.model}" (use ${Object.keys(MODELS).join(' or ')})`);
  try { out.ast = parse(String(r.formula)); }
  catch (e) { throw new Error(`${where}: formula error: ${e.message}`); }
  out.formula = String(r.formula);
  out.model = r.model;
  out.threshold = Number(r.threshold) || 1;
  out.horizon = horizon(out.ast);
  out.nominal = { ...(r.nominal || {}) };
  out.fixed = { ...(r.fixed || {}) };
  out.envelope = {};
  for (const [k, v] of Object.entries(r.envelope || {})) {
    if (!Array.isArray(v) || v.length !== 2 || !(Number(v[1]) >= Number(v[0]))) {
      throw new Error(`${where}: envelope "${k}" must be [min, max]`);
    }
    out.envelope[k] = [Number(v[0]), Number(v[1])];
  }
  for (const k of [...Object.keys(out.envelope), ...Object.keys(out.nominal), ...Object.keys(out.fixed)]) {
    if (!SCENARIO_KEYS.has(k)) throw new Error(`${where}: unknown scenario parameter "${k}" (known: ${[...SCENARIO_KEYS].join(', ')})`);
  }
  if (!Object.keys(out.envelope).length) throw new Error(`${where}: envelope is empty`);
  out.escalateBelow = Number(r.fidelity?.escalate_below ?? 0);
  return out;
}

export function normalizeRequirements(doc) {
  const list = Array.isArray(doc) ? doc : doc?.requirements;
  if (!Array.isArray(list) || !list.length) throw new Error('Expected a "requirements:" list');
  const reqs = list.map(normalizeRequirement);
  const ids = new Set();
  for (const r of reqs) {
    if (ids.has(r.id)) throw new Error(`Duplicate requirement id "${r.id}"`);
    ids.add(r.id);
  }
  return { system: doc.system || '', requirements: reqs };
}

export function scenarioFor(req, params) {
  const p = { ...DEFAULT_SCENARIO, ...req.fixed, ...params };
  for (const k of INT_PARAMS) p[k] = Math.round(p[k]);
  for (const k of BOOL_PARAMS) p[k] = Boolean(p[k]);
  return p;
}

export const fidelityFor = (req) => (req.escalateBelow > 0 ? 'high' : 'low');

export function trace(req, design, params, fidelity) {
  return MODELS[req.model](design, scenarioFor(req, params), fidelity, req.horizon);
}

export function evaluate(req, design, params, fidelity) {
  const tr = trace(req, design, params, fidelity);
  const signals = {};
  for (const [k, v] of Object.entries(tr)) if (v instanceof Float64Array) signals[k] = v;
  return robustness(req.ast, signals, tr.dt);
}

/** Verdict for one scenario. policy: 'escalate' (low, then high if thin margin) | 'low' | 'high'. */
export function runOracle(req, design, params = null, policy = 'escalate') {
  if (req.kind === 'human_review') return { reqId: req.id, verdict: 'HUMAN_REVIEW', note: req.reason };
  params = { ...(params || req.nominal) };
  const verdict = (rho) => (rho > 0 ? 'PASS' : 'FAIL');
  if (policy === 'low' || policy === 'high') {
    const rho = evaluate(req, design, params, policy);
    return { reqId: req.id, verdict: verdict(rho), rho, margin: rho / req.threshold, fidelity: policy, escalated: false, params };
  }
  const rhoLo = evaluate(req, design, params, 'low');
  const mLo = rhoLo / req.threshold;
  if (req.escalateBelow <= 0) {
    return { reqId: req.id, verdict: verdict(rhoLo), rho: rhoLo, margin: mLo, fidelity: 'analytic', escalated: false, params };
  }
  if (mLo >= req.escalateBelow) {
    return { reqId: req.id, verdict: verdict(rhoLo), rho: rhoLo, margin: mLo, fidelity: 'low', escalated: false, screenMargin: mLo, params };
  }
  const rhoHi = evaluate(req, design, params, 'high');
  return { reqId: req.id, verdict: verdict(rhoHi), rho: rhoHi, margin: rhoHi / req.threshold, fidelity: 'high', escalated: true, screenMargin: mLo, params };
}
