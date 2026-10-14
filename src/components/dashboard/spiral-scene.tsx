'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The sign-in screen's motion graphic (owner, 2026-10-14: "3D animate it", "use motion graphic"):
 * the four-turn APX spiral rendered live in WebGL (three.js), so it is crisp at every size.
 *
 * Intro: the ribbon grows from the bottom turn to the top (a clipping plane rising through it)
 * while it swings into place; the data core inside — three small bar charts and a rising growth
 * line with its nodes — builds after it; the four labels, one per turn from the bottom (Analyse,
 * Plan, Execute, Grow), slide in one after another. Then a calm loop: a slow turn about its axis,
 * a gentle float, the bars breathing, and a slight parallax with the pointer.
 *
 * Only from `lg`, with WebGL, and not under "reduce motion": everyone else keeps the still image
 * (`onReady` is never called). Paused while the tab is hidden; disposed on unmount.
 */

const TURNS = 4;
const LABELS = ['Analyse', 'Plan', 'Execute', 'Grow'] as const;
/** Where the spiral's axis sits across the screen, as a fraction of the width. */
const AXIS_X = 0.665;

interface Label {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export function SpiralScene({ onReady }: { onReady: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [labels, setLabels] = useState<readonly Label[]>([]);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    if (!window.matchMedia('(min-width: 64rem)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') ?? probe.getContext('webgl'))) return;

    let disposed = false;
    let frame = 0;
    const timers: number[] = [];
    let cleanup = () => {};

    (async () => {
      const THREE = await import('three');
      const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 0.95;
      renderer.localClippingEnabled = true;

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.3;

      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      camera.position.set(0, 0, 13);

      // ---- The ribbon: a rounded band wound round a cylinder, four turns ---------------------------
      // Built by hand rather than with ExtrudeGeometry: its swept frames twist freely along a helix,
      // which laid the band flat like a staircase. Here every cross-section uses the true outward
      // direction and the helix's own slope, so the band always faces out, as in the still.
      const RADIUS = 1.05;
      const HEIGHT = 5.2;
      const STEPS = 1100;
      const THICK = 0.34; // radial
      const WIDE = 0.76; // along the axis
      const CORNER = 0.165;
      // The rounded-rectangle cross-section, as (radial, axial) points, anticlockwise.
      const section: [number, number][] = [];
      const arc = (cx: number, cy: number, from: number) => {
        for (let k = 0; k <= 9; k++) {
          const a = from + (k / 9) * (Math.PI / 2);
          section.push([cx + CORNER * Math.cos(a), cy + CORNER * Math.sin(a)]);
        }
      };
      arc(THICK / 2 - CORNER, -WIDE / 2 + CORNER, -Math.PI / 2);
      arc(THICK / 2 - CORNER, WIDE / 2 - CORNER, 0);
      arc(-THICK / 2 + CORNER, WIDE / 2 - CORNER, Math.PI / 2);
      arc(-THICK / 2 + CORNER, -WIDE / 2 + CORNER, Math.PI);
      const ring = section.length;
      const pitch = HEIGHT / TURNS;
      const slope = Math.atan2(pitch, 2 * Math.PI * RADIUS);
      const vertices: number[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const ang = t * TURNS * Math.PI * 2 - Math.PI / 2;
        const out = [Math.cos(ang), 0, Math.sin(ang)];
        // The band's "up": the axis tilted by the helix's slope, so the band follows its own climb.
        const tan = [-Math.sin(ang), 0, Math.cos(ang)];
        const up = [-tan[0]! * Math.sin(slope), Math.cos(slope), -tan[2]! * Math.sin(slope)];
        const cx = RADIUS * out[0]!;
        const cy = (t - 0.5) * HEIGHT;
        const cz = RADIUS * out[2]!;
        for (const [rx, ay] of section) {
          vertices.push(cx + out[0]! * rx + up[0]! * ay, cy + out[1]! * rx + up[1]! * ay, cz + out[2]! * rx + up[2]! * ay);
        }
      }
      const indices: number[] = [];
      for (let i = 0; i < STEPS; i++) {
        for (let k = 0; k < ring; k++) {
          const a0 = i * ring + k;
          const a1 = i * ring + ((k + 1) % ring);
          const b0 = (i + 1) * ring + k;
          const b1 = (i + 1) * ring + ((k + 1) % ring);
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
      // Close both ends with a fan round the section's centre.
      for (const end of [0, STEPS]) {
        const centre = vertices.length / 3;
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < ring; k++) {
          x += vertices[(end * ring + k) * 3]!; y += vertices[(end * ring + k) * 3 + 1]!; z += vertices[(end * ring + k) * 3 + 2]!;
        }
        vertices.push(x / ring, y / ring, z / ring);
        for (let k = 0; k < ring; k++) {
          const a0 = end * ring + k;
          const a1 = end * ring + ((k + 1) % ring);
          if (end === 0) indices.push(centre, a1, a0); else indices.push(centre, a0, a1);
        }
      }
      const ribbonGeo = new THREE.BufferGeometry();
      ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      ribbonGeo.setIndex(indices);
      ribbonGeo.computeVertexNormals();

      // The APX gradient along the height: crimson at the bottom turn to bright orange at the top.
      const stops = [
        [0, new THREE.Color('#8f0828')],
        [0.3, new THREE.Color('#e3163f')],
        [0.62, new THREE.Color('#ff4a2c')],
        [1, new THREE.Color('#ff8a26')],
      ] as const;
      const pos = ribbonGeo.getAttribute('position');
      const colours = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const t = THREE.MathUtils.clamp((pos.getY(i) + HEIGHT / 2) / HEIGHT, 0, 1);
        let k = 0;
        while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
        const [t0, c0] = stops[k]!;
        const [t1, c1] = stops[k + 1]!;
        c.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
        colours.set([c.r, c.g, c.b], i * 3);
      }
      ribbonGeo.setAttribute('color', new THREE.BufferAttribute(colours, 3));

      // The intro's rising plane: everything above it is clipped away until it reaches the top.
      const reveal = new THREE.Plane(new THREE.Vector3(0, -1, 0), -HEIGHT / 2 - 0.6);
      const ribbonMat = new THREE.MeshPhysicalMaterial({
        vertexColors: true, roughness: 0.55, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.6,
        sheen: 0.25, sheenRoughness: 0.7, sheenColor: new THREE.Color('#ff9a6a'), clippingPlanes: [reveal],
        // Both faces, so the end caps show whichever way they wind.
        side: THREE.DoubleSide,
      });
      const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);

      // ---- The data core: bar charts, a growth line with nodes, faint grid ------------------------
      const core = new THREE.Group();
      const glowMat = (opacity: number) => new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ff8a3d'), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const bars: { mesh: InstanceType<typeof THREE.Mesh>; target: number; delay: number }[] = [];
      [-1.55, 0.05, 1.6].forEach((baseY, g) => {
        [0.32, 0.5, 0.66, 0.86].forEach((h, b) => {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1, 0.04), glowMat(0.42));
          mesh.position.set(-0.02 + b * 0.17, baseY, -0.25);
          mesh.userData.base = baseY;
          mesh.scale.y = 0.0001;
          core.add(mesh);
          bars.push({ mesh, target: h * 0.75, delay: 1.25 + g * 0.35 + b * 0.08 });
        });
      });
      const linePoints = [
        new THREE.Vector3(-0.55, -2.1, -0.15), new THREE.Vector3(-0.3, -1.45, -0.18), new THREE.Vector3(-0.1, -0.7, -0.2),
        new THREE.Vector3(0.12, 0.1, -0.22), new THREE.Vector3(0.3, 0.95, -0.24), new THREE.Vector3(0.5, 1.9, -0.26),
      ];
      const lineCurve = new THREE.CatmullRomCurve3(linePoints);
      const lineGeo = new THREE.TubeGeometry(lineCurve, 240, 0.014, 8, false);
      const lineIndexCount = lineGeo.index!.count;
      lineGeo.setDrawRange(0, 0);
      core.add(new THREE.Mesh(lineGeo, glowMat(0.95)));
      const nodes = linePoints.map((p) => {
        const node = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), glowMat(1));
        node.position.copy(p);
        node.scale.setScalar(0.0001);
        core.add(node);
        return node;
      });
      const gridPositions: number[] = [];
      for (let i = -3; i <= 3; i++) gridPositions.push(i * 0.14, -HEIGHT / 2, -0.4, i * 0.14, HEIGHT / 2, -0.4);
      const gridGeo = new THREE.BufferGeometry();
      gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPositions, 3));
      const gridMat = new THREE.LineBasicMaterial({ color: new THREE.Color('#ff7a3a'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      core.add(new THREE.LineSegments(gridGeo, gridMat));

      // A soft warm glow behind the core.
      const glowCanvas = document.createElement('canvas');
      glowCanvas.width = glowCanvas.height = 256;
      const g2d = glowCanvas.getContext('2d')!;
      const grad = g2d.createRadialGradient(128, 128, 0, 128, 128, 128);
      grad.addColorStop(0, 'rgba(255,110,50,0.55)');
      grad.addColorStop(0.45, 'rgba(255,60,60,0.18)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g2d.fillStyle = grad;
      g2d.fillRect(0, 0, 256, 256);
      const glowTex = new THREE.CanvasTexture(glowCanvas);
      glowTex.colorSpace = THREE.SRGBColorSpace;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.set(3.4, 6.4, 1);
      glow.position.z = -0.9;

      const spiral = new THREE.Group();
      spiral.add(glow, core, ribbon);
      spiral.rotation.z = -0.06;
      scene.add(spiral);

      // ---- Light: a warm key from the upper left, an orange rim from behind, a little fill -------
      const key = new THREE.DirectionalLight(new THREE.Color('#fff1e6'), 1.6);
      key.position.set(-4, 5, 6);
      const rim = new THREE.DirectionalLight(new THREE.Color('#ff7a3a'), 2.0);
      rim.position.set(5, 2, -5);
      const fill = new THREE.DirectionalLight(new THREE.Color('#ff3366'), 0.6);
      fill.position.set(2, -4, 4);
      scene.add(key, rim, fill, new THREE.AmbientLight(new THREE.Color('#ffffff'), 0.12));

      // ---- Layout: the axis at AXIS_X of the width, the spiral filling ~88% of the height --------
      const turnHeights = LABELS.map((_, i) => ((i + 0.5) / TURNS - 0.5) * HEIGHT);
      let scale = 1;
      const layout = () => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w < 600 || h < 300) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        const viewH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
        const viewW = viewH * camera.aspect;
        scale = (viewH * 0.88) / (HEIGHT + 0.9);
        spiral.scale.setScalar(scale);
        spiral.position.x = (AXIS_X - 0.5) * viewW;
        // Labels to the right of each turn, projected into CSS pixels.
        const v = new THREE.Vector3();
        setLabels(LABELS.map((text, i) => {
          v.set(spiral.position.x + (RADIUS + 0.62) * scale, turnHeights[i]! * scale, 0).project(camera);
          return { text, x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
        }));
      };
      layout();
      // Re-measure whenever the canvas changes size — including its first real size, which may land
      // after this runs (the labels were once placed against a not-yet-sized canvas).
      const observer = new ResizeObserver(() => layout());
      observer.observe(el);
      const onResize = () => layout();
      window.addEventListener('resize', onResize);

      // Pointer parallax.
      const pointer = { x: 0, y: 0 };
      const onMove = (e: PointerEvent) => {
        pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
      };
      window.addEventListener('pointermove', onMove);

      const ease = (x: number) => 1 - Math.pow(1 - THREE.MathUtils.clamp(x, 0, 1), 3);
      const start = performance.now();
      let last = start;
      let spin = 0;
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        // Hidden below `lg` (the still shows instead): don't spend the GPU on it.
        if (el.clientWidth === 0) return;
        const t = (now - start) / 1000;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        // Intro: the ribbon grows upwards and swings into place.
        reveal.constant = -HEIGHT / 2 - 0.6 + ease(t / 2.4) * (HEIGHT + 1.4);
        reveal.constant *= scale;
        reveal.constant += spiral.position.y;
        const swing = (1 - ease(t / 2.6)) * -0.9;
        spin += dt * 0.16 * ease((t - 1.8) / 1.5);
        spiral.rotation.y = swing + spin;
        spiral.position.y = Math.sin(t * 0.55) * 0.06 * ease((t - 2) / 1);

        // The data core builds after the ribbon, then breathes.
        for (const { mesh, target, delay } of bars) {
          const grow = ease((t - delay) / 0.7);
          const breathe = 1 + Math.sin(t * 1.3 + delay * 3) * 0.06 * ease((t - delay - 0.7) / 1);
          mesh.scale.y = Math.max(0.0001, target * grow * breathe);
          // Bars grow up from their base line.
          mesh.position.y = (mesh.userData.base as number) + mesh.scale.y / 2;
        }
        lineGeo.setDrawRange(0, Math.floor(lineIndexCount * ease((t - 1.6) / 1.4) / 3) * 3);
        nodes.forEach((n, i) => n.scale.setScalar(Math.max(0.0001, ease((t - 1.75 - i * 0.22) / 0.4))));
        gridMat.opacity = 0.12 * ease((t - 1.2) / 1.2);
        (glow.material as InstanceType<typeof THREE.SpriteMaterial>).opacity = ease((t - 0.8) / 1.6) * (0.9 + Math.sin(t * 0.9) * 0.1);

        // Parallax: the camera leans a little towards the pointer.
        camera.position.x += (pointer.x * 0.35 - camera.position.x) * 0.04;
        camera.position.y += (-pointer.y * 0.25 - camera.position.y) * 0.04;
        camera.lookAt(0, 0, 0);

        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(tick);
      onReady();
      LABELS.forEach((_, i) => timers.push(window.setTimeout(() => setShown(i + 1), 1500 + i * 280)));

      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener('resize', onResize);
        window.removeEventListener('pointermove', onMove);
        scene.traverse((o) => {
          const mesh = o as InstanceType<typeof THREE.Mesh>;
          mesh.geometry?.dispose?.();
          const m = mesh.material as InstanceType<typeof THREE.Material> | InstanceType<typeof THREE.Material>[] | undefined;
          if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
        });
        glowTex.dispose();
        pmrem.dispose();
        renderer.dispose();
      };
    })();

    return () => {
      disposed = true;
      timers.forEach((id) => window.clearTimeout(id));
      cleanup();
    };
  }, [onReady]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 hidden lg:block">
      <canvas ref={canvas} className="size-full" />
      {labels.map((label, i) => (
        <span
          key={label.text}
          className="absolute flex -translate-y-1/2 items-center gap-3 transition-[opacity,transform] duration-700 ease-out"
          style={{
            left: label.x,
            top: label.y,
            opacity: shown > i ? 1 : 0,
            transform: `translate(${shown > i ? 0 : 18}px, -50%)`,
          }}
        >
          <span className="h-px w-8 bg-white/50" />
          <span className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold tracking-[0.3em] text-white uppercase drop-shadow-[0_1px_4px_rgb(0_0_0/0.6)]">{label.text}</span>
            <span className="h-1 w-11 rounded-full bg-brand-gradient" />
          </span>
        </span>
      ))}
    </div>
  );
}
