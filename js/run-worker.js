// Module worker: runs the verification suite without blocking the page.
import { load as loadYaml } from '../vendor/js-yaml/js-yaml.mjs';
import { normalizeRequirements } from './engine/oracle.js';
import { runSuite } from './engine/suite.js';

self.onmessage = (ev) => {
  const { design, requirementsYaml, mutation } = ev.data;
  try {
    const { requirements } = normalizeRequirements(loadYaml(requirementsYaml));
    let last = 0;
    const result = runSuite(design, requirements, {
      mutation,
      onProgress: (p) => {
        const now = performance.now();
        if (now - last > 80 || p.stage === 'done') { last = now; self.postMessage({ type: 'progress', ...p }); }
      },
    });
    self.postMessage({ type: 'result', result });
  } catch (e) {
    self.postMessage({ type: 'error', error: e.message || String(e) });
  }
};
