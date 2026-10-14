// Mass properties of a closed triangulated solid (divergence theorem via signed tetrahedra).
// Input: meshes as returned by occt-import-js (positions in mm, triangle indices).
// Output in SI units. Accuracy is limited only by the tessellation of curved faces.

/**
 * @param {Array<{position: ArrayLike<number>, index: ArrayLike<number>}>} meshes  positions in mm
 * @returns {{volume:number, centroid:number[], C:number[][], bbox:{min:number[],max:number[]}, triangles:number}}
 *          volume m^3, centroid m, C = second-moment matrix about the centroid (m^5, i.e. per unit density)
 */
export function meshMassProps(meshes) {
  const s = 1e-3; // mm -> m
  let V = 0;
  const M1 = [0, 0, 0];
  const M2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const m of meshes) {
    const P = m.position, I = m.index;
    for (let k = 0; k < P.length; k += 3) {
      for (let d = 0; d < 3; d++) {
        const v = P[k + d] * s;
        if (v < min[d]) min[d] = v;
        if (v > max[d]) max[d] = v;
      }
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = [P[3 * I[t]] * s, P[3 * I[t] + 1] * s, P[3 * I[t] + 2] * s];
      const b = [P[3 * I[t + 1]] * s, P[3 * I[t + 1] + 1] * s, P[3 * I[t + 1] + 2] * s];
      const c = [P[3 * I[t + 2]] * s, P[3 * I[t + 2] + 1] * s, P[3 * I[t + 2] + 2] * s];
      // signed volume of tetra (origin, a, b, c)
      const v = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      V += v;
      const sum = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
      for (let i = 0; i < 3; i++) {
        M1[i] += (v * sum[i]) / 4;
        // integral of x x^T over the tetra = v/20 (a a^T + b b^T + c c^T + s s^T)
        for (let j = 0; j < 3; j++) M2[i][j] += (v / 20) * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + sum[i] * sum[j]);
      }
      triangles++;
    }
  }
  if (V < 0) { // inward-facing normals throughout: flip
    V = -V; for (let i = 0; i < 3; i++) { M1[i] = -M1[i]; for (let j = 0; j < 3; j++) M2[i][j] = -M2[i][j]; }
  }
  if (!(V > 0)) throw new Error('The model has no enclosed volume (open surface or sheet body?)');
  const cen = M1.map((x) => x / V);
  const C = M2.map((row, i) => row.map((x, j) => x - V * cen[i] * cen[j]));
  return { volume: V, centroid: cen, C, bbox: { min, max }, triangles };
}

/** Inertia tensor about the centroid for a given density (kg/m^3). */
export function inertiaAtCentroid(mp, density) {
  const C = mp.C;
  const tr = C[0][0] + C[1][1] + C[2][2];
  return C.map((row, i) => row.map((x, j) => density * ((i === j ? tr : 0) - x)));
}

/**
 * Properties about a rotation axis (unit direction `axis`, through `pivot`, metres).
 * Returns mass, axis inertia (kg m^2), CG offset from the axis (m) and imbalance (kg m).
 */
export function aboutAxis(mp, density, axis, pivot = [0, 0, 0]) {
  const nrm = Math.hypot(...axis);
  const a = axis.map((x) => x / nrm);
  const mass = density * mp.volume;
  const I = inertiaAtCentroid(mp, density);
  let Jc = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Jc += a[i] * I[i][j] * a[j];
  const d = mp.centroid.map((x, i) => x - pivot[i]);
  const along = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
  const radial = d.map((x, i) => x - along * a[i]);
  const r = Math.hypot(...radial);
  return { mass, inertiaAxis: Jc + mass * r * r, inertiaCentroidAxis: Jc, cgOffset: r, radial, imbalance: mass * r };
}

/** Counterweight needed on the opposite side at radius rCw (m) to cancel the imbalance. */
export function balanceMass(props, rCw) {
  return rCw > 0 ? props.imbalance / rCw : Infinity;
}
