import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { robustness, parse, horizon } from '../js/engine/stl.js';
import { simulateShock, simulateColdStart, DEFAULT_DESIGN, DEFAULT_SCENARIO } from '../js/engine/plant.js';
import { normalizeRequirements, runOracle } from '../js/engine/oracle.js';
import { falsify } from '../js/engine/falsify.js';
import { mulberry32, normal } from '../js/engine/rng.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url)));

test('STL robustness matches brute force on random formulas', () => {
  const rand = mulberry32(42);
  const gauss = normal(rand);
  const dt = 0.01;
  let checked = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 50 + Math.floor(rand() * 250);
    const x = new Float64Array(n); const y = new Float64Array(n);
    let acc = 0;
    for (let k = 0; k < n; k++) { acc += gauss(); x[k] = acc; y[k] = gauss(); }
    const ia = Math.floor(rand() * 20), ib = ia + Math.floor(rand() * 30);
    const ic = Math.floor(rand() * 10), ie = ic + Math.floor(rand() * 20);
    const f = `eventually[${(ia * dt).toFixed(2)},${(ib * dt).toFixed(2)}] ( always[${(ic * dt).toFixed(2)},${(ie * dt).toFixed(2)}] x < 1 and y > -2 )`;
    const bf = () => {
      let best = -Infinity;
      for (let t1 = ia; t1 <= ib; t1++) {
        let inner = Infinity;
        for (let t2 = t1 + ic; t2 <= t1 + ie; t2++) inner = Math.min(inner, 1 - x[t2]);
        best = Math.max(best, Math.min(inner, y[t1] + 2));
      }
      return best;
    };
    if (ib + ie >= n) { assert.throws(() => robustness(f, { x, y }, dt), /Trace too short/); continue; }
    assert.ok(Math.abs(robustness(f, { x, y }, dt) - bf()) < 1e-9, f);
    checked++;
  }
  assert.ok(checked > 150);
});

test('STL parser: precedence, horizon and errors', () => {
  const ast = parse('not a > 1 or b < 2 and always[0,1] c < 3');
  assert.equal(ast.type, 'or');
  assert.equal(horizon(parse('eventually[0, 0.4] ( always[0, 5] e < 50 )')), 5.4);
  assert.throws(() => parse('always[2,1] x < 1'), /Bad interval/);
  assert.throws(() => parse('x = 3'), /Expected comparison|Unexpected/);
  assert.throws(() => parse('always[0,1] x < 1 )'), /Trailing/);
});

test('JS plant matches the Python reference engine (noise-free cases)', () => {
  const d = { ...DEFAULT_DESIGN, ...fixture.design };
  for (const c of fixture.cases) {
    const s = { ...DEFAULT_SCENARIO, ...c.scenario };
    const tr = simulateShock(d, s, c.fidelity, 5.45);
    const rho = robustness(fixture.formula, { los_error_urad: tr.los_error_urad }, tr.dt);
    const peak = Math.max(...tr.los_error_urad);
    const label = `${JSON.stringify(c.scenario)} ${c.fidelity}`;
    assert.ok(Math.abs(peak - c.peak) / c.peak < 1e-3, `${label}: peak ${peak} vs ${c.peak}`);
    assert.ok(Math.abs(rho - c.rho) < 0.5, `${label}: rho ${rho} vs ${c.rho}`);
  }
  const cs = simulateColdStart(DEFAULT_DESIGN, { ...DEFAULT_SCENARIO, temp_c: -40, battery: 0.8 });
  const minRatio = Math.min(...cs.torque_ratio.slice(0, Math.round(30 / cs.dt) + 1));
  assert.ok(Math.abs(minRatio - fixture.cold_start_min_ratio) < 1e-9);
});

test('requirement validation gives readable errors', () => {
  assert.throws(() => normalizeRequirements({ requirements: [{ id: 'A', model: 'shock_response', formula: 'x <', envelope: { temp_c: [0, 1] } }] }), /A: formula error/);
  assert.throws(() => normalizeRequirements({ requirements: [{ id: 'A', model: 'nope', formula: 'x < 1', envelope: { temp_c: [0, 1] } }] }), /unknown model/);
  assert.throws(() => normalizeRequirements({ requirements: [{ id: 'A', model: 'cold_start', formula: 'x < 1', envelope: { warp: [0, 1] } }] }), /unknown scenario parameter "warp"/);
  assert.throws(() => normalizeRequirements({ requirements: [{ id: 'A', kind: 'human_review' }, { id: 'A', kind: 'human_review' }] }), /Duplicate/);
});

test('falsification finds a known cold-start failure and the oracle agrees', () => {
  const { requirements } = normalizeRequirements({ requirements: [{
    id: 'R3', model: 'cold_start', formula: 'always[0, 30] torque_ratio > 1.3', threshold: 1.3,
    nominal: { temp_c: -20, battery: 1 }, envelope: { temp_c: [-40, -20], battery: [0.8, 1.0] },
  }] });
  const weak = { ...DEFAULT_DESIGN, tauMaxNom: 0.42 };
  assert.equal(runOracle(requirements[0], weak).verdict, 'PASS');           // nominal looks fine
  const s = falsify(requirements[0], weak, 'low');
  assert.equal(s.falsified, true);                                         // the corner does not
  assert.ok(s.worstParams.temp_c < -38 && s.worstParams.battery < 0.82);
});
