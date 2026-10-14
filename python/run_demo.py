"""
End-to-end demo of "CI for hardware" on a synthetic EO gimbal.

Stage 1  Design-point review      - what a traditional review checks (one nominal case per requirement)
Stage 2  Falsification             - search each requirement's envelope for the worst case
Stage 3  Fix and re-run            - apply a design change, confirm with two independent search seeds
Stage 4  Mutation testing          - seed known defects, check the oracle set catches each one

Outputs go to ./results: results.json, report.html, and two figures.
Run:  python run_demo.py            (about 3-5 minutes on 2 cores)
"""
from __future__ import annotations

import base64
import html as htmlmod
import json
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from hwci import plant
from hwci.falsify import falsify
from hwci.mutate import mutants, run_mutants
from hwci.oracle import load_requirements, run_oracle

OUT = Path(__file__).parent / "results"
REQS_FILE = Path(__file__).parent / "requirements.yaml"

V30 = plant.Design()                 # as generated
V31 = plant.Design(ki=1200.0)        # after the fix proposed from stage 2

# Reference chart palette (validated categorical slots 1-3, light mode)
C_NOM, C_WORST, C_LOW = "#2a78d6", "#eb6834", "#1baf7a"
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fidelity_for(r):
    return "high" if r.escalate_below > 0 else "low"


def search_summary(s):
    return dict(req=s.req_id, fidelity=s.fidelity, worst_margin=round(s.worst_margin, 3),
                worst_rho=round(s.worst_rho, 3), evaluations=s.evaluations,
                coverage=round(s.coverage, 3),
                worst_params={k: round(v, 2) for k, v in s.worst_params.items()})


def _mutant_job(args):
    mid, reqs, base = args
    return run_mutants(reqs, base, ids=[mid])[0]


