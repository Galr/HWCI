// HWCI web app: wires the STEP import, the viewer, the inputs and the verification run.
import { load as loadYaml } from '../vendor/js-yaml/js-yaml.mjs';
import { Viewer } from './viewer.js';
import { meshMassProps, aboutAxis, balanceMass } from './massprops.js';
import { buildDesign, DEFAULT_SETTINGS, MATERIALS, AXES, pivotPoint } from './design.js';
import { normalizeRequirements } from './engine/oracle.js';
import { planCost } from './engine/suite.js';
import { DEFAULT_REQUIREMENTS_YAML } from './default-requirements.js';
import { lineChart, scatterChart } from './charts.js';

const $ = (s) => document.querySelector(s);
const STORE_KEY = 'hwci.requirements.v1';
const THEME_KEY = 'hwci.theme';
const STEP_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0005, angularDeflection: 0.1 };

const PARAM_INFO = {
  shock_g: ['Shock peak', 'g'], shock_ms: ['Shock duration', 'ms'], axis_deg: ['Shock direction', '°'],
  temp_c: ['Temperature', '°C'], battery: ['Battery', '× nominal'], base_vib_grms: ['Platform vibration', 'g rms'],
  seed: ['Vibration realization', '#'], encoder_a_failed: ['Encoder A failed', ''],
};
const SIGNAL_INFO = {
  los_error_urad: ['Line-of-sight error', 'µrad', true], motor_torque: ['Motor torque', 'N·m', false],
  torque_ratio: ['Available torque / breakaway', '×', false], temp_c: ['Temperature', '°C', false],
};

const state = {
  fileName: null, meshes: null, mp: null,
  settings: { ...DEFAULT_SETTINGS },
  axisProps: null, design: null,
  reqText: '', reqs: null, reqError: null,
  result: null, runKey: null, selected: null, running: false,
  balanceRadiusMm: 60,
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ── formatting ─────────────────────────────────────────────
const pct = (m) => `${m >= 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(0)}%`;
const num = (v, d = 3) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0) ? v.toExponential(2) : v.toFixed(d));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtParam(k, v) {
  const [label, unit] = PARAM_INFO[k] || [k, ''];
  const val = typeof v === 'boolean' ? (v ? 'yes' : 'no') : k === 'seed' ? `#${v}` : Number(v).toFixed(Math.abs(v) < 10 ? 2 : 1);
  return { label, text: unit && k !== 'seed' ? `${val} ${unit}` : val };
}

// ── viewer ─────────────────────────────────────────────────
const viewer = new Viewer($('#viewer'));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.view(b.dataset.view)));

// ── STEP import ────────────────────────────────────────────
let stepWorker = null;
function readStep(buffer) {
  stepWorker = stepWorker || new Worker(new URL('./step-worker.js', import.meta.url));
  return new Promise((resolve, reject) => {
    stepWorker.onmessage = (ev) => (ev.data.ok ? resolve(ev.data.meshes) : reject(new Error(ev.data.error)));
    stepWorker.onerror = (e) => reject(new Error(e.message || 'The STEP reader failed to start'));
    stepWorker.postMessage({ buffer, params: STEP_PARAMS }, [buffer]);
  });
}

