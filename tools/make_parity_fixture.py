"""
Write tests/fixtures/parity.json: reference results from the Python engine for
deterministic scenarios (sensor noise off), used to check the JavaScript port.
Run from the repo root:  python tools/make_parity_fixture.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

from hwci import plant, stl  # noqa: E402

DESIGN = plant.Design(ki=1200.0, enc_noise_urad=0.0, enc_res_urad=1e-6)
FORMULA = "eventually[0, 0.4] ( always[0, 5] los_error_urad < 50 )"
CASES = [
    dict(),
    dict(temp_c=-40),
    dict(temp_c=-22, battery=0.84, shock_g=22, shock_ms=12),
    dict(axis_deg=45, temp_c=71),
    dict(shock_g=18, shock_ms=10, battery=0.8),
]


def main():
    out = {"design": {"ki": 1200.0, "encNoiseUrad": 0.0, "encResUrad": 1e-6}, "formula": FORMULA, "cases": []}
    for c in CASES:
        s = plant.Scenario(**c)
        for fid in ("low", "high"):
            tr = plant.simulate_shock(DESIGN, s, fid, t_post=5.45)
            e = tr["los_error_urad"]
            rho = stl.robustness(FORMULA, {"los_error_urad": e}, tr["dt"])
            out["cases"].append(dict(scenario=c, fidelity=fid, rho=rho, peak=float(e.max()),
                                     e_at_0_4=float(e[int(round(0.4 / tr["dt"]))])))
    cs = plant.simulate_cold_start(plant.Design(), plant.Scenario(temp_c=-40, battery=0.8))
    out["cold_start_min_ratio"] = float(cs["torque_ratio"][: int(30 / cs["dt"]) + 1].min())
    dest = ROOT / "tests" / "fixtures" / "parity.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2))
    print("wrote", dest)


if __name__ == "__main__":
    main()