# ---------------------------------------------------------------- figures
def _style(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(INK2)
        ax.spines[s].set_linewidth(0.8)
    ax.tick_params(colors=INK2, labelsize=9)
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def fig_traces(r2, worst_params, path):
    sc_nom = r2.scenario(r2.nominal)
    sc_w = r2.scenario(worst_params)
    nom = plant.simulate_shock(V30, sc_nom, "high", t_post=5.45)
    wh = plant.simulate_shock(V30, sc_w, "high", t_post=5.45)
    wl = plant.simulate_shock(V30, sc_w, "low", t_post=5.45)

    fig, ax = plt.subplots(figsize=(8.6, 4.4), dpi=150)
    _style(ax)
    ax.axvspan(0, 0.4, color="#f1efe8", zorder=0)
    ax.text(0.43, 1400, "◄ recovery window (0.4 s)", ha="left", va="top", fontsize=8.5, color=INK2)
    floor = 0.3
    for tr, c, lab in [(wl, C_LOW, "Same worst case, low-fidelity model"),
                       (nom, C_NOM, "Nominal design point"),
                       (wh, C_WORST, "Worst case found, high fidelity")]:
        ax.plot(tr["t"], np.maximum(tr["los_error_urad"], floor), color=c, lw=1.6, label=lab)
    ax.axhline(50, color=INK, lw=1.0, ls=(0, (5, 3)))
    ax.text(2.48, 56, "limit 50 µrad", ha="right", va="bottom", fontsize=8.5, color=INK)
    e_end = wh["los_error_urad"][int(round(0.4 / wh["dt"]))]
    ax.annotate(f"{e_end:.0f} µrad at 0.4 s: fails", (0.4, e_end), xytext=(40, 28),
                textcoords="offset points", fontsize=8.5, color=INK,
                arrowprops=dict(arrowstyle="-", color=INK2, lw=0.7))
    ax.set_yscale("log")
    ax.set_ylim(floor, 2000)
    ax.set_xlim(0, 2.5)
    ax.set_xlabel("Time after shock start (s)", color=INK2, fontsize=9.5)
    ax.set_ylabel("Line-of-sight error (µrad, log)", color=INK2, fontsize=9.5)
    ax.legend(loc="center right", frameon=False, fontsize=8.5, labelcolor=INK)
    ax.set_title("R2 shock recovery, design v3.0 (first 2.5 s of the 5.4 s check)", loc="left", fontsize=11, color=INK)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def fig_search(hist_hi, hist_lo, worst, path):
    fig, ax = plt.subplots(figsize=(8.6, 4.0), dpi=150)
    _style(ax)
    t_lo = [p["temp_c"] for p, _ in hist_lo]
    m_lo = [r / 50 for _, r in hist_lo]
    t_hi = [p["temp_c"] for p, _ in hist_hi]
    m_hi = [r / 50 for _, r in hist_hi]
    ax.scatter(t_lo, m_lo, s=16, color=C_LOW, edgecolor="white", linewidth=0.6,
               label="Low-fidelity search (surrogate only)", zorder=2)
    ax.scatter(t_hi, m_hi, s=16, color=C_NOM, edgecolor="white", linewidth=0.6,
               label="High-fidelity search", zorder=3)
    wp, wr = worst
    ax.scatter([wp["temp_c"]], [wr / 50], s=70, color=C_WORST, edgecolor="white", linewidth=1.2,
               zorder=4, label="Worst case found")
    ax.annotate(f"fails: {wp['shock_g']:.0f} g, {wp['shock_ms']:.0f} ms, {wp['temp_c']:.0f} °C,\n"
                f"battery {wp['battery']:.2f}", (wp["temp_c"], wr / 50), xytext=(22, -38),
                textcoords="offset points", fontsize=8.5, color=INK,
                arrowprops=dict(arrowstyle="-", color=INK2, lw=0.7))
    ax.axhline(0, color=INK, lw=1.0)
    ax.text(70, 0.02, "pass / fail boundary", ha="right", va="bottom", fontsize=8.5, color=INK)
    ax.set_xlabel("Temperature in scenario (°C)", color=INK2, fontsize=9.5)
    ax.set_ylabel("Margin (fraction of limit)", color=INK2, fontsize=9.5)
    ax.set_ylim(-0.15, 1.0)
    ax.legend(loc="upper left", frameon=False, fontsize=8.5, labelcolor=INK, ncol=3,
              bbox_to_anchor=(0, 1.13))
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


# ------------------------------------------------------------------- report
def badge(verdict):
    cls = {"PASS": "ok", "FAIL": "bad", "HUMAN_REVIEW": "warn"}[verdict]
    sym = {"PASS": "✓", "FAIL": "✗", "HUMAN_REVIEW": "◐"}[verdict]
    label = {"HUMAN_REVIEW": "HUMAN REVIEW"}.get(verdict, verdict)
    return f'<span class="b {cls}">{sym} {label}</span>'


CAUGHT = '<span class="b ok">✓ caught</span>'
SURVIVED = '<span class="b warn">◐ survived</span>'


def pct(x):
    return f"{x * 100:+.0f}%" if x is not None else "—"


def write_report(R, path, figs):
    img = {k: base64.b64encode(Path(v).read_bytes()).decode() for k, v in figs.items()}
    reqs = {r["id"]: r for r in R["requirements"]}

    def params(p):
        return ", ".join(f"{k}={v}" for k, v in p.items())

    s1 = "".join(
        f"<tr><td><b>{o['req_id']}</b><br><span class=m>{htmlmod.escape(reqs[o['req_id']]['title'])}</span></td>"
        f"<td>{badge(o['verdict'])}</td><td class=n>{pct(o['margin'])}</td>"
        f"<td>{o['fidelity'] or '—'}{' (escalated)' if o['escalated'] else ''}</td></tr>"
        for o in R["stage1_nominal_v30"])

    def search_rows(rows):
        return "".join(
            f"<tr><td><b>{s['req']}</b></td><td>{badge('PASS' if s['worst_margin'] > 0 else 'FAIL')}</td>"
            f"<td class=n>{pct(s['worst_margin'])}</td><td>{s['fidelity']}</td><td class=n>{s['evaluations']}</td>"
            f"<td class=n>{s['coverage'] * 100:.0f}%</td><td class=m>{params(s['worst_params'])}</td></tr>"
            for s in rows)

    mut = "".join(
        f"<tr><td><b>{m['id']}</b></td><td>{htmlmod.escape(m['description'])}</td>"
        f"<td>{CAUGHT if m['killed'] else SURVIVED}</td>"
        f"<td>{', '.join(m['killed_by']) or '—'}</td>"
        f"<td class=m>{', '.join(f'{k[:2]} {pct(v)}' for k, v in m['worst'].items())}</td></tr>"
        for m in R["stage4_mutants_v31"])
    n_killed = sum(m["killed"] for m in R["stage4_mutants_v31"])
    n_mut = len(R["stage4_mutants_v31"])
    r2lo = next(s for s in R["stage2_search_v30"] if s["req"].startswith("R2") and s["fidelity"] == "low")
    r2hi = next(s for s in R["stage2_search_v30"] if s["req"].startswith("R2") and s["fidelity"] == "high")

    html = f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Hardware CI Report</title>
<style>
:root{{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#e4e3df;--card:#f5f4f1;
--ok:#0f6e56;--okbg:#e1f5ee;--bad:#a32d2d;--badbg:#fcebeb;--warn:#854f0b;--warnbg:#faeeda}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#3a3a37;--card:#232321;
--ok:#9fe1cb;--okbg:#04342c;--bad:#f7c1c1;--badbg:#501313;--warn:#fac775;--warnbg:#412402}}
img{{background:#fcfcfb;border-radius:8px}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}}
main{{max-width:980px;margin:0 auto;padding:28px 16px 60px}}
h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:18px;margin:36px 0 6px}}
.sub,.m{{color:var(--ink2)}} .m{{font-size:13px}}
.lead{{background:var(--card);border-radius:12px;padding:14px 18px;margin:18px 0}}
.wrap{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}}
th,td{{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
th{{color:var(--ink2);font-weight:500;font-size:13px}} td.n{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.b{{display:inline-block;padding:1px 8px;border-radius:6px;font-size:12.5px;font-weight:600;white-space:nowrap}}
.ok{{background:var(--okbg);color:var(--ok)}} .bad{{background:var(--badbg);color:var(--bad)}} .warn{{background:var(--warnbg);color:var(--warn)}}
img{{max-width:100%;height:auto;display:block;margin:10px 0}} code{{font-size:13px}}
</style></head><body><main>
<h1>Hardware CI report: EO gimbal (synthetic demo)</h1>
<div class=sub>Generated {R['generated']} · {R['runtime_s']:.0f} s total · all numbers illustrative, from a synthetic model</div>

<div class=lead><b>Bottom line.</b> Design v3.0 passes every check at its nominal design point, and a
search using only the fast low-fidelity model would have certified it (worst margin {pct(r2lo['worst_margin'])}).
The high-fidelity search found a shock-recovery failure (margin {pct(r2hi['worst_margin'])}) at
{params(r2hi['worst_params'])}: in the cold, seal stiction holds the line of sight just outside the limit.
Raising the integral gain (v3.1) restores a {pct(min(s['worst_margin'] for s in R['stage3_search_v31'] if s['req'].startswith('R2')))} worst-case margin, confirmed with two independent search seeds.
Mutation testing caught {n_killed} of {n_mut} seeded defects; the survivor points to a gap in the requirement set, not in the design.</div>

<h2>1 · Design-point review, v3.0</h2>
<div class=m>One nominal scenario per requirement, the way a traditional review works. Fidelity policy: screen at low fidelity, escalate to high when the margin is thin.</div>
<div class=wrap><table><tr><th>Requirement</th><th>Verdict</th><th>Margin</th><th>Fidelity</th></tr>{s1}</table></div>

<h2>2 · Worst-case search, v3.0</h2>
<div class=m>Latin-hypercube sweep plus local refinement over each requirement's envelope. Coverage = share of a 3-bin-per-parameter grid touched by at least one scenario.</div>
<div class=wrap><table><tr><th>Requirement</th><th>Worst verdict</th><th>Worst margin</th><th>Fidelity</th><th class=n>Runs</th><th class=n>Coverage</th><th>Worst scenario</th></tr>{search_rows(R['stage2_search_v30'])}</table></div>
<img alt="R2 margins across the scenario search, plotted against temperature" src="data:image/png;base64,{img['search']}">
<img alt="Line-of-sight error after shock for the nominal case and the worst case found" src="data:image/png;base64,{img['traces']}">
<div class=m>The low-fidelity model has no stick-slip friction, so it predicts a smooth decay. The high-fidelity run shows the error parking above the limit after the shock. This is why the fidelity policy matters: a surrogate-only CI would have passed this design.</div>

<h2>3 · Fix and re-run, v3.1</h2>
<div class=m>Change: integral gain 590 → 1200 N·m/(rad·s). Each requirement searched twice with independent seeds.</div>
<div class=wrap><table><tr><th>Requirement</th><th>Worst verdict</th><th>Worst margin</th><th>Fidelity</th><th class=n>Runs</th><th class=n>Coverage</th><th>Worst scenario</th></tr>{search_rows(R['stage3_search_v31'])}</table></div>

<h2>4 · Mutation testing of the oracle set, v3.1</h2>
<div class=m>Each mutant is v3.1 with one seeded defect. A mutant is caught if any requirement's worst-case search fails it.</div>
<div class=wrap><table><tr><th>ID</th><th>Seeded defect</th><th>Result</th><th>Caught by</th><th>Worst margins</th></tr>{mut}</table></div>
<div class=m>M6 survived with margins unchanged. On this model, stiction masks backup-encoder noise while the gimbal holds a fixed line of sight, which is the only thing R5 tests. Either the defect is harmless, or the requirement set lacks a degraded-mode <i>tracking</i> case (slewing on encoder B). That call belongs to the systems lead.</div>

<h2>5 · Needs a human</h2>
<div class=wrap><table><tr><th>Requirement</th><th>Status</th><th>Why</th></tr>
<tr><td><b>R4_field_maintenance</b></td><td>{badge('HUMAN_REVIEW')}</td><td>{htmlmod.escape(reqs['R4_field_maintenance']['reason'])}</td></tr></table></div>
</main></body></html>"""
    Path(path).write_text(html, encoding="utf-8")


# --------------------------------------------------------------------- main
def main():
    t0 = time.time()
    OUT.mkdir(exist_ok=True)
    system, reqs = load_requirements(str(REQS_FILE))
    comp = [r for r in reqs if r.computable]
    r2 = next(r for r in reqs if r.id.startswith("R2"))
    R = {"system": system, "generated": time.strftime("%Y-%m-%d %H:%M"),
         "designs": {"v3.0": asdict(V30), "v3.1": asdict(V31)},
         "requirements": [{"id": r.id, "title": r.title, "source": r.source, "owner": r.owner,
                           "formula": r.formula, "envelope": r.envelope, "reason": r.reason} for r in reqs]}

    log("Stage 1: design-point review of v3.0")
    R["stage1_nominal_v30"] = [asdict(run_oracle(r, V30)) for r in reqs]

    log("Stage 2: worst-case search on v3.0")
    s2, hist = [], {}
    s = falsify(r2, V30, "low"); s2.append(search_summary(s)); hist["lo"] = s.history
    s = falsify(r2, V30, "high"); s2.append(search_summary(s)); hist["hi"] = s.history
    worst_r2 = (s.worst_params, s.worst_rho)
    for r in comp:
        if r is not r2:
            s2.append(search_summary(falsify(r, V30, fidelity_for(r))))
    R["stage2_search_v30"] = s2

    log("Stage 3: fix applied (v3.1), re-running with two search seeds")
    R["stage3_search_v31"] = [dict(search_summary(falsify(r, V31, fidelity_for(r), seed=sd)), seed=sd)
                              for r in comp for sd in (1, 2)]

    log("Stage 4: mutation testing on v3.1")
    with ProcessPoolExecutor(max_workers=2) as ex:
        res = list(ex.map(_mutant_job, [(m[0], reqs, V31) for m in mutants(V31)]))
    R["stage4_mutants_v31"] = [dict(asdict(m), worst={k: round(v, 3) for k, v in m.worst.items()}) for m in res]

    log("Writing figures and report")
    figs = {"traces": OUT / "fig_r2_traces.png", "search": OUT / "fig_r2_search.png"}
    fig_traces(r2, worst_r2[0], figs["traces"])
    fig_search(hist["hi"], hist["lo"], worst_r2, figs["search"])
    R["runtime_s"] = time.time() - t0
    (OUT / "results.json").write_text(json.dumps(R, indent=2, default=float))
    write_report(R, OUT / "report.html", figs)
    log(f"Done in {R['runtime_s']:.0f} s -> {OUT}")


if __name__ == "__main__":
    main()
