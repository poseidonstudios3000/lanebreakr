/**
 * main — the client shell. Fixed-timestep loop, render interpolation, HUD.
 *
 * The loop shape matters: the sim advances in whole 60Hz steps driven by an
 * accumulator, never by the frame delta. Rendering interpolates between the
 * two most recent sim states. This is not an optimisation — it is the same
 * loop the netcoded client will run, so nothing about the feel changes when
 * prediction arrives at M4.
 */

import {
  createWorld, tick, SPINE, CAMERA, COMBAT, MOVEMENT, CameraMode,
  currentSpreadDeg, muzzleBlocked, aimDir, ENTITY, type HitEvent,
} from '@ovrrun/sim';
import { Scene } from './render/scene.js';
import { Input } from './input/input.js';
import { CameraRig } from './input/camera.js';

const MM = 1000;
const HERO_ID = 0;

const world = createWorld(0xc0ffee);
const hero = world.state.heroes[0]!;

const scene = new Scene(document.body, world);
const input = new Input(scene.renderer.domElement, world.map.spawn.yaw);
const rig = new CameraRig();

const startEl = document.getElementById('start')!;
startEl.addEventListener('click', () => {
  input.requestLock();
  startEl.classList.add('hidden');
});
document.addEventListener('pointerlockchange', () => {
  if (!input.locked) startEl.classList.remove('hidden');
});

// --- HUD handles ------------------------------------------------------------
const el = {
  stats: document.getElementById('stats')!,
  ammoN: document.getElementById('ammoN')!,
  ammoSub: document.getElementById('ammoSub')!,
  dashes: document.getElementById('dashes')!,
  modeName: document.getElementById('modeName')!,
  cross: document.getElementById('cross')!,
  cl: document.getElementById('cl')!,
  cr: document.getElementById('cr')!,
  ct: document.getElementById('ct')!,
  cb: document.getElementById('cb')!,
  hitmark: document.getElementById('hitmark')!,
};

for (let i = 0; i < MOVEMENT.DASH_CHARGES; i++) {
  el.dashes.appendChild(document.createElement('i'));
}
const dashPips = Array.from(el.dashes.children) as HTMLElement[];

// --- interpolation state ----------------------------------------------------
let prevX = hero.px / MM, prevY = hero.py / MM, prevZ = hero.pz / MM;
let currX = prevX, currY = prevY, currZ = prevZ;

// --- perf counters ----------------------------------------------------------
const frameTimes: number[] = [];
let fps = 0;
let frameP99 = 0;
let hitmarkTimer = 0;

let acc = 0;
let last = performance.now();
const STEP_MS = 1000 / SPINE.SIM_HZ;
/** Never simulate more than this many steps in one frame — a tab that was
 *  backgrounded must not fast-forward the whole match on return. */
const MAX_STEPS = 5;

function frame(now: number): void {
  requestAnimationFrame(frame);

  const frameMs = now - last;
  last = now;
  acc += Math.min(frameMs, MAX_STEPS * STEP_MS);

  frameTimes.push(frameMs);
  if (frameTimes.length > 240) frameTimes.shift();

  const pendingEvents: HitEvent[] = [];

  let steps = 0;
  while (acc >= STEP_MS && steps < MAX_STEPS) {
    prevX = hero.px / MM; prevY = hero.py / MM; prevZ = hero.pz / MM;
    tick(world, [input.sample(HERO_ID)]);
    currX = hero.px / MM; currY = hero.py / MM; currZ = hero.pz / MM;
    for (const e of world.state.events) pendingEvents.push(e);
    acc -= STEP_MS;
    steps++;
  }

  const alpha = Math.min(1, acc / STEP_MS);
  const ix = prevX + (currX - prevX) * alpha;
  const iy = prevY + (currY - prevY) * alpha;
  const iz = prevZ + (currZ - prevZ) * alpha;

  // Recoil is applied to the VIEW, not to the sim's authoritative yaw/pitch —
  // the sim already accounted for it when it built the shot ray.
  const recoilPitch = (hero.recoilVertMilliDeg / 1000) * (Math.PI / 180);
  const recoilYaw = (hero.recoilHorizMilliDeg / 1000) * (Math.PI / 180);
  const viewYaw = input.quantisedYawRad + recoilYaw;
  const viewPitch = Math.max(-1.5, Math.min(1.5, input.quantisedPitchRad + recoilPitch));

  const dt = Math.min(frameMs, 100) / 1000;
  const adsFrac = hero.adsTicks / CAMERA.ADS_ENTER_TICKS;
  const { hideHero } = rig.update(
    scene.camera, hero.camera, hero.cameraLerp, adsFrac,
    ix, iy, iz, viewYaw, viewPitch, world.map.boxes, dt,
  );

  scene.syncWorld(world, ix, iy, iz, input.quantisedYawRad, hideHero);

  if (pendingEvents.length > 0) {
    const [ax, , az] = aimDir(hero.yaw, hero.pitch);
    scene.spawnEvents(
      pendingEvents,
      ix + ax * ENTITY.MUZZLE_FORWARD_M,
      iy + ENTITY.MUZZLE_HEIGHT_M,
      iz + az * ENTITY.MUZZLE_FORWARD_M,
    );
    rig.kick(0.35 * pendingEvents.length);
    for (const e of pendingEvents) {
      if (!e.geometry) {
        hitmarkTimer = e.killed ? 0.28 : 0.14;
        el.hitmark.classList.toggle('kill', e.killed);
      }
    }
  }

  scene.update(dt);
  scene.render();

  // --- HUD ------------------------------------------------------------------
  hitmarkTimer -= dt;
  el.hitmark.classList.toggle('on', hitmarkTimer > 0);

  updateCrosshair(viewPitch);
  updateHud(frameMs);
}

