"""
Synthetic single-axis gimbal model used as the "virtual environment".

This stands in for the real co-simulation (structure + motor + control
firmware). Every number here is illustrative, not a real product spec.
In a real deployment this module is replaced by a solver adapter that
returns the same signal dictionary (or a CSV/HDF5 trace).

Physics (high fidelity)
-----------------------
    J * theta'' = tau_motor + tau_disturbance - tau_friction
    tau_motor   = sat( -(Kp*e + Kd*w + Ki*int e), tau_max(T, V) )
    friction    = Karnopp stick/slip, running and breakaway levels rise in the cold
    disturbance = imbalance * shock acceleration * sin(axis)  (+ base vibration)
    sensing     = encoder quantization + noise (worse after encoder A fails)

Low fidelity drops stick/slip, saturation and sensor effects and uses a 10x
coarser time step. It is ~10x faster and is used for wide scenario sweeps.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
from scipy.signal import lfilter

G = 9.81


@dataclass(frozen=True)
class Design:
    """Design parameters of the gimbal (what a design AI would output)."""
    inertia: float = 0.02            # kg m^2
    kp: float = 178.0                # N m / rad
    kd: float = 2.64                 # N m s / rad
    ki: float = 590.0                # N m / (rad s)
    int_limit: float = 2e-4          # rad s, anti-windup clamp on the integrator
    tau_max_nom: float = 0.60        # N m, motor peak torque at 20 C, full battery
    run_friction_20c: float = 0.004  # N m, running friction (bearings + seal) at 20 C
    seal_breakaway_20c: float = 0.14 # N m, static breakaway torque of seal at 20 C
    cold_friction_coeff: float = 0.02  # +2 % friction per degC below 20 C
    imbalance: float = 0.002         # kg m, residual mass imbalance
    enc_res_urad: float = 1.0        # encoder A resolution
    enc_noise_urad: float = 2.0      # encoder A noise (1 sigma)
    encB_res_urad: float = 20.0      # backup encoder resolution
    encB_noise_urad: float = 15.0    # backup encoder noise

    def mutate(self, **kw) -> "Design":
        return replace(self, **kw)


@dataclass(frozen=True)
class Scenario:
    shock_g: float = 20.0
    shock_ms: float = 11.0
    axis_deg: float = 90.0           # 90 = shock fully couples into the axis
    temp_c: float = 20.0
    battery: float = 1.0             # fraction of nominal bus voltage
    encoder_a_failed: bool = False
    base_vib_grms: float = 0.0       # platform vibration during operation
    seed: int = 0


# ----------------------------------------------------------------- helpers
def cold_factor(d: Design, temp_c: float) -> float:
    return 1.0 + d.cold_friction_coeff * max(0.0, 20.0 - temp_c)


def tau_max(d: Design, temp_c: float, battery: float) -> float:
    # Slightly stronger magnets in the cold, torque scales with bus voltage.
    return d.tau_max_nom * battery * (1.0 + 0.001 * (20.0 - temp_c))


# ------------------------------------------------------------ shock response
def simulate_shock(d: Design, s: Scenario, fidelity: str = "high",
                   t_pre: float = 0.05, t_post: float = 6.0) -> dict:
    """Simulate a half-sine shock. Time 0 in the output = shock start."""
    dt = 1e-4 if fidelity == "high" else 1e-3
    n = int(round((t_pre + t_post) / dt))
    rng = np.random.default_rng(s.seed)

    tmax = tau_max(d, s.temp_c, s.battery)
    f_run = d.run_friction_20c * cold_factor(d, s.temp_c)
    f_static = 1.3 * f_run
    T = s.shock_ms / 1000.0
    coupling = abs(np.sin(np.radians(s.axis_deg)))

    if s.encoder_a_failed:
        res, noise = d.encB_res_urad * 1e-6, d.encB_noise_urad * 1e-6
    else:
        res, noise = d.enc_res_urad * 1e-6, d.enc_noise_urad * 1e-6

    # Base vibration: first-order filtered white noise acceleration
    vib = np.zeros(n)
    if s.base_vib_grms > 0:
        alpha = np.exp(-dt * 2 * np.pi * 200.0)
        w = rng.standard_normal(n) * np.sqrt(1 - alpha ** 2)
        vib = lfilter([1.0], [1.0, -alpha], w) * s.base_vib_grms * G

    # Pre-compute everything that does not depend on the state (keeps the loop fast)
    t_axis = np.arange(n) * dt - t_pre
    acc = np.where((t_axis >= 0) & (t_axis <= T), G * s.shock_g * np.sin(np.pi * t_axis / T), 0.0)
    tau_d = (d.imbalance * coupling * (acc + vib)).tolist()
    meas_noise = (noise * rng.standard_normal(n)).tolist()

    th = om = integ = 0.0
    out_th = [0.0] * n
    out_tau = [0.0] * n
    J, kp, kd, ki, ilim = d.inertia, d.kp, d.kd, d.ki, d.int_limit
    hi = fidelity == "high"
    b_visc = f_run / 0.01  # low-fidelity viscous stand-in for Coulomb friction

    for k in range(n):
        if hi:
            meas = round((th + meas_noise[k]) / res) * res
            u = -(kp * meas + kd * om + ki * integ)
            if u > tmax:
                u = tmax
            elif u < -tmax:
                u = -tmax
            else:
                integ = min(ilim, max(-ilim, integ + meas * dt))
            drive = u + tau_d[k]
            # Karnopp friction: stick if slow and drive below breakaway
            if -1e-5 < om < 1e-5 and -f_static <= drive <= f_static:
                om = 0.0
                acc_th = 0.0
            else:
                ref = om if om != 0.0 else drive
                acc_th = (drive - (f_run if ref > 0 else -f_run)) / J
        else:
            u = -(kp * th + kd * om + ki * integ)
            integ += th * dt
            acc_th = (u + tau_d[k] - b_visc * om) / J
        om += acc_th * dt
        th += om * dt
        out_th[k] = th
        out_tau[k] = u

    out_th = np.asarray(out_th)
    out_tau = np.asarray(out_tau)
    keep = t_axis >= 0
    return {
        "dt": dt,
        "t": t_axis[keep],
        "los_error_urad": np.abs(out_th[keep]) * 1e6,
        "motor_torque": out_tau[keep],
        "torque_limit": np.full(keep.sum(), tmax),
    }


# ----------------------------------------------------------- cold start
def simulate_cold_start(d: Design, s: Scenario, t_end: float = 40.0) -> dict:
    """Available motor torque vs breakaway torque while the unit self-heats."""
    dt = 0.05
    t = np.arange(0, t_end, dt)
    temp = s.temp_c + (20.0 - s.temp_c) * 0.5 * (1 - np.exp(-t / 60.0))
    avail = np.array([tau_max(d, T, s.battery) for T in temp])
    breakaway = np.array([(d.seal_breakaway_20c + 1.3 * d.run_friction_20c) * cold_factor(d, T)
                          for T in temp])
    return {"dt": dt, "t": t, "torque_ratio": avail / breakaway, "temp_c": temp}
