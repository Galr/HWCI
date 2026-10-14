"""
Oracle layer: turns an executable requirement + a scenario into
    verdict    PASS / FAIL / HUMAN_REVIEW
    margin     robustness in signal units, and as a fraction of the limit
    confidence which fidelity produced the number, and whether it was escalated
"""
from __future__ import annotations

from dataclasses import dataclass, field

import yaml

from . import plant, stl

# Each model returns {"dt", "t", <signal>: array, ...}; t_need is how long the formula looks ahead
MODELS = {
    "shock_response": lambda d, s, fid, t_need: plant.simulate_shock(d, s, fid, t_post=t_need + 0.05),
    "cold_start": lambda d, s, fid, t_need: plant.simulate_cold_start(d, s, t_end=t_need + 1.0),
}
INT_PARAMS = {"seed"}
BOOL_PARAMS = {"encoder_a_failed"}


@dataclass
class Requirement:
    id: str
    title: str
    source: str = ""
    owner: str = ""
    kind: str = "computable"
    model: str | None = None
    formula: str | None = None
    threshold: float = 1.0
    nominal: dict = field(default_factory=dict)
    envelope: dict = field(default_factory=dict)
    fixed: dict = field(default_factory=dict)
    escalate_below: float = 0.0
    reason: str = ""

    @property
    def computable(self) -> bool:
        return self.kind != "human_review"

    def scenario(self, params: dict) -> plant.Scenario:
        p = {**self.fixed, **params}
        for k in INT_PARAMS & p.keys():
            p[k] = int(round(p[k]))
        for k in BOOL_PARAMS & p.keys():
            p[k] = bool(p[k])
        return plant.Scenario(**p)


@dataclass
class OracleResult:
    req_id: str
    verdict: str                 # PASS | FAIL | HUMAN_REVIEW
    rho: float | None = None     # robustness, signal units
    margin: float | None = None  # rho / threshold
    fidelity: str = ""
    escalated: bool = False
    screen_margin: float | None = None
    params: dict = field(default_factory=dict)
    note: str = ""


def load_requirements(path: str) -> tuple[str, list[Requirement]]:
    with open(path) as f:
        doc = yaml.safe_load(f)
    reqs = []
    for r in doc["requirements"]:
        fid = r.pop("fidelity", {}) or {}
        reqs.append(Requirement(escalate_below=fid.get("escalate_below", 0.0), **r))
    for r in reqs:
        if r.computable:
            stl.parse(r.formula)  # fail fast on syntax errors
            if r.model not in MODELS:
                raise ValueError(f"{r.id}: unknown model {r.model!r}")
    return doc.get("system", ""), reqs


def evaluate(req: Requirement, design: plant.Design, params: dict, fidelity: str) -> float:
    """Raw robustness of one requirement for one scenario at one fidelity."""
    t_need = stl.horizon(stl.parse(req.formula))
    trace = MODELS[req.model](design, req.scenario(params), fidelity, t_need)
    signals = {k: v for k, v in trace.items() if k not in ("dt", "t")}
    return stl.robustness(req.formula, signals, trace["dt"])


def run_oracle(req: Requirement, design: plant.Design, params: dict | None = None,
               policy: str = "escalate") -> OracleResult:
    """
    policy:
      'escalate'    screen at low fidelity, re-run at high fidelity if margin is thin
      'low' / 'high' force a single fidelity
    """
    if not req.computable:
        return OracleResult(req.id, "HUMAN_REVIEW", note=req.reason)
    params = dict(req.nominal if params is None else params)

    if policy in ("low", "high"):
        rho = evaluate(req, design, params, policy)
        return OracleResult(req.id, "PASS" if rho > 0 else "FAIL", rho, rho / req.threshold,
                            policy, params=params)

    rho_lo = evaluate(req, design, params, "low")
    m_lo = rho_lo / req.threshold
    if m_lo >= req.escalate_below and req.escalate_below > 0:
        return OracleResult(req.id, "PASS" if rho_lo > 0 else "FAIL", rho_lo, m_lo,
                            "low", params=params, screen_margin=m_lo)
    if req.escalate_below <= 0:   # single-fidelity model
        return OracleResult(req.id, "PASS" if rho_lo > 0 else "FAIL", rho_lo, m_lo,
                            "analytic", params=params)
    rho_hi = evaluate(req, design, params, "high")
    return OracleResult(req.id, "PASS" if rho_hi > 0 else "FAIL", rho_hi, rho_hi / req.threshold,
                        "high", escalated=True, screen_margin=m_lo, params=params)
