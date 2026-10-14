// Turns CAD-derived mass properties plus a few drive-train settings into the
// design parameters the gimbal model needs. Gains are re-tuned for the actual
// inertia, so a heavier payload gets a correspondingly stiffer loop.

import { DEFAULT_DESIGN, tuneGains } from './engine/plant.js';

export const MATERIALS = [
  { id: 'al6061', name: 'Aluminium 6061', density: 2700 },
  { id: 'alsi10mg', name: 'AlSi10Mg (AM)', density: 2670 },
  { id: 'ti64', name: 'Ti-6Al-4V', density: 4430 },
  { id: 'ss316', name: 'Stainless 316L', density: 7990 },
  { id: 'in718', name: 'Inconel 718', density: 8190 },
  { id: 'pa12', name: 'PA 12 (MJF)', density: 1010 },
  { id: 'custom', name: 'Custom', density: null },
];

export const DEFAULT_SETTINGS = Object.freeze({
  material: 'al6061',
  density: 2700,         // kg/m^3
  axis: 'x',             // tilt axis through the pivot
  pivot: 'origin',       // 'origin' | 'bbox' | 'centroid'
  rotorInertia: 0.004,   // kg m^2: motor rotor, bearings, frame parts that are not in the STEP
  tauMaxNom: 0.6,        // N m
  bandwidthHz: 14,
  integralTime: 0.1,     // s
  runFriction20C: 0.003, // N m
  sealBreakaway20C: 0.14,// N m
});

export const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function pivotPoint(mp, pivot) {
  if (pivot === 'bbox') return mp.bbox.min.map((v, i) => (v + mp.bbox.max[i]) / 2);
  if (pivot === 'centroid') return [...mp.centroid];
  return [0, 0, 0];
}

/** @param axisProps from massprops.aboutAxis  @param settings DEFAULT_SETTINGS-like */
export function buildDesign(axisProps, settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const inertia = axisProps.inertiaAxis + s.rotorInertia;
  const gains = tuneGains(inertia, { bandwidthHz: s.bandwidthHz, integralTime: s.integralTime, tauMax: s.tauMaxNom });
  return {
    ...DEFAULT_DESIGN,
    ...gains,
    inertia,
    payloadMass: axisProps.mass,
    imbalance: axisProps.imbalance,
    tauMaxNom: s.tauMaxNom,
    runFriction20C: s.runFriction20C,
    sealBreakaway20C: s.sealBreakaway20C,
  };
}
