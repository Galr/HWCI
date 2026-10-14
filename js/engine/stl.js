// Signal Temporal Logic with quantitative robustness semantics.
//
//   eventually[0, 0.4] ( always[0, 5] los_error_urad < 50 )
//
// Robustness rho > 0 means satisfied with margin rho (signal units),
// rho < 0 means violated by |rho|. Grammar:
//
//   expr     := or
//   or       := and ('or' and)*
//   and      := unary ('and' unary)*
//   unary    := 'not' unary
//             | ('always' | 'eventually') '[' num ',' num ']' unary
//             | '(' expr ')'
//             | NAME ('<' | '<=' | '>' | '>=') NUMBER
//
// Time bounds are seconds, relative to the evaluation instant.

const TOKEN = /\s*(<=|>=|<|>|\(|\)|\[|\]|,|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_]*)/y;

function tokenize(text) {
  const out = [];
  const s = text.trim();
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m) throw new SyntaxError(`Unexpected input at: "${s.slice(at, at + 20)}"`);
    out.push(m[1]);
  }
  return out;
}

export function parse(text) {
  const toks = tokenize(text);
  let i = 0;
  const peek = () => toks[i];
  const take = (expected) => {
    const t = toks[i];
    if (t === undefined) throw new SyntaxError('Unexpected end of formula');
    if (expected !== undefined && t !== expected) throw new SyntaxError(`Expected "${expected}", got "${t}"`);
    i++;
    return t;
  };
  const num = () => {
    const t = take();
    const v = Number(t);
    if (!Number.isFinite(v)) throw new SyntaxError(`Expected a number, got "${t}"`);
    return v;
  };
  function orExpr() {
    const kids = [andExpr()];
    while (peek() === 'or') { take(); kids.push(andExpr()); }
    return kids.length === 1 ? kids[0] : { type: 'or', children: kids };
  }
  function andExpr() {
    const kids = [unary()];
    while (peek() === 'and') { take(); kids.push(unary()); }
    return kids.length === 1 ? kids[0] : { type: 'and', children: kids };
  }
  function unary() {
    const t = peek();
    if (t === 'not') { take(); return { type: 'not', child: unary() }; }
    if (t === 'always' || t === 'eventually') {
      take(); take('[');
      const a = num(); take(',');
      const b = num(); take(']');
      if (b < a) throw new SyntaxError(`Bad interval [${a}, ${b}]`);
      return { type: t, a, b, child: unary() };
    }
    if (t === '(') { take(); const n = orExpr(); take(')'); return n; }
    const name = take();
    if (!/^[A-Za-z_]/.test(name)) throw new SyntaxError(`Expected a signal name, got "${name}"`);
    const op = take();
    if (!['<', '<=', '>', '>='].includes(op)) throw new SyntaxError(`Expected comparison after "${name}", got "${op}"`);
    return { type: 'atom', signal: name, op, value: num() };
  }
  const node = orExpr();
  if (i < toks.length) throw new SyntaxError(`Trailing input: ${toks.slice(i).join(' ')}`);
  return node;
}

export function signalsUsed(node, acc = new Set()) {
  if (node.type === 'atom') acc.add(node.signal);
  else if (node.child) signalsUsed(node.child, acc);
  else node.children.forEach((c) => signalsUsed(c, acc));
  return acc;
}

/** Seconds the formula looks ahead of the evaluation instant. */
export function horizon(node) {
  switch (node.type) {
    case 'atom': return 0;
    case 'not': return horizon(node.child);
    case 'always': case 'eventually': return node.b + horizon(node.child);
    default: return Math.max(...node.children.map(horizon));
  }
}

// Forward sliding-window min or max over x[t+ia .. t+ib], O(n) with a monotonic deque.
// Only instants whose whole window lies inside the valid prefix get a value; the rest are NaN.
function slide(x, valid, ia, ib, isMin) {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  const last = valid - 1 - ib;
  if (last < 0) return out;
  const dq = new Int32Array(valid);
  let head = 0, tail = 0;
  const better = isMin ? (u, v) => u <= v : (u, v) => u >= v;
  let j = ia; // next index to push
  for (let t = 0; t <= last; t++) {
    const hi = t + ib;
    while (j <= hi) {
      while (tail > head && better(x[j], x[dq[tail - 1]])) tail--;
      dq[tail++] = j++;
    }
    while (dq[head] < t + ia) head++;
    out[t] = x[dq[head]];
  }
  return out;
}

function validLength(x) {
  for (let k = 0; k < x.length; k++) if (Number.isNaN(x[k])) return k;
  return x.length;
}

function rob(node, sig, dt, n) {
  switch (node.type) {
    case 'atom': {
      const x = sig[node.signal];
      if (!x) throw new Error(`Signal "${node.signal}" not in trace (have: ${Object.keys(sig).join(', ')})`);
      const out = new Float64Array(n);
      const lt = node.op === '<' || node.op === '<=';
      for (let k = 0; k < n; k++) out[k] = lt ? node.value - x[k] : x[k] - node.value;
      return out;
    }
    case 'not': {
      const c = rob(node.child, sig, dt, n);
      for (let k = 0; k < n; k++) c[k] = -c[k];
      return c;
    }
    case 'and': case 'or': {
      const kids = node.children.map((c) => rob(c, sig, dt, n));
      const out = new Float64Array(n);
      const f = node.type === 'and' ? Math.min : Math.max;
      for (let k = 0; k < n; k++) {
        let v = kids[0][k];
        for (let q = 1; q < kids.length; q++) v = f(v, kids[q][k]); // NaN propagates
        out[k] = v;
      }
      return out;
    }
    case 'always': case 'eventually': {
      const c = rob(node.child, sig, dt, n);
      const ia = Math.round(node.a / dt), ib = Math.round(node.b / dt);
      return slide(c, validLength(c), ia, ib, node.type === 'always');
    }
    default: throw new TypeError(node.type);
  }
}

/** Robustness at time `at` (seconds). `signals` maps names to arrays sampled every dt. */
export function robustness(formula, signals, dt, at = 0) {
  const node = typeof formula === 'string' ? parse(formula) : formula;
  const n = Object.values(signals)[0].length;
  const r = rob(node, signals, dt, n);
  const k = Math.round(at / dt);
  if (k >= n || Number.isNaN(r[k])) {
    throw new Error(`Trace too short: formula needs ${(at + horizon(node)).toFixed(2)} s, trace has ${(n * dt).toFixed(2)} s`);
  }
  return r[k];
}

/** Robustness at every instant (NaN where undecidable). Useful for plotting margins over time. */
export function robustnessSeries(formula, signals, dt) {
  const node = typeof formula === 'string' ? parse(formula) : formula;
  const n = Object.values(signals)[0].length;
  return rob(node, signals, dt, n);
}
