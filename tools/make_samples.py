"""
Generate the two sample STEP files used by the demo and record their exact
mass properties (OpenCascade, via build123d) for the browser-side tests.

  samples/payload_unbalanced.step  camera housing + lens, CG forward of the tilt axis
  samples/payload_balanced.step    same, with a rear counterweight sized to null the imbalance

Tilt axis = X axis through the origin. Units: mm. Run:  python tools/make_samples.py
"""
import json
from pathlib import Path

from build123d import Axis, Box, Cylinder, Pos, Rot, export_step
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp

OUT = Path(__file__).resolve().parent.parent / "samples"


def housing():
    outer = Box(120, 80, 70)                       # x (along axis), y (forward), z (up)
    inner = Box(114, 74, 64)                       # 3 mm walls, sealed void
    lens = Pos(0, 40 + 30, 0) * Rot(90, 0, 0) * Cylinder(25, 60)   # along +Y
    trunnion = Rot(0, 90, 0) * Cylinder(8, 180)    # shaft along X through origin
    pocket = Pos(0, -40, 20) * Box(40, 6, 20)      # connector pocket in the rear wall
    return outer - inner + lens + trunnion - pocket


def counterweight(depth_mm):
    # Rear block, behind the housing (negative Y)
    return Pos(0, -40 - depth_mm / 2, 0) * Box(100, depth_mm, 50)


def props(shape):
    gp = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape.wrapped, gp)
    c = gp.CentreOfMass()
    m = gp.MatrixOfInertia()   # about the centre of mass, density 1
    I = [[m.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)]
    return dict(volume_mm3=gp.Mass(), cg_mm=[c.X(), c.Y(), c.Z()], inertia_cg_mm5=I)


def main():
    OUT.mkdir(exist_ok=True)
    base = housing()
    pb = props(base)
    # Size the counterweight so that first moment about the X axis (in Y) nulls out
    lo, hi = 1.0, 60.0
    for _ in range(50):
        d = 0.5 * (lo + hi)
        p = props(base + counterweight(d))
        if p["cg_mm"][1] > 0:
            lo = d
        else:
            hi = d
    bal = base + counterweight(d)
    export_step(base, str(OUT / "payload_unbalanced.step"))
    export_step(bal, str(OUT / "payload_balanced.step"))
    ref = {"payload_unbalanced.step": pb,
           "payload_balanced.step": dict(props(bal), counterweight_depth_mm=d)}
    (OUT / "reference_massprops.json").write_text(json.dumps(ref, indent=2))
    for k, v in ref.items():
        print(k, round(v["volume_mm3"]), [round(x, 3) for x in v["cg_mm"]])


if __name__ == "__main__":
    main()