async function loadPart(name, buffer) {
  $('#viewerBusy').hidden = false;
  $('#viewerBusyText').textContent = `Reading ${name}…`;
  $('#viewerEmpty').hidden = true;
  setStatus('running', 'Reading STEP…');
  const t0 = performance.now();
  try {
    const meshes = await readStep(buffer);
    const mp = meshMassProps(meshes);
    Object.assign(state, { fileName: name, meshes, mp, result: null, runKey: null });
    viewer.setMeshes(meshes);
    $('#viewTools').hidden = false;
    $('#viewLegend').hidden = false;
    const tris = meshes.reduce((a, m) => a + m.index.length / 3, 0);
    $('#partInfo').hidden = false;
    $('#partInfo').innerHTML = `<b>${esc(name)}</b><br>${meshes.length} bod${meshes.length === 1 ? 'y' : 'ies'} · ${tris.toLocaleString()} triangles · read in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    recompute();
    renderIntroIfNoResult();
  } catch (e) {
    $('#viewerEmpty').hidden = !!state.meshes;
    setStatus('fail', 'Import failed');
    showError(`Could not load ${name}: ${e.message}`);
  } finally {
    $('#viewerBusy').hidden = true;
  }
}

const drop = $('#drop');
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await loadPart(f.name, await f.arrayBuffer());
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.(step|stp)$/i.test(f.name)) { showError('Please drop a .step or .stp file.'); return; }
  await loadPart(f.name, await f.arrayBuffer());
});
document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
  try {
    const res = await fetch(b.dataset.sample);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadPart(b.dataset.sample.split('/').pop(), await res.arrayBuffer());
  } catch (e) {
    showError(`Could not fetch the sample (${e.message}). If you opened index.html straight from disk, serve the folder over HTTP instead (see README).`);
  }
}));

// ── settings ───────────────────────────────────────────────
const NUM_FIELDS = ['density', 'tauMaxNom', 'rotorInertia', 'bandwidthHz', 'integralTime', 'runFriction20C', 'sealBreakaway20C'];
const matSel = $('#material');
matSel.innerHTML = MATERIALS.map((m) => `<option value="${m.id}">${m.name}${m.density ? ` · ${m.density}` : ''}</option>`).join('');

function syncInputs() {
  matSel.value = state.settings.material;
  for (const k of NUM_FIELDS) $(`#${k}`).value = state.settings[k];
  $('#pivot').value = state.settings.pivot;
  document.querySelectorAll('#axisSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.axis === state.settings.axis)));
}
matSel.addEventListener('change', () => {
  const m = MATERIALS.find((x) => x.id === matSel.value);
  state.settings.material = m.id;
  if (m.density) state.settings.density = m.density;
  syncInputs(); recompute();
});
for (const k of NUM_FIELDS) {
  $(`#${k}`).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!(v >= 0) || (k !== 'rotorInertia' && v === 0)) { e.target.value = state.settings[k]; return; }
    state.settings[k] = v;
    if (k === 'density') state.settings.material = MATERIALS.find((m) => m.density === v)?.id || 'custom';
    syncInputs(); recompute();
  });
}
$('#pivot').addEventListener('change', (e) => { state.settings.pivot = e.target.value; recompute(); });
document.querySelectorAll('#axisSeg button').forEach((b) => b.addEventListener('click', () => {
  state.settings.axis = b.dataset.axis; syncInputs(); recompute();
}));

function recompute() {
  if (!state.mp) { updateRunButton(); return; }
  const s = state.settings;
  const pivot = pivotPoint(state.mp, s.pivot);
  const ap = aboutAxis(state.mp, s.density, AXES[s.axis], pivot);
  state.axisProps = ap;
  state.design = buildDesign(ap, s);
  renderPartTables(pivot);
  viewer.setAnnotations({
    axis: AXES[s.axis], pivot: pivot.map((v) => v * 1e3),
    cg: state.mp.centroid.map((v) => v * 1e3), radial: ap.radial.map((v) => v * 1e3),
  });
  markStale();
  updateRunButton();
}

