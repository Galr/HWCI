"""
Signal Temporal Logic (STL) with quantitative robustness semantics.

A requirement such as

    eventually[0, 1.5] ( always[0, 10] los_error_urad < 50 )

is parsed into a tree and evaluated over sampled signals. The result is not
only pass/fail but a robustness value rho:

    rho > 0  -> requirement satisfied, rho is the margin (in signal units)
    rho < 0  -> requirement violated, |rho| is how badly

Supported grammar
-----------------
    expr      := or_expr
    or_expr   := and_expr ('or' and_expr)*
    and_expr  := unary ('and' unary)*
    unary     := 'not' unary
               | ('always' | 'eventually') '[' num ',' num ']' unary
               | '(' expr ')'
               | atom
    atom      := NAME ('<' | '<=' | '>' | '>=') NUMBER

Time bounds are in seconds and are relative to the evaluation instant.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d


# --------------------------------------------------------------------------- AST
@dataclass
class Atom:
    signal: str
    op: str
    value: float


@dataclass
class Not:
    child: object


@dataclass
class And:
    children: list


@dataclass
class Or:
    children: list


@dataclass
class Temporal:
    kind: str          # 'always' | 'eventually'
    a: float
    b: float
    child: object


# ------------------------------------------------------------------------ parser
_TOKEN = re.compile(r"\s*(<=|>=|<|>|\(|\)|\[|\]|,|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*)")


def _tokenize(text: str) -> list[str]:
    pos, out = 0, []
    text = text.strip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise SyntaxError(f"Unexpected input at: {text[pos:pos + 20]!r}")
        out.append(m.group(1))
        pos = m.end()
    return out


class _Parser:
    def __init__(self, text: str):
        self.toks = _tokenize(text)
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self, expected=None):
        tok = self.peek()
        if tok is None:
            raise SyntaxError("Unexpected end of formula")
        if expected is not None and tok != expected:
            raise SyntaxError(f"Expected {expected!r}, got {tok!r}")
        self.i += 1
        return tok

    def parse(self):
        node = self.or_expr()
        if self.peek() is not None:
            raise SyntaxError(f"Trailing input: {' '.join(self.toks[self.i:])}")
        return node

    def or_expr(self):
        kids = [self.and_expr()]
        while self.peek() == "or":
            self.take()
            kids.append(self.and_expr())
        return kids[0] if len(kids) == 1 else Or(kids)

    def and_expr(self):
        kids = [self.unary()]
        while self.peek() == "and":
            self.take()
            kids.append(self.unary())
        return kids[0] if len(kids) == 1 else And(kids)

    def unary(self):
        tok = self.peek()
        if tok == "not":
            self.take()
            return Not(self.unary())
        if tok in ("always", "eventually"):
            self.take()
            self.take("[")
            a = float(self.take())
            self.take(",")
            b = float(self.take())
            self.take("]")
            if b < a:
                raise SyntaxError(f"Bad interval [{a}, {b}]")
            return Temporal(tok, a, b, self.unary())
        if tok == "(":
            self.take()
            node = self.or_expr()
            self.take(")")
            return node
        name = self.take()
        op = self.take()
        if op not in ("<", "<=", ">", ">="):
            raise SyntaxError(f"Expected comparison after {name!r}, got {op!r}")
        return Atom(name, op, float(self.take()))


def parse(text: str):
    return _Parser(text).parse()


def signals_used(node) -> set[str]:
    if isinstance(node, Atom):
        return {node.signal}
    if isinstance(node, (Not, Temporal)):
        return signals_used(node.child)
    return set().union(*(signals_used(c) for c in node.children))


def horizon(node) -> float:
    """How far into the future (s) the formula looks from the evaluation instant."""
    if isinstance(node, Atom):
        return 0.0
    if isinstance(node, Not):
        return horizon(node.child)
    if isinstance(node, Temporal):
        return node.b + horizon(node.child)
    return max(horizon(c) for c in node.children)


# ---------------------------------------------------------------- robustness
def _robustness(node, sig: dict[str, np.ndarray], dt: float, n: int) -> np.ndarray:
    """Robustness at every sample. NaN where the trace is too short to decide."""
    if isinstance(node, Atom):
        if node.signal not in sig:
            raise KeyError(f"Signal {node.signal!r} not in trace (have: {sorted(sig)})")
        x = np.asarray(sig[node.signal], dtype=float)
        return (node.value - x) if node.op in ("<", "<=") else (x - node.value)
    if isinstance(node, Not):
        return -_robustness(node.child, sig, dt, n)
    if isinstance(node, And):
        return np.min([_robustness(c, sig, dt, n) for c in node.children], axis=0)
    if isinstance(node, Or):
        return np.max([_robustness(c, sig, dt, n) for c in node.children], axis=0)
    if isinstance(node, Temporal):
        child = _robustness(node.child, sig, dt, n)
        ia, ib = int(round(node.a / dt)), int(round(node.b / dt))
        w = ib - ia + 1
        nan = np.isnan(child)
        valid = int(np.argmax(nan)) if nan.any() else n   # NaNs only ever form a suffix
        out = np.full(n, np.nan)
        last = valid - 1 - ib                              # last instant whose window fits
        if last >= 0:
            filt = minimum_filter1d if node.kind == "always" else maximum_filter1d
            m = filt(child[:valid], size=w, mode="nearest")  # O(n) sliding min/max (centred)
            t = np.arange(last + 1)
            out[: last + 1] = m[t + ia + w // 2]
        return out
    raise TypeError(node)


def robustness(formula, signals: dict[str, np.ndarray], dt: float, at: float = 0.0) -> float:
    """Robustness of `formula` evaluated at time `at` (seconds)."""
    node = parse(formula) if isinstance(formula, str) else formula
    n = len(next(iter(signals.values())))
    rho = _robustness(node, signals, dt, n)
    k = int(round(at / dt))
    if k >= n or np.isnan(rho[k]):
        need = at + horizon(node)
        raise ValueError(f"Trace too short: formula needs {need:.2f} s, trace has {n * dt:.2f} s")
    return float(rho[k])
