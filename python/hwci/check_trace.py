"""
Solver-agnostic entry point: evaluate one requirement against a trace exported
from any simulation tool (Simcenter, Ansys, Simulink, MuJoCo, a test rig...).

CSV format: a header row, a column named `t` (seconds, uniform step), and one
column per signal named exactly as in the requirement formula.

    python -m hwci.check_trace trace.csv requirements.yaml R2_shock_recovery [--at 0.0]
"""
from __future__ import annotations

import argparse
import sys

import numpy as np

from . import stl
from .oracle import load_requirements


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trace")
    ap.add_argument("requirements")
    ap.add_argument("req_id")
    ap.add_argument("--at", type=float, default=0.0, help="evaluation instant in trace time (s)")
    a = ap.parse_args(argv)

    data = np.genfromtxt(a.trace, delimiter=",", names=True)
    t = data["t"]
    dt = float(np.median(np.diff(t)))
    if np.max(np.abs(np.diff(t) - dt)) > 1e-6 * max(1.0, dt):
        sys.exit("Trace time step is not uniform; resample before checking.")
    signals = {n: data[n] for n in data.dtype.names if n != "t"}

    _, reqs = load_requirements(a.requirements)
    req = next((r for r in reqs if r.id == a.req_id), None)
    if req is None or not req.computable:
        sys.exit(f"{a.req_id}: not found or not computable")
    k0 = int(round((a.at - t[0]) / dt))
    rho = stl.robustness(req.formula, {k: v[k0:] for k, v in signals.items()}, dt)
    verdict = "PASS" if rho > 0 else "FAIL"
    print(f"{req.id}: {verdict}  margin {rho:+.3f} ({rho / req.threshold:+.1%} of limit)")
    return 0 if rho > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