function renderPartTables() {
  const ap = state.axisProps, mp = state.mp, d = state.design;
  const size = mp.bbox.max.map((v, i) => ((v - mp.bbox.min[i]) * 1e3).toFixed(0)).join(' × ');
  const off = ap.cgOffset * 1e3;
  $('#massTable').hidden = false;
  $('#massTable').innerHTML = `
    <dt>Envelope</dt><dd>${size} mm</dd>
    <dt>Volume</dt><dd>${(mp.volume * 1e6).toFixed(1)} cm³</dd>
    <dt>Mass</dt><dd>${ap.mass.toFixed(3)} kg</dd>
    <dt>Centre of mass</dt><dd>${mp.centroid.map((v) => (v * 1e3).toFixed(2)).join(', ')} mm</dd>
    <dt>Inertia about tilt axis</dt><dd>${ap.inertiaAxis.toExponential(3)} kg·m²</dd>
    <dt>CG offset from axis</dt><dd class="${off > 0.5 ? 'flag' : ''}">${off.toFixed(2)} mm</dd>
    <dt>Static imbalance</dt><dd class="${off > 0.5 ? 'flag' : ''}">${(ap.imbalance * 1e3).toFixed(2)} g·m</dd>`;
  const bal = $('#balance');
  bal.hidden = false;
  if (off > 0.5) {
    const m = balanceMass(ap, state.balanceRadiusMm / 1e3) * 1e3;
    bal.className = 'callout';
    bal.innerHTML = `<b>Unbalanced on this axis.</b> The CG sits ${off.toFixed(1)} mm off the tilt axis, so shock and vibration turn directly into disturbance torque.
      A counterweight of <b>${m.toFixed(0)} g</b> at <input id="balR" type="number" min="5" step="5" value="${state.balanceRadiusMm}" aria-label="Counterweight radius in mm"> mm on the opposite side would cancel it.`;
    $('#balR').addEventListener('change', (e) => { const v = Number(e.target.value); if (v > 0) { state.balanceRadiusMm = v; renderPartTables(); } });
  } else {
    bal.className = 'callout good';
    bal.innerHTML = `<b>Balanced on this axis.</b> CG offset ${off.toFixed(2)} mm.`;
  }
  $('#designTable').hidden = false;
  $('#designTable').innerHTML = `
    <dt>Total inertia (part + rotor)</dt><dd>${d.inertia.toExponential(3)} kg·m²</dd>
    <dt>Gains Kp · Kd · Ki</dt><dd>${num(d.kp, 1)} · ${num(d.kd, 2)} · ${num(d.ki, 0)}</dd>`;
}

// ── requirements ───────────────────────────────────────────
const reqText = $('#reqText');
function validateReqs() {
  state.reqText = reqText.value;
  const st = $('#reqStatus');
  try {
    const { requirements } = normalizeRequirements(loadYaml(state.reqText));
    state.reqs = requirements; state.reqError = null;
    const comp = requirements.filter((r) => r.kind !== 'human_review').length;
    const cost = planCost(requirements, { mutation: $('#mutationToggle').checked });
    st.className = 'req-status ok';
    st.textContent = `✓ ${requirements.length} requirements · ${comp} computable · ≈${cost.toLocaleString()} simulations per run`;
  } catch (e) {
    state.reqs = null; state.reqError = e.message;
    st.className = 'req-status err';
    st.textContent = `✗ ${e.message.split('\n')[0]}`;
  }
  store.set(STORE_KEY, state.reqText);
  markStale();
  updateRunButton();
}
let reqTimer = null;
reqText.addEventListener('input', () => { clearTimeout(reqTimer); reqTimer = setTimeout(validateReqs, 250); });
reqText.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = reqText;
    reqText.setRangeText('  ', a, b, 'end');
    reqText.dispatchEvent(new Event('input'));
  }
});
$('#mutationToggle').addEventListener('change', validateReqs);
$('#reqReset').addEventListener('click', () => { reqText.value = DEFAULT_REQUIREMENTS_YAML; validateReqs(); });
$('#reqSave').addEventListener('click', () => download('requirements.yaml', reqText.value, 'text/yaml'));
$('#reqFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) { reqText.value = await f.text(); validateReqs(); }
  e.target.value = '';
});

// ── run ────────────────────────────────────────────────────
const inputsKey = () => JSON.stringify([state.fileName, state.settings, state.reqText, $('#mutationToggle').checked]);

