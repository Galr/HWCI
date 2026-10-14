import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { meshMassProps, aboutAxis } from '../js/massprops.js';

const require = createRequire(import.meta.url);
const ref = JSON.parse(readFileSync(new URL('../samples/reference_massprops.json', import.meta.url)));
const PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0005, angularDeflection: 0.1 };

async function loadStep(name) {
  const occtimportjs = require('../vendor/occt-import-js/occt-import-js.js');
  const occt = await occtimportjs();
  const res = occt.ReadStepFile(new Uint8Array(readFileSync(new URL(`../samples/${name}`, import.meta.url))), PARAMS);
  assert.ok(res.success, 'STEP import failed');
  return res.meshes.map((m) => ({ position: m.attributes.position.array, index: m.index.array }));
}

for (const name of ['payload_unbalanced.step', 'payload_balanced.step']) {
  test(`mesh mass properties match OpenCascade for ${name}`, async () => {
    const mp = meshMassProps(await loadStep(name));
    const r = ref[name];
    const vol = r.volume_mm3 * 1e-9;
    assert.ok(Math.abs(mp.volume - vol) / vol < 0.003, `volume ${mp.volume} vs ${vol}`);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(mp.centroid[i] * 1e3 - r.cg_mm[i]) < 0.15, `cg[${i}] ${mp.centroid[i] * 1e3} vs ${r.cg_mm[i]}`);
    // inertia about the CG, X axis, per unit density: OCC gives mm^5, ours is m^5
    const Ixx = (mp.C[1][1] + mp.C[2][2]) * 1e15;
    assert.ok(Math.abs(Ixx - r.inertia_cg_mm5[0][0]) / r.inertia_cg_mm5[0][0] < 0.005, `Ixx ${Ixx} vs ${r.inertia_cg_mm5[0][0]}`);
    const ax = aboutAxis(mp, 2700, [1, 0, 0]);
    console.log(name, { mass_kg: ax.mass.toFixed(3), J_kgm2: ax.inertiaAxis.toExponential(3), cg_offset_mm: (ax.cgOffset * 1e3).toFixed(2), imbalance_kgm: ax.imbalance.toExponential(3) });
  });
}
