"""
Mutation testing for the oracle set: seed known defects into the design and
check that at least one requirement catches each one. A surviving mutant means
either the defect is harmless inside the envelopes we test, or the oracle set
has a gap. Either way a human has to look at it.
"""
from __future__ import annotations

from dataclasses import dataclass

from .falsify import falsify
from .oracle import Requirement
from .plant import Design


def mutants(base: Design) -> list[tuple[str, str, dict]]:
    """Seeded defects, each a plausible real-world fault, expressed against `base`."""
    return [
        ("M1", "Worn bearings: running friction x2",      dict(run_friction_20c=base.run_friction_20c * 2)),
        ("M2", "Firmware regression: integrator disabled", dict(ki=0.0)),
        ("M3", "Undersized motor: peak torque -30%",       dict(tau_max_nom=base.tau_max_nom * 0.7)),
        ("M4", "Assembly error: mass imbalance x3",        dict(imbalance=base.imbalance * 3)),
        ("M5", "Wrong tuning file: loop gains halved",     dict(kp=base.kp * 0.5, kd=base.kd * 0.5)),
        ("M6", "Backup encoder noise x4",                  dict(encB_noise_urad=base.encB_noise_urad * 4)),
    ]


@dataclass
class MutantResult:
    id: str
    description: str
    killed: bool
    killed_by: list          # requirement ids that failed
    worst: dict              # req id -> worst normalized margin found


def run_mutants(reqs: list[Requirement], base: Design, budget: dict | None = None,
                ids: list[str] | None = None) -> list[MutantResult]:
    budget = budget or {}
    results = []
    for mid, desc, change in mutants(base):
        if ids and mid not in ids:
            continue
        design = base.mutate(**change)
        worst, killers = {}, []
        for r in reqs:
            if not r.computable:
                continue
            fid = "high" if r.escalate_below > 0 else "low"   # analytic models ignore fidelity
            s = falsify(r, design, fid, **budget)
            worst[r.id] = s.worst_margin
            if s.falsified:
                killers.append(r.id)
        results.append(MutantResult(mid, desc, bool(killers), killers, worst))
    return results
