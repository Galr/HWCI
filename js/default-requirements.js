// Default executable requirements shown in the editor. Illustrative numbers, not a real spec.
export const DEFAULT_REQUIREMENTS_YAML = `# Executable requirements for a single-axis gimbal payload.
# formula   STL property on the model's signals (time 0 = event start)
# threshold limit used to express margins as a fraction
# envelope  scenario space the requirement must hold over (the search bounds)
# nominal   the single design point a traditional review would check
# fidelity  screen at low fidelity, escalate to high below this margin
#
# Signals:   shock_response -> los_error_urad, motor_torque
#            cold_start     -> torque_ratio, temp_c
# Scenario:  shock_g, shock_ms, axis_deg, temp_c, battery,
#            encoder_a_failed, base_vib_grms, seed

system: Gimbal payload

requirements:

  - id: R2_shock_recovery
    title: Line of sight recovers after functional shock
    source: MIL-STD-810H Method 516 (illustrative profile)
    owner: Controls lead
    model: shock_response
    formula: "eventually[0, 0.4] ( always[0, 5] los_error_urad < 50 )"
    threshold: 50
    nominal:  {shock_g: 20, shock_ms: 11, axis_deg: 90, temp_c: 20, battery: 1.0}
    envelope:
      shock_g:  [18, 22]
      shock_ms: [10, 12]
      axis_deg: [0, 90]
      temp_c:   [-40, 71]
      battery:  [0.8, 1.0]
    fidelity: {escalate_below: 0.5}

  - id: R3_cold_start
    title: Motor breaks the seals free after cold soak
    source: MIL-STD-810H Method 502 + customer SOW (illustrative)
    owner: Mechanical lead
    model: cold_start
    formula: "always[0, 30] torque_ratio > 1.3"
    threshold: 1.3
    nominal:  {temp_c: -32, battery: 1.0}
    envelope:
      temp_c:  [-40, -20]
      battery: [0.8, 1.0]

  - id: R5_degraded_mode
    title: Pointing jitter stays bounded on the backup encoder
    source: FMEA item 14, loss of encoder A (illustrative)
    owner: Systems lead
    model: shock_response
    formula: "always[0.2, 5] los_error_urad < 200"
    threshold: 200
    fixed:    {shock_g: 0, encoder_a_failed: true}
    nominal:  {base_vib_grms: 1.0, temp_c: 20, seed: 0}
    envelope:
      base_vib_grms: [0.5, 1.5]
      temp_c:        [-40, 71]
      seed:          [0, 1000]
    fidelity: {escalate_below: 0.5}

  - id: R4_field_maintenance
    title: Technician (5th-95th percentile, arctic gloves) swaps the camera module in under 10 min
    source: MIL-STD-1472 + customer SOW (illustrative)
    owner: Human factors lead
    kind: human_review
    reason: Reach envelope and tool access need a digital-human study and a VR walkthrough. Not computable in this POC.
`;