function updateRunButton() {
  const ok = state.design && state.reqs && !state.running;
  $('#runBtn').disabled = !ok;
  $('#runBtn').title = !state.design ? 'Load a part first' : !state.reqs ? 'Fix the requirements first' : '';
  if (!state.running && !state.result) {
    if (!state.mp) setStatus('idle', 'No part loaded');
    else setStatus('idle', state.reqs ? 'Ready to run' : 'Requirements need fixing');
  }
}
function markStale() {
  if (state.result && !state.running && state.runKey !== inputsKey()) setStatus('stale', 'Inputs changed · re-run');
  else if (state.result && state.runKey === inputsKey()) setStatus(state.result.verdict === 'PASS' ? 'pass' : 'fail', state.result.verdict);
}
function setStatus(kind, text) { const s = $('#status'); s.dataset.state = kind; s.textContent = text; }

$('#runBtn').addEventListener('click', () => {
  if (!state.design || !state.reqs || state.running) return;
  state.running = true;
  const btn = $('#runBtn');
  btn.classList.add('running');
  btn.querySelector('.run-label').textContent = 'Running';
  updateRunButton();
  $('#progress').hidden = false;
  const bar = $('#progress .progress-bar');
  bar.style.width = '0%';
  setStatus('running', 'Starting…');
  const key = inputsKey();
  const runReqs = state.reqs;
  const worker = new Worker(new URL('./run-worker.js', import.meta.url), { type: 'module' });
  const finish = () => {
    worker.terminate();
    state.running = false;
    btn.classList.remove('running');
    btn.querySelector('.run-label').textContent = 'Run verification';
    $('#progress').hidden = true;
    updateRunButton();
  };
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'progress') {
      bar.style.width = `${Math.min(100, (100 * m.done) / m.total).toFixed(1)}%`;
      setStatus('running', `${Math.floor((100 * m.done) / m.total)}% · ${m.label}`);
    } else if (m.type === 'result') {
      state.result = m.result; state.runKey = key; state.runReqs = runReqs;
      state.selected = m.result.failed[0] || m.result.searches[0]?.reqId || null;
      finish();
      renderResults();
      setStatus(m.result.verdict === 'PASS' ? 'pass' : 'fail', m.result.verdict);
    } else if (m.type === 'error') {
      finish(); setStatus('fail', 'Run failed'); showError(m.error);
    }
  };
  worker.onerror = (e) => { finish(); setStatus('fail', 'Run failed'); showError(e.message || 'The verification worker crashed.'); };
  worker.postMessage({ design: state.design, requirementsYaml: state.reqText, mutation: $('#mutationToggle').checked });
});

// ── results ────────────────────────────────────────────────
const results = $('#results');
const introHtml = results.innerHTML;
function renderIntroIfNoResult() { if (!state.result) results.innerHTML = introHtml; }
function showError(msg) {
  const box = document.createElement('div');
  box.className = 'error-box';
  box.setAttribute('role', 'alert');
  box.textContent = msg;
  results.prepend(box);
  setTimeout(() => box.remove(), 12000);
}

function reqById(id) { return state.runReqs?.find((r) => r.id === id); }

function marginMeter(m) {
  const w = Math.min(50, Math.abs(m) * 50);
  const color = m >= 0 ? 'var(--ok)' : 'var(--bad)';
  const style = m >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  return `<div class="meter" aria-hidden="true"><span style="${style};background:${color}"></span></div>`;
}

