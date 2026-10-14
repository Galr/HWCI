// Single-axis gimbal model: the "virtual environment" the requirements run against.
//
//   J * theta'' = tau_motor + tau_disturbance - tau_friction
//   tau_motor   = sat( -(Kp e + Kd w + Ki int e), tau_max(T, V) )
//   friction    = Karnopp stick/slip; running and breakaway levels rise in the cold
//   disturbance = imbalance * (shock + platform vibration) * sin(axis angle)
//   sensing     = encoder quantization + noise (worse after encoder A fails)
//
// Low fidelity drops stick/slip, saturation and sensor effects and uses a 10x
// coarser time step. Every number is illustrative. In a production tool this
// module is replaced by adapters to real solvers that return the same signals.

import { mulberry32, normal } from './rng.js';

export const G = 9.81;

export const DEFAULT_DESIGN = Object.freeze({
  inertia: 0.02,             // kg m^2, about the tilt axis (payload + rotor)
  kp: 178.0,                 // N m / rad
  kd: 2.64,                  // N m s / rad
  ki: 1200.0,                // N m / (rad s)
  intLimit: 2e-4,            // rad s, anti-windup clamp
  tauMaxNom: 0.6,            // N m, motor peak torque at 20 C and full battery
  runFriction20C: 0.004,     // N m, running friction at 20 C
  sealBreakaway20C: 0.14,    // N m, static seal breakaway at 20 C
  coldFrictionCoeff: 0.02,   // +2 % friction per degC below 20 C
  imbalance: 0.002,          // kg m, mass x CG offset from the axis
  encResUrad: 1.0,
  encNoiseUrad: 2.0,
  encBResUrad: 20.0,
  encBNoiseUrad: 15.0,
});

export const DEFAULT_SCENARIO = Object.freeze({
  shock_g: 20, shock_ms: 11, axis_deg: 90, temp_c: 20, battery: 1.0,
  encoder_a_failed: false, base_vib_grms: 0, seed: 0,
});

/** Gains for a target closed-loop bandwidth (Hz), damping ratio and integral time (s). */
export function tuneGains(inertia, { bandwidthHz = 15, zeta = 0.7, integralTime = 0.15, tauMax = 0.6 } = {}) {
  const w = 2 * Math.PI * bandwidthHz;
  const kp = inertia * w * w;
  const kd = 2 * zeta * w * inertia;
  const ki = kp / integralTime;
  return { kp, kd, ki, intLimit: (0.4 * tauMax) / ki };
}

export const coldFactor = (d, T) => 1 + d.coldFrictionCoeff * Math.max(0, 20 - T);
export const tauMax = (d, T, battery) => d.tauMaxNom * battery * (1 + 0.001 * (20 - T));

/** Half-sine shock response. Output time 0 = shock start. */
export function simulateShock(d, s, fidelity = 'high', tPost = 6.0, tPre = 0.05) {
  const hi = fidelity === 'high';
  const dt = hi ? 1e-4 : 1e-3;
  const n = Math.round((tPre + tPost) / dt);
  const uni = mulberry32(1000003 * (s.seed | 0) + 17);
  const gauss = normal(uni);

  const tmax = tauMax(d, s.temp_c, s.battery);
  const fRun = d.runFriction20C * coldFactor(d, s.temp_c);
  const fStatic = 1.3 * fRun;
  const T = s.shock_ms / 1000;
  const coupling = Math.abs(Math.sin((s.axis_deg * Math.PI) / 180));
  const res = (s.encoder_a_failed ? d.encBResUrad : d.encResUrad) * 1e-6;
  const noise = (s.encoder_a_failed ? d.encBNoiseUrad : d.encNoiseUrad) * 1e-6;

  // Platform vibration: first-order filtered white noise (200 Hz corner)
  const alpha = Math.exp(-dt * 2 * Math.PI * 200);
  const vibGain = Math.sqrt(1 - alpha * alpha);
  const vibScale = (s.base_vib_grms || 0) * G;
  let vib = 0;

  const J = d.inertia, kp = d.kp, kd = d.kd, ki = d.ki, ilim = d.intLimit;
  const bVisc = fRun / 0.01;
  const keepFrom = Math.round(tPre / dt);
  const m = n - keepFrom;
  const los = new Float64Array(m);
  const torque = new Float64Array(m);
  let th = 0, om = 0, integ = 0;

  for (let k = 0; k < n; k++) {
    const t = k * dt - tPre;
    const acc = t >= 0 && t <= T ? G * s.shock_g * Math.sin((Math.PI * t) / T) : 0;
    if (vibScale > 0) vib = alpha * vib + vibGain * gauss();
    const tauD = d.imbalance * coupling * (acc + vib * vibScale);
    let u, accTh;
    if (hi) {
      const meas = Math.round((th + noise * gauss()) / res) * res;
      u = -(kp * meas + kd * om + ki * integ);
      if (u > tmax) u = tmax;
      else if (u < -tmax) u = -tmax;
      else integ = Math.min(ilim, Math.max(-ilim, integ + meas * dt));
      const drive = u + tauD;
      if (om > -1e-5 && om < 1e-5 && drive >= -fStatic && drive <= fStatic) {
        om = 0; accTh = 0;                                   // stuck (Karnopp)
      } else {
        const ref = om !== 0 ? om : drive;
        accTh = (drive - (ref > 0 ? fRun : -fRun)) / J;
      }
    } else {
      u = -(kp * th + kd * om + ki * integ);
      integ += th * dt;
      accTh = (u + tauD - bVisc * om) / J;
    }
    om += accTh * dt;
    th += om * dt;
    if (k >= keepFrom) {
      los[k - keepFrom] = Math.abs(th) * 1e6;
      torque[k - keepFrom] = u;
    }
  }
  return { dt, n: m, los_error_urad: los, motor_torque: torque, torque_limit: tmax };
}

/** Available motor torque vs seal breakaway while the unit self-heats after a cold soak. */
export function simulateColdStart(d, s, tEnd = 40) {
  const dt = 0.05;
  const n = Math.round(tEnd / dt);
  const ratio = new Float64Array(n);
  const temp = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = k * dt;
    const T = s.temp_c + (20 - s.temp_c) * 0.5 * (1 - Math.exp(-t / 60));
    const breakaway = (d.sealBreakaway20C + 1.3 * d.runFriction20C) * coldFactor(d, T);
    temp[k] = T;
    ratio[k] = tauMax(d, T, s.battery) / breakaway;
  }
  return { dt, n, torque_ratio: ratio, temp_c: temp };
}

export const MODELS = {
  shock_response: (d, s, fid, tNeed) => simulateShock(d, s, fid, tNeed + 0.05),
  cold_start: (d, s, _fid, tNeed) => simulateColdStart(d, s, tNeed + 1),
};
