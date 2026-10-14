#!/usr/bin/env node
// Command-line runner: the same engine as the web app, for CI pipelines.
//
//   node tools/hwci.mjs samples/payload_balanced.step
//   node tools/hwci.mjs part.step --requirements reqs.yaml --material ti64 --axis y --json out.json
//
// Exit code 0 = all computable requirements pass their worst case, 1 = a failure, 2 = usage/input error.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { load as loadYaml } from '../vendor/js-yaml/js-yaml.mjs';
import { meshMassProps, aboutAxis } from '../js/massprops.js';
import { buildDesign, DEFAULT_SETTINGS, MATERIALS, AXES, pivotPoint } from '../js/design.js';
import { normalizeRequirements } from '../js/engine/oracle.js';
import { runSuite } from '../js/engine/suite.js';
import { DEFAULT_REQUIREMENTS_YAML } from '../js/default-requirements.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    requirements: { type: 'string', short: 'r' },
    material: { type: 'string', default: DEFAULT_SETTINGS.material },
    density: { type: 'string' },
    axis: { type: 'string', default: DEFAULT_SETTINGS.axis },
    pivot: { type: 'string', default: DEFAULT_SETTINGS.pivot },
    'no-mutation': { type: 'boolean', default: false },
    json: { type: 'string' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function die(msg) { console.error(`error: ${msg}`); process.exit(2); }
if (opt.help || positionals.length !== 1) {
  console.log('usage: node tools/hwci.mjs <part.step> [--requirements file.yaml] [--material al6061|alsi10mg|ti64|ss316|in718|pa12] [--density kg/m3] [--axis x|y|z] [--pivot origin|bbox|centroid] [--no-mutation] [--json out.json]');
  process.exit(opt.help ? 0 : 2);
}

const mat = MATERIALS.find((m) => m.id === opt.material);
const density = opt.density ? Number(opt.density) : mat?.density;
if (!(density > 0)) die(`unknown material "${opt.material}" (or give --density)`);
if (!AXES[opt.axis]) die('axis must be x, y or z');

const occt = await require(path.join(ROOT, 'vendor/occt-import-js/occt-import-js.js'))();
const res = occt.ReadStepFile(new Uint8Array(readFileSync(positionals[0])),
  { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0005, angularDeflection: 0.1 });
if (!res.success || !res.meshes.length) die('could not read the STEP file');
const mp = meshMassProps(res.meshes.map((m) => ({ position: m.attributes.position.array, index: m.index.array })));
const props = aboutAxis(mp, density, AXES[opt.axis], pivotPoint(mp, opt.pivot));
const design = buildDesign(props, { density, axis: opt.axis });

let reqs;
try {
  const text = opt.requirements ? readFileSync(opt.requirements, 'utf8') : DEFAULT_REQUIREMENTS_YAML;
  reqs = normalizeRequirements(loadYaml(text)).requirements;
} catch (e) { die(e.message); }

const log = opt.quiet ? () => {} : (...a) => console.log(...a);
log(`Part      ${path.basename(positionals[0])}  (${res.meshes.length} bodies, ${mp.triangles} triangles)`);
log(`Mass      ${props.mass.toFixed(3)} kg  ·  J(axis) ${props.inertiaAxis.toExponential(3)} kg·m²  ·  CG offset ${(props.cgOffset * 1e3).toFixed(2)} mm  ·  imbalance ${(props.imbalance * 1e3).toFixed(2)} g·m`);

let last = -1;
const result = runSuite(design, reqs, {
  mutation: !opt['no-mutation'],
  onProgress: (p) => {
    const pct = Math.floor((100 * p.done) / p.total / 10) * 10;
    if (!opt.quiet && pct !== last && process.stdout.isTTY) { last = pct; process.stdout.write(`\r${pct}%  ${p.label.padEnd(60)}`); }
  },
});
if (process.stdout.isTTY && !opt.quiet) process.stdout.write('\r'.padEnd(70) + '\r');

const pct = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(0)}%`;
log('\nWorst case per requirement');
for (const s of result.searches) {
  const screen = s.screen ? `   (low-fidelity only: ${pct(s.screen.worstMargin)})` : '';
  log(`  ${s.falsified ? 'FAIL' : 'pass'}  ${s.reqId.padEnd(22)} ${pct(s.worstMargin).padStart(6)}${screen}`);
}
for (const id of result.human) log(`  ----  ${id.padEnd(22)}   human review`);
if (result.mutation) {
  const caught = result.mutation.filter((m) => m.killed).length;
  log(`\nMutation testing: ${caught}/${result.mutation.length} seeded defects caught`);
  for (const m of result.mutation.filter((x) => !x.killed)) log(`  survived: ${m.id} ${m.description}`);
}
log(`\n${result.verdict}  (${result.evaluations} simulations, ${(result.runtimeMs / 1000).toFixed(1)} s)`);

if (opt.json) {
  const slim = { ...result, searches: result.searches.map(({ history, traces, screen, ...rest }) => ({ ...rest, screen: screen && { worstMargin: screen.worstMargin } })) };
  writeFileSync(opt.json, JSON.stringify({ part: path.basename(positionals[0]), massProperties: props, design, result: slim }, null, 2));
}
process.exit(result.verdict === 'PASS' ? 0 : 1);