function renderResults() {
  const R = state.result;
  const reqs = state.runReqs;
  const failedTitles = R.failed.map((id) => esc(id)).join(', ');
  const screenMiss = R.searches.filter((s) => s.screen && s.screen.worstMargin > 0 && s.falsified);
  const mut = R.mutation;
  const caught = mut ? mut.filter((m) => m.killed).length : 0;
  let summary;
  if (R.verdict === 'PASS') {
    summary = `Every computable requirement holds at the worst case the search could find.${R.human.length ? ` <b>${R.human.length}</b> still need a human review.` : ''}`;
  } else {
    summary = `<b>${failedTitles}</b> ${R.failed.length > 1 ? 'fail' : 'fails'} in the worst case found.`;
    if (screenMiss.length) summary += ` A check using only the fast low-fidelity model would have passed ${screenMiss.map((s) => esc(s.reqId)).join(', ')}.`;
  }
  if (mut) summary += ` Mutation testing caught <b>${caught} of ${mut.length}</b> seeded defects.`;

  const cards = reqs.map((r, i) => {
    if (r.kind === 'human_review') {
      return `<div class="card" style="animation-delay:${i * 40}ms;cursor:default">
        <div class="row"><span class="id">${esc(r.id)}</span><span class="badge review">◐ Human review</span></div>
        <div class="title">${esc(r.title)}</div><div class="sub">${esc(r.reason)}</div></div>`;
    }
    const s = R.searches.find((x) => x.reqId === r.id);
    const thin = !s.falsified && s.worstMargin < 0.1;
    return `<button type="button" class="card" data-req="${esc(r.id)}" aria-pressed="${state.selected === r.id}" style="animation-delay:${i * 40}ms">
      <div class="row"><span class="id">${esc(r.id)}</span>${s.falsified ? '<span class="badge fail">✗ Fail</span>' : thin ? '<span class="badge thin">✓ Thin margin</span>' : '<span class="badge pass">✓ Pass</span>'}</div>
      <div class="title">${esc(r.title)}</div>
      <div class="row"><span class="margin-num">${pct(s.worstMargin)}</span><span class="sub">worst-case margin</span></div>
      ${marginMeter(s.worstMargin)}
      <div class="sub">${s.evaluations} scenarios · ${s.fidelity} fidelity${s.screen ? ` · low-fi alone: ${pct(s.screen.worstMargin)}` : ''}</div>
    </button>`;
  }).join('');

  const mutRows = mut ? mut.map((m) => {
    const minM = Math.min(...Object.values(m.worst));
    const tag = m.killed ? '<span class="badge pass">✓ Caught</span>'
      : minM < 0.1 ? '<span class="badge thin">◐ Survived · thin</span>' : '<span class="badge review">◐ Survived</span>';
    return `<tr><td class="mono">${m.id}</td><td>${esc(m.description)}</td><td>${tag}</td>
      <td class="mono">${m.killedBy.map(esc).join(', ') || '—'}</td>
      <td class="mono">${Object.entries(m.worst).map(([k, v]) => `${esc(k.split('_')[0])} ${pct(v)}`).join(' · ')}</td></tr>`;
  }).join('') : '';

  results.innerHTML = `
    <div class="verdict ${R.verdict === 'PASS' ? 'pass' : 'fail'}">
      <div class="big">${R.verdict}</div>
      <p>${summary}</p>
      <div class="meta">${R.evaluations.toLocaleString()} simulations<br>${(R.runtimeMs / 1000).toFixed(1)} s · ${esc(state.fileName)}</div>
    </div>
    <div class="cards">${cards}</div>
    <div id="detail"></div>
    ${mut ? `<div class="panel-plain"><h3>Mutation testing</h3>
      <p class="note" style="margin:-4px 0 10px">Each row is this design with one seeded defect. If no requirement's worst-case search fails it, the defect survived:
      either it is harmless inside the tested envelopes, or the requirement set has a gap. That call belongs to an engineer.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Seeded defect</th><th>Result</th><th>Caught by</th><th>Worst margins</th></tr></thead><tbody>${mutRows}</tbody></table></div></div>` : ''}
    <div class="panel-plain"><h3>Export</h3>
      <div class="exports">
        <button type="button" class="btn solid" id="exJson">Results JSON</button>
        <button type="button" class="btn" id="exYaml">Requirements YAML</button>
        <button type="button" class="btn" id="exPng">Viewer snapshot</button>
      </div>
      <p class="note">Same check from a terminal or a CI pipeline (exit code 1 on failure):</p>
      <code class="cli">node tools/hwci.mjs ${esc(state.fileName)} --material ${esc(state.settings.material === 'custom' ? 'al6061 --density ' + state.settings.density : state.settings.material)} --axis ${state.settings.axis} --pivot ${state.settings.pivot}</code>
    </div>`;

  results.querySelectorAll('.card[data-req]').forEach((c) => c.addEventListener('click', () => {
    state.selected = c.dataset.req;
    results.querySelectorAll('.card[data-req]').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
    renderDetail();
  }));
  $('#exJson').addEventListener('click', exportJson);
  $('#exYaml').addEventListener('click', () => download('requirements.yaml', state.reqText, 'text/yaml'));
  $('#exPng').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = viewer.renderer.domElement.toDataURL('image/png');
    a.download = `${(state.fileName || 'part').replace(/\.\w+$/, '')}.png`;
    a.click();
  });
  renderDetail();
}

