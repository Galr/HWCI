"""
Falsification: search the requirement's scenario envelope for the case that
minimises robustness (i.e. tries hardest to break the design).

Strategy: Latin-hypercube sweep for breadth, then Nelder-Mead from the worst
few points for depth. Every evaluation is logged so coverage can be measured.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import minimize
from scipy.stats import qmc

from .oracle import INT_PARAMS, Requirement, evaluate
from .plant import Design


@dataclass
class SearchResult:
    req_id: str
    fidelity: str
    worst_params: dict
    worst_rho: float
    worst_margin: float
    evaluations: int
    history: list = field(default_factory=list)   # (params, rho)
    coverage: float = 0.0
    bins: int = 3

    @property
    def falsified(self) -> bool:
        return self.worst_rho < 0


def _to_params(req: Requirement, u: np.ndarray) -> dict:
    out = {}
    for (name, (lo, hi)), x in zip(req.envelope.items(), np.clip(u, 0, 1)):
        v = float(lo + x * (hi - lo))
        out[name] = int(round(v)) if name in INT_PARAMS else v
    return out


def binned_coverage(req: Requirement, history: list, bins: int = 3) -> float:
    """Share of envelope cells (bins per parameter) that hold at least one evaluated scenario."""
    names = list(req.envelope)
    seen = set()
    for params, _ in history:
        cell = []
        for n in names:
            lo, hi = req.envelope[n]
            x = (params[n] - lo) / (hi - lo) if hi > lo else 0.0
            cell.append(min(bins - 1, int(x * bins)))
        seen.add(tuple(cell))
    return len(seen) / bins ** len(names)


def falsify(req: Requirement, design: Design, fidelity: str = "high",
            n_sweep: int = 60, n_local: int = 3, local_evals: int = 40,
            seed: int = 1) -> SearchResult:
    history = []

    def f(u):
        params = _to_params(req, u)
        rho = evaluate(req, design, params, fidelity)
        history.append((params, rho))
        return rho

    dim = len(req.envelope)
    sweep = qmc.LatinHypercube(d=dim, seed=seed).random(n_sweep)
    rhos = [f(u) for u in sweep]

    starts = sweep[np.argsort(rhos)[:n_local]]
    for u0 in starts:
        minimize(f, u0, method="Nelder-Mead",
                 options={"maxfev": local_evals, "xatol": 1e-3, "fatol": 1e-3,
                          "initial_simplex": _simplex(u0, 0.08)})

    worst_params, worst_rho = min(history, key=lambda h: h[1])
    return SearchResult(req.id, fidelity, worst_params, worst_rho, worst_rho / req.threshold,
                        len(history), history, binned_coverage(req, history))


def _simplex(u0: np.ndarray, step: float) -> np.ndarray:
    pts = [u0]
    for i in range(len(u0)):
        p = u0.copy()
        p[i] = p[i] + step if p[i] + step <= 1 else p[i] - step
        pts.append(p)
    return np.array(pts)
