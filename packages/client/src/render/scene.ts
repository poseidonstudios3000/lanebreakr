/**
 * scene — THREE layer. Renders sim state; owns none of it.
 *
 * Art direction per PRD §11: flat-shaded, desaturated concrete/slate, with
 * saturation reserved for the three things that carry meaning — teams, souls,
 * objectives. One directional light, no realtime shadows, blob shadow only.
 * That is not a fallback; at 720p on a stream it is the reason a viewer can
 * read the frame in five seconds (Pillar P4).
 */

import * as THREE from 'three';
import type { Aabb, World, HitEvent } from '@ovrrun/sim';
import { ENTITY, M0 } from '@ovrrun/sim';

const TEAM_A = 0x00e5ff;
const DANGER = 0xff2e88;
const SOUL = 0xffd966;

export class Scene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private targetMeshes: THREE.Mesh[] = [];
  private targetRings: THREE.Mesh[] = [];
  private heroMesh!: THREE.Group;
  private blob!: THREE.Mesh;
  private muzzle!: THREE.PointLight;
  private muzzleQuad!: THREE.Sprite;

  private tracers: { mesh: THREE.Line; life: number }[] = [];
  private sparks: { mesh: THREE.Sprite; life: number; vy: number }[] = [];
  private tracerPool: THREE.Line[] = [];
  private sparkPool: THREE.Sprite[] = [];

  constructor(canvasParent: HTMLElement, world: World) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setClearColor(0x0d1013);
    canvasParent.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(95, innerWidth / innerHeight, 0.05, 400);

    this.scene.fog = new THREE.Fog(0x0d1013, 60, 190);
    this.scene.add(new THREE.AmbientLight(0x5a6b7a, 1.1));
    const sun = new THREE.DirectionalLight(0xdfe9f2, 1.5);
    sun.position.set(-0.4, 1, 0.25);
    this.scene.add(sun);
    const bounce = new THREE.DirectionalLight(0x2a3540, 0.6);
    bounce.position.set(0.5, -1, -0.3);
    this.scene.add(bounce);

    this.buildGeometry(world.map.boxes);
    this.buildZiplines(world);
    this.buildTargets(world);
    this.buildHero();

    this.muzzle = new THREE.PointLight(0xffd9a0, 0, 9, 2);
    this.scene.add(this.muzzle);
    this.muzzleQuad = new THREE.Sprite(
      new THREE.SpriteMaterial({ color: 0xffe0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.muzzleQuad.scale.setScalar(0.5);
    this.scene.add(this.muzzleQuad);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  private buildGeometry(boxes: readonly Aabb[]): void {
    // One merged-material set, three tones by height, so the eye reads
    // floor / cover / wall instantly without any texture work.
    const mats = [
      new THREE.MeshLambertMaterial({ color: 0x2b3138 }), // floor
      new THREE.MeshLambertMaterial({ color: 0x3a424b }), // cover
      new THREE.MeshLambertMaterial({ color: 0x232930 }), // wall
    ];
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x4d5a67, transparent: true, opacity: 0.55 });

    for (const b of boxes) {
      const sx = b.maxX - b.minX, sy = b.maxY - b.minY, sz = b.maxZ - b.minZ;
      if (sx <= 0 || sy <= 0 || sz <= 0) continue;
      const tall = sy > 6;
      const flat = sy < 0.6 || b.maxY <= 0.001;
      const mat = flat ? mats[0]! : tall ? mats[2]! : mats[1]!;

      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
      this.scene.add(mesh);

      // Hard emissive-ish edges. This is what makes flat shading read as
      // deliberate rather than unfinished.
      if (!flat) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
        edges.position.copy(mesh.position);
        this.scene.add(edges);
      }
    }

    // Distance markers at the SMG falloff landmarks, so range is legible.
    for (const d of [18, 40]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(d - 0.06, d + 0.06, 96, 1, 0, Math.PI * 2),
        new THREE.MeshBasicMaterial({ color: d === 18 ? TEAM_A : DANGER, transparent: true, opacity: 0.13, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(-30, 0.02, 0);
      this.scene.add(ring);
    }
  }

  private buildZiplines(world: World): void {
    const mat = new THREE.LineBasicMaterial({ color: SOUL, transparent: true, opacity: 0.5 });
    for (const zl of world.map.ziplines) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(zl.ax, zl.ay, zl.az),
        new THREE.Vector3(zl.bx, zl.by, zl.bz),
      ]);
      this.scene.add(new THREE.Line(g, mat));
      for (const p of [[zl.ax, zl.ay, zl.az], [zl.bx, zl.by, zl.bz]] as const) {
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.12, zl.ay, 8),
          new THREE.MeshLambertMaterial({ color: 0x3a424b }),
        );
        post.position.set(p[0]!, zl.ay / 2, p[2]!);
        this.scene.add(post);
      }
    }
  }

  private buildTargets(world: World): void {
    for (const t of world.state.targets) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(ENTITY.CAPSULE_RADIUS_M, ENTITY.CAPSULE_HEIGHT_M - ENTITY.CAPSULE_RADIUS_M * 2, 4, 10),
        new THREE.MeshLambertMaterial({ color: 0xff6b1f }),
      );
      body.position.y = ENTITY.CAPSULE_HEIGHT_M / 2;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(ENTITY.HEAD_SPHERE_RADIUS_M, 12, 10),
        new THREE.MeshBasicMaterial({ color: DANGER }),
      );
      head.position.y = ENTITY.HEAD_SPHERE_CENTER_M;
      g.add(body, head);
      this.scene.add(g);
      // The group is what we move; keep the mesh handle for visibility toggles.
      this.targetMeshes.push(g as unknown as THREE.Mesh);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.5, 24),
        new THREE.MeshBasicMaterial({ color: SOUL, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      this.scene.add(ring);
      this.targetRings.push(ring);
      void t;
    }
  }

  private buildHero(): void {
    this.heroMesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(ENTITY.CAPSULE_RADIUS_M, ENTITY.CAPSULE_HEIGHT_M - ENTITY.CAPSULE_RADIUS_M * 2, 4, 12),
      new THREE.MeshLambertMaterial({ color: 0x1d6d7d }),
    );
    body.position.y = ENTITY.CAPSULE_HEIGHT_M / 2;
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(ENTITY.HEAD_SPHERE_RADIUS_M * 1.15, 12, 10),
      new THREE.MeshBasicMaterial({ color: TEAM_A }),
    );
    visor.position.set(0, ENTITY.HEAD_SPHERE_CENTER_M, -0.18);
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.12, 0.62),
      new THREE.MeshLambertMaterial({ color: 0x171b1f }),
    );
    gun.position.set(0.19, ENTITY.MUZZLE_HEIGHT_M, -0.3);
    this.heroMesh.add(body, visor, gun);
    this.scene.add(this.heroMesh);

    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.scene.add(this.blob);
  }

  // -------------------------------------------------------------------------

  syncWorld(world: World, heroX: number, heroY: number, heroZ: number, heroYaw: number, hideHero: boolean): void {
    this.heroMesh.position.set(heroX, heroY, heroZ);
    this.heroMesh.rotation.y = heroYaw;
    this.heroMesh.visible = !hideHero;
    this.blob.position.set(heroX, heroY + 0.02, heroZ);
    this.blob.visible = !hideHero;

    const ts = world.state.targets;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      const m = this.targetMeshes[i]!;
      const r = this.targetRings[i]!;
      m.visible = t.alive;
      r.visible = t.alive;
      if (!t.alive) continue;
      const x = t.px / 1000, y = t.py / 1000, z = t.pz / 1000;
      m.position.set(x, y, z);
      r.position.set(x, y + 0.02, z);
      const frac = t.hp / t.maxHp;
      const body = (m as unknown as THREE.Group).children[0] as THREE.Mesh;
      (body.material as THREE.MeshLambertMaterial).color.setHex(
        frac > 0.6 ? 0xff6b1f : frac > 0.3 ? 0xff4a1f : 0xd42a12,
      );
    }
  }

  /** Sim events -> VFX. Everything here is cosmetic and reproducible. */
  spawnEvents(events: readonly HitEvent[], mx: number, my: number, mz: number): void {
    for (const e of events) {
      this.addTracer(mx, my, mz, e.x, e.y, e.z);
      this.addSparks(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.geometry ? 3 : e.headshot ? 10 : 6, e.geometry ? 0x9fb0c0 : e.headshot ? DANGER : 0xffc98a);
    }
    if (events.length > 0) {
      this.muzzle.position.set(mx, my, mz);
      this.muzzle.intensity = 7;
      this.muzzleQuad.position.set(mx, my, mz);
      (this.muzzleQuad.material as THREE.SpriteMaterial).opacity = 0.85;
    }
  }

  private addTracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    let line = this.tracerPool.pop();
    if (line === undefined) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      line = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0xfff0c0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.scene.add(line);
    }
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, x0, y0, z0);
    pos.setXYZ(1, x1, y1, z1);
    pos.needsUpdate = true;
    line.visible = true;
    this.tracers.push({ mesh: line, life: 1 });
  }

  private addSparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, n: number, color: number): void {
    for (let i = 0; i < n; i++) {
      let s = this.sparkPool.pop();
      if (s === undefined) {
        s = new THREE.Sprite(new THREE.SpriteMaterial({
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this.scene.add(s);
      }
      (s.material as THREE.SpriteMaterial).color.setHex(color);
      (s.material as THREE.SpriteMaterial).opacity = 1;
      const j = 0.5;
      s.position.set(
        x + nx * 0.06 + (Math.random() - 0.5) * j,
        y + ny * 0.06 + (Math.random() - 0.5) * j,
        z + nz * 0.06 + (Math.random() - 0.5) * j,
      );
      s.scale.setScalar(0.05 + Math.random() * 0.06);
      s.visible = true;
      this.sparks.push({ mesh: s, life: 1, vy: 0.6 + Math.random() * 1.4 });
    }
  }

  update(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!;
      t.life -= dt * 22;
      const m = t.mesh.material as THREE.LineBasicMaterial;
      m.opacity = Math.max(0, t.life) * 0.9;
      if (t.life <= 0) {
        t.mesh.visible = false;
        this.tracerPool.push(t.mesh);
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!;
      s.life -= dt * 4.5;
      s.vy -= 9 * dt;
      s.mesh.position.y += s.vy * dt;
      (s.mesh.material as THREE.SpriteMaterial).opacity = Math.max(0, s.life);
      if (s.life <= 0) {
        s.mesh.visible = false;
        this.sparkPool.push(s.mesh);
        this.sparks.splice(i, 1);
      }
    }
    this.muzzle.intensity *= 0.62;
    const mq = this.muzzleQuad.material as THREE.SpriteMaterial;
    mq.opacity *= 0.5;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }
  get triangles(): number {
    return this.renderer.info.render.triangles;
  }
}

export const ARENA = M0;
