// 3D viewer: the part, its tilt axis, the CG and the CG offset from the axis.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function cgSprite(size) {
  // Classic engineering CG symbol: a circle with alternating black/white quadrants
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = 56;
  for (let q = 0; q < 4; q++) {
    g.beginPath(); g.moveTo(64, 64);
    g.arc(64, 64, r, (q * Math.PI) / 2, ((q + 1) * Math.PI) / 2);
    g.closePath(); g.fillStyle = q % 2 ? '#ffffff' : '#111111'; g.fill();
  }
  g.lineWidth = 6; g.strokeStyle = '#111111'; g.beginPath(); g.arc(64, 64, r, 0, 2 * Math.PI); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
  s.scale.set(size, size, 1);
  s.renderOrder = 10;
  return s;
}

export class Viewer {
  constructor(container) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8778, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.4, 2);
    this.scene.add(key);
    this.camera.add(new THREE.DirectionalLight(0xffffff, 0.6));
    this.scene.add(this.camera);

    this.part = new THREE.Group();
    this.overlay = new THREE.Group();
    this.scene.add(this.part, this.overlay);
    this.radius = 100;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear(group) {
    for (const o of [...group.children]) {
      group.remove(o);
      o.traverse((x) => { x.geometry?.dispose(); if (x.material) [].concat(x.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); });
    }
  }

  setMeshes(meshes) {
    this.clear(this.part);
    this.clear(this.overlay);
    const body = new THREE.MeshStandardMaterial({ color: css('--model') || '#c9c6bb', metalness: 0.15, roughness: 0.55,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
    const edgeMat = new THREE.LineBasicMaterial({ color: css('--ink') || '#16181a', transparent: true, opacity: 0.55 });
    for (const m of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      if (m.normal) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3)); else g.computeVertexNormals();
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      this.part.add(new THREE.Mesh(g, body));
      this.part.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), edgeMat));
    }
    const box = new THREE.Box3().setFromObject(this.part);
    this.box = box;
    this.radius = box.getBoundingSphere(new THREE.Sphere()).radius || 100;
    this.view('iso');
  }

  /** axis: unit vector, pivot/cg in mm, radial: CG offset vector (mm) perpendicular to the axis */
  setAnnotations({ axis, pivot, cg, radial }) {
    this.clear(this.overlay);
    if (!this.box) return;
    const R = this.radius;
    const a = new THREE.Vector3(...axis).normalize();
    const p = new THREE.Vector3(...pivot);
    const L = R * 1.5;
    const pts = [p.clone().addScaledVector(a, -L), p.clone().addScaledVector(a, L)];
    const axisLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: css('--axis') || '#e0a400', dashSize: R * 0.06, gapSize: R * 0.035, depthTest: false }));
    axisLine.computeLineDistances();
    axisLine.renderOrder = 9;
    this.overlay.add(axisLine);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(R * 0.035, R * 0.1, 20),
      new THREE.MeshBasicMaterial({ color: css('--axis') || '#e0a400', depthTest: false }));
    cone.position.copy(pts[1]);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a);
    cone.renderOrder = 9;
    this.overlay.add(cone);

    const c = new THREE.Vector3(...cg);
    const sprite = cgSprite(0.045);
    sprite.position.copy(c);
    this.overlay.add(sprite);

    const r = new THREE.Vector3(...radial);
    if (r.length() > R * 0.004) {
      const foot = c.clone().sub(r);
      const off = new THREE.Line(new THREE.BufferGeometry().setFromPoints([foot, c]),
        new THREE.LineBasicMaterial({ color: css('--offset') || '#d6336c', depthTest: false, linewidth: 2 }));
      off.renderOrder = 9;
      this.overlay.add(off);
    }
  }

  view(kind) {
    if (!this.box) return;
    const ctr = this.box.getCenter(new THREE.Vector3());
    const d = this.radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05;
    const dirs = { iso: [1, -1.25, 0.9], front: [0, -1, 0], side: [1, 0, 0], top: [0, -0.0001, 1] };
    const v = new THREE.Vector3(...(dirs[kind] || dirs.iso)).normalize();
    this.camera.position.copy(ctr).addScaledVector(v, d);
    this.camera.near = d / 100; this.camera.far = d * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(ctr);
    this.controls.update();
  }

  refreshTheme() {
    this.part.traverse((o) => {
      if (o.isMesh) o.material.color.set(css('--model'));
      if (o.isLineSegments) o.material.color.set(css('--ink'));
    });
  }
}