function windowOf(ast) {
  return ast && ast.type === 'eventually' ? [ast.a, ast.b] : null;
}

function renderDetail() {
  const box = $('#detail');
  if (!box) return;
  const r = reqById(state.selected);
  const s = state.result.searches.find((x) => x.reqId === state.selected);
  if (!r || !s) { box.innerHTML = ''; return; }
  const sig = s.traces.signal;
  const [sigName, unit, logY] = SIGNAL_INFO[sig] || [sig, '', false];
  const worst = Object.entries(s.worstParams).map(([k, v]) => fmtParam(k, v));
  const fixed = Object.entries(r.fixed).map(([k, v]) => fmtParam(k, v));
  const params = Object.keys(r.envelope);

  box.className = 'detail';
  box.innerHTML = `
    <div class="detail-head"><h3 style="margin:0">${esc(r.id)} · ${esc(r.title)}</h3>
      <span class="sub" style="font-size:12px;color:var(--ink-2)">${esc(r.source)}${r.owner ? ` · owner: ${esc(r.owner)}` : ''}</span></div>
    <div class="formula">${esc(r.formula)}</div>
    <div class="facts">
      <span>Worst-case margin <b>${pct(s.worstMargin)}</b> (${s.worstRho >= 0 ? '+' : ''}${num(s.worstRho, 2)} ${unit})</span>
      <span>Envelope coverage <b>${(s.coverage * 100).toFixed(0)}%</b> of a 3-bin grid</span>
      ${fixed.length ? `<span>Fixed: ${fixed.map((f) => `${f.label} <b>${esc(f.text)}</b>`).join(' · ')}</span>` : ''}
    </div>
    <div class="facts"><span>Worst scenario:</span>${worst.map((w) => `<span>${w.label} <b>${esc(w.text)}</b></span>`).join('')}</div>
    <div class="chart-title">${sigName} over time</div>
    <div class="chart-box" id="chTrace"></div>
    <div class="legend">
      <span><i style="background:var(--s1)"></i>Nominal design point</span>
      <span><i style="background:var(--s2)"></i>Worst case found (${s.fidelity} fidelity)</span>
      ${s.traces.worstLow ? '<span><i style="background:var(--s3)"></i>Same worst case, low-fidelity model</span>' : ''}
    </div>
    <div class="chart-title">Margin across every scenario tried
      <label>vs <select id="scX">${params.map((p) => `<option value="${p}">${(PARAM_INFO[p] || [p])[0]}</option>`).join('')}</select></label></div>
    <div class="chart-box" id="chScatter"></div>
    <div class="legend">
      <span><i class="dot" style="background:var(--s1)"></i>${s.fidelity === 'high' ? 'High-fidelity search' : 'Search'}</span>
      ${s.screen ? '<span><i class="dot" style="background:var(--s3)"></i>Low-fidelity search</span>' : ''}
      <span><i class="dot" style="background:var(--s2)"></i>Worst case</span>
    </div>
    ${s.screen ? `<p class="note">The low-fidelity model skips stick-slip friction, motor saturation and sensor effects. It is ten times faster and good for sweeping, but ${s.screen.worstMargin > s.worstMargin + 0.05 ? `here it is optimistic: ${pct(s.screen.worstMargin)} against ${pct(s.worstMargin)} at high fidelity` : `here it agrees within ${Math.abs((s.screen.worstMargin - s.worstMargin) * 100).toFixed(0)} points`}.</p>` : ''}`;

  const tr = s.traces;
  const series = [
    { name: 'Nominal', color: 'var(--s1)', t: tr.nominal.t, y: tr.nominal.y },
    ...(tr.worstLow ? [{ name: 'Worst, low-fi', color: 'var(--s3)', t: tr.worstLow.t, y: tr.worstLow.y }] : []),
    { name: 'Worst case', color: 'var(--s2)', t: tr.worst.t, y: tr.worst.y },
  ];
  const thr = r.threshold;
  lineChart($('#chTrace'), {
    series, logY, unit, yFloor: logY ? Math.max(0.05, thr / 500) : undefined,
    threshold: { value: thr, label: `limit ${thr} ${unit}` },
    window: windowOf(r.ast), xLabel: 'Time from event start (s)', yLabel: `${sigName} (${unit}${logY ? ', log' : ''})`,
    height: 280,
  });

  const drawScatter = () => {
    const xk = $('#scX').value;
    const [xl, xu] = PARAM_INFO[xk] || [xk, ''];
    const label = (h, kind) => `${kind}: margin ${pct(h.m)}\n` + Object.entries(h.p).map(([k, v]) => { const f = fmtParam(k, v); return `${f.label}: ${f.text}`; }).join('\n');
    const pts = [
      ...(s.screen ? s.screen.history.map((h) => ({ x: h.p[xk], y: h.m, group: 'low', label: label(h, 'Low fidelity') })) : []),
      ...s.history.map((h) => ({ x: h.p[xk], y: h.m, group: 'main', label: label(h, 'Search') })),
    ];
    const ys = pts.map((p) => p.y).sort((a, b) => a - b);
    const lo = ys[0], hi = ys[ys.length - 1];
    scatterChart($('#chScatter'), {
      points: pts, groups: { low: 'var(--s3)', main: 'var(--s1)' },
      xRange: r.envelope[xk], yMin: Math.min(-0.1, lo), yMax: Math.max(0.2, Math.min(hi, 1.5)),
      yFormat: (v) => `${Math.round(v * 100)}%`,
      highlight: { x: s.worstParams[xk], y: s.worstMargin, color: 'var(--s2)', label: label({ p: s.worstParams, m: s.worstMargin }, 'Worst case') },
      xLabel: `${xl}${xu ? ` (${xu})` : ''}`, yLabel: 'Margin (fraction of limit)', height: 250,
    });
  };
  $('#scX').addEventListener('change', drawScatter);
  if (params.includes('temp_c')) $('#scX').value = 'temp_c';
  drawScatter();
}

