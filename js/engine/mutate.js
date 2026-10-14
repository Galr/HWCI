// Mutation testing of the requirement set: seed known defects into the design
// and check that some requirement's worst-case search catches each one.
// A survivor means the defect is harmless in the tested envelopes, or the
// requirement set has a gap. Either way, a person has to decide.

export function mutants(base) {
  return [
    { id: 'M1', description: 'Worn bearings: running friction x2', change: { runFriction20C: base.runFriction20C * 2 } },
    { id: 'M2', description: 'Firmware regression: integrator disabled', change: { ki: 0 } },
    { id: 'M3', description: 'Undersized motor: peak torque -30%', change: { tauMaxNom: base.tauMaxNom * 0.7 } },
    base.payloadMass
      ? { id: 'M4', description: 'Assembly error: payload CG shifted 5 mm off axis', change: { imbalance: base.imbalance + base.payloadMass * 0.005 } }
      : { id: 'M4', description: 'Assembly error: mass imbalance x3', change: { imbalance: base.imbalance * 3 } },
    { id: 'M5', description: 'Wrong tuning file: loop gains halved', change: { kp: base.kp * 0.5, kd: base.kd * 0.5 } },
    { id: 'M6', description: 'Backup encoder noise x4', change: { encBNoiseUrad: base.encBNoiseUrad * 4 } },
  ];
}