function updateCrosshair(_viewPitch: number): void {
  // The crosshair IS the spread cone, projected. If it lies, the gun feels
  // broken even when the numbers are right.
  const coneDeg = currentSpreadDeg(hero);
  const halfH = innerHeight / 2;
  const fovRad = (scene.camera.fov * Math.PI) / 180;
  const px = Math.tan((coneDeg * Math.PI) / 180) / Math.tan(fovRad / 2) * halfH;
  const gap = Math.max(3, Math.min(90, px));

  el.cl.style.transform = `translate(${-gap - 9}px, -1px)`;
  el.cr.style.transform = `translate(${gap}px, -1px)`;
  el.ct.style.transform = `translate(-1px, ${-gap - 9}px)`;
  el.cb.style.transform = `translate(-1px, ${gap}px)`;

  el.cross.classList.toggle('blocked', muzzleBlocked(hero, world.map.boxes));
}

function updateHud(frameMs: number): void {
  fps = fps * 0.92 + (1000 / Math.max(frameMs, 0.001)) * 0.08;

  const sorted = [...frameTimes].sort((a, b) => a - b);
  frameP99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;

  el.ammoN.textContent = hero.reloadTicksLeft > 0 ? '--' : String(hero.ammo);
  el.ammoN.classList.toggle('low', hero.ammo <= 6 && hero.reloadTicksLeft === 0);
  el.ammoSub.innerHTML = hero.reloadTicksLeft > 0
    ? '<span id="reload">RELOADING</span>'
    : `SMG · ${(60 / COMBAT.SMG.FIRE_INTERVAL_TICKS * 60).toFixed(0)} RPM`;

  for (let i = 0; i < dashPips.length; i++) {
    dashPips[i]!.classList.toggle('ready', i < hero.dashCharges);
  }

  el.modeName.textContent = hero.camera === CameraMode.FPS ? 'FPS' : 'TPS';

  const acc2 = hero.shotsFired > 0 ? (hero.hitsLanded / hero.shotsFired) * 100 : 0;
  const hs = hero.hitsLanded > 0 ? (hero.headshots / hero.hitsLanded) * 100 : 0;
  const speed = Math.sqrt((hero.vx / MM) ** 2 + (hero.vz / MM) ** 2);
  const stateName = ['GROUND', 'AIR', 'DASH', 'SLIDE', 'MANTLE', 'ZIPLINE'][hero.moveState] ?? '?';

  el.stats.innerHTML = `
    <div class="row"><span class="dim">fps</span><b>${fps.toFixed(0)}</b></div>
    <div class="row"><span class="dim">frame p99</span><span>${frameP99.toFixed(1)} ms</span></div>
    <div class="row"><span class="dim">draw calls</span><span>${scene.drawCalls}</span></div>
    <div class="row"><span class="dim">tris</span><span>${(scene.triangles / 1000).toFixed(0)}k</span></div>
    <hr />
    <div class="row"><span class="dim">state</span><b>${stateName}</b></div>
    <div class="row"><span class="dim">speed</span><span>${speed.toFixed(2)} m/s</span></div>
    <div class="row"><span class="dim">spread</span><span>${currentSpreadDeg(hero).toFixed(2)}°</span></div>
    <hr />
    <div class="row"><span class="dim">accuracy</span><span>${acc2.toFixed(0)}%</span></div>
    <div class="row"><span class="dim">headshots</span><span>${hs.toFixed(0)}%</span></div>
    <div class="row"><span class="dim">damage</span><span>${(hero.damageDealt / 1000).toFixed(0)}</span></div>
    <div class="row"><span class="dim">tick</span><span>${world.state.tick}</span></div>
  `;
}

requestAnimationFrame(frame);

// Expose for the perf harness and for poking at the sim from devtools.
Object.assign(globalThis, { __ovrrun: { world, scene, hero } });
