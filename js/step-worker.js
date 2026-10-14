// Classic worker: parses a STEP file with OpenCascade (WebAssembly) off the main thread.
/* global occtimportjs */
const base = new URL('../vendor/occt-import-js/', self.location.href).href;
importScripts(base + 'occt-import-js.js');

let occtPromise = null;

self.onmessage = async (ev) => {
  const { buffer, params } = ev.data;
  try {
    occtPromise = occtPromise || occtimportjs({ locateFile: (p) => base + p });
    const occt = await occtPromise;
    const res = occt.ReadStepFile(new Uint8Array(buffer), params);
    if (!res.success) throw new Error('OpenCascade could not read this file. Is it a valid STEP (AP203/AP214/AP242)?');
    if (!res.meshes.length) throw new Error('The file contains no solid geometry.');
    const meshes = res.meshes.map((m) => ({
      name: m.name || '',
      color: m.color || null,
      position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      index: new Uint32Array(m.index.array),
    }));
    const transfer = meshes.flatMap((m) => [m.position.buffer, m.index.buffer, ...(m.normal ? [m.normal.buffer] : [])]);
    self.postMessage({ ok: true, meshes }, transfer);
  } catch (e) {
    self.postMessage({ ok: false, error: e.message || String(e) });
  }
};