function exportJson() {
  const R = state.result;
  const out = {
    tool: 'hwci-poc', generated: new Date().toISOString(), part: state.fileName,
    settings: state.settings, massProperties: state.axisProps, design: state.design,
    requirementsYaml: state.reqText,
    result: { ...R, searches: R.searches.map(({ history, traces, screen, ...rest }) => ({ ...rest, screen: screen ? { worstMargin: screen.worstMargin, worstParams: screen.worstParams } : undefined })) },
  };
  download(`${(state.fileName || 'part').replace(/\.\w+$/, '')}-hwci.json`, JSON.stringify(out, null, 2), 'application/json');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── theme ──────────────────────────────────────────────────
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  viewer.refreshTheme();
  if (state.result) renderDetail();
}
$('#themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  store.set(THEME_KEY, next);
  applyTheme(next);
});
window.addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(() => state.result && renderDetail(), 150); });

// ── boot ───────────────────────────────────────────────────
applyTheme(store.get(THEME_KEY));
syncInputs();
reqText.value = store.get(STORE_KEY) || DEFAULT_REQUIREMENTS_YAML;
validateReqs();
updateRunButton();
const qs = new URLSearchParams(location.search).get('sample');
if (qs) document.querySelector(`[data-sample$="${CSS.escape(qs)}"]`)?.click();
