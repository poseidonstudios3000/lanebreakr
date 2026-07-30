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
  createWorld, tick, fillWithBots, BOT_TIERS, SPINE, CAMERA, COMBAT, MOVEMENT, CameraMode,
  currentSpreadDeg, muzzleBlocked, aimDir, ENTITY, type HitEvent,
} from '@ovrrun/sim';
import { Scene } from './render/scene.js';
import { Input } from './input/input.js';
import { CameraRig } from './input/camera.js';
import { AudioEngine } from './audio/audio.js';

const MM = 1000;
const HERO_ID = 0;

/**
 * ?map=strip loads THE STRIP (M2), anything else loads the M0 grey box.
 * Keeping both live matters: the grey box is the range where feel changes get
 * measured, and M0's gate is the one that decides whether any of this is worth
 * building.
 */
const MODE = new URLSearchParams(location.search).get('map') === 'strip' ? 'strip' : 'greybox';
const world = createWorld(0xc0ffee, MODE);
// §10.5: bots are first-class. On THE STRIP every slot but yours is filled, so
// the lane is contested from the first wave rather than being a walking tour.
if (MODE === 'strip') {
  const tierName = (new URLSearchParams(location.search).get('bots') ?? 'normal') as 'easy' | 'normal' | 'hard';
  fillWithBots(world, [0], BOT_TIERS[tierName] ?? BOT_TIERS.normal);
}
const hero = world.state.heroes[0]!;

const scene = new Scene(document.body, world);
const input = new Input(scene.renderer.domElement, world.map.spawn.yaw);
const rig = new CameraRig();

const audio = new AudioEngine();

const startEl = document.getElementById('start')!;
startEl.addEventListener('click', () => {
  audio.init(); // must be inside a user gesture, or the browser refuses
  input.requestLock();
  startEl.classList.add('hidden');
});
/**
 * Reduced effects. Input scramble plus heavy screen distortion causes real
 * problems for motion-sensitive and motor-impaired players, and "turn off the
 * effect" must never mean "turn off the game" — so this drops the distortion
 * and keeps the mechanical penalty, which the sim owns either way.
 */
let reducedEffects = localStorage.getItem('ovrrun.reducedEffects') === '1';
addEventListener('keydown', (e) => {
  if (e.code === 'KeyG') {
    reducedEffects = !reducedEffects;
    localStorage.setItem('ovrrun.reducedEffects', reducedEffects ? '1' : '0');
  }
  if (e.code === 'KeyM') {
    audio.muted = !audio.muted;
    if (audio.muted) audio.stopLoop('zip');
  }
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
  glitch: document.getElementById('glitch')!,
  qcd: document.getElementById('qcd')!,
  qcdVal: document.getElementById('qcdVal')!,
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

/**
 * Audio is driven entirely off sim state transitions, never off input. That
 * way the sound and the simulation cannot disagree — if you hear a dash, a
 * dash happened; if the sim refused the dash (no charges, on cooldown), you
 * hear nothing, which is itself the feedback. Wiring sound to keypresses is
 * how games end up with a reload noise that plays when the reload was ignored.
 */
interface AudioPrev {
  moveState: number;
  ammo: number;
  reloadTicks: number;
  camera: number;
  ads: boolean;
  grounded: boolean;
  dashCharges: number;
  targetsAlive: number;
  qCooldown: number;
  glitched: boolean;
  stepAccum: number;
  stepFoot: number;
}

const prevAudio: AudioPrev = {
  moveState: -1,
  ammo: COMBAT.SMG.MAG_SIZE,
  reloadTicks: 0,
  camera: -1,
  ads: false,
  grounded: true,
  dashCharges: MOVEMENT.DASH_CHARGES,
  targetsAlive: 0,
  qCooldown: 0,
  glitched: false,
  stepAccum: 0,
  stepFoot: 0,
};

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
  if (MODE === 'strip') scene.syncStrip(world, world.state.tick, HERO_ID);

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

  audio.setListener(ix, iy + ENTITY.EYE_HEIGHT_M, iz, input.quantisedYawRad);
  updateAudio(pendingEvents, dt, ix, iy, iz);

  scene.update(dt);
  scene.render();

  // --- HUD ------------------------------------------------------------------
  hitmarkTimer -= dt;
  el.hitmark.classList.toggle('on', hitmarkTimer > 0);

  const glitched = hero.glitchTicksLeft > 0;
  el.glitch.classList.toggle('on', glitched);
  el.glitch.classList.toggle('reduced', reducedEffects);
  if (glitched && !reducedEffects) {
    // Roll the camera while glitched — the world tilting is what sells "your
    // controls are lying to you" more than any post effect.
    scene.camera.rotation.z = Math.sin(world.state.tick * 0.9) * 0.05;
  } else {
    scene.camera.rotation.z = 0;
  }

  updateCrosshair(viewPitch);
  updateHud(frameMs);
}

function updateAudio(events: readonly HitEvent[], dt: number, hx: number, hy: number, hz: number): void {
  if (!audio.ready) return;

  // --- weapon --------------------------------------------------------------
  if (hero.ammo < prevAudio.ammo) {
    // Slight per-shot pitch variation: twelve identical samples a second reads
    // as a loop rather than as a gun.
    audio.play('shot', { rate: 0.97 + Math.random() * 0.06, gain: 0.85 });
    audio.play('shotTail', { gain: 0.5 });
  }

  for (const e of events) {
    if (e.geometry) {
      audio.play('impact', { pos: e, rate: 0.9 + Math.random() * 0.2 });
    } else {
      audio.play(e.headshot ? 'headshot' : 'hit', { pos: e });
      if (e.killed) audio.play('kill', { gain: 0.9 });
    }
  }

  // --- reload: three beats, not one blob -----------------------------------
  if (hero.reloadTicksLeft > 0 && prevAudio.reloadTicks === 0) {
    audio.play('magOut');
    const t = hero.reloadTicksLeft;
    setTimeout(() => audio.play('magIn'), (t * 0.45 * 1000) / SPINE.SIM_HZ);
    setTimeout(() => audio.play('charge'), (t * 0.82 * 1000) / SPINE.SIM_HZ);
  }

  // --- movement ------------------------------------------------------------
  if (hero.dashCharges < prevAudio.dashCharges) audio.play('dash');

  if (hero.moveState !== prevAudio.moveState) {
    if (hero.moveState === 3 /* Slide */) audio.play('slide');
    if (hero.moveState === 4 /* Mantle */) audio.play('mantle');
    if (hero.moveState === 5 /* Zipline */) {
      audio.play('zipAttach');
      audio.startLoop('zip', 'zipRide', 0.5);
    }
    if (prevAudio.moveState === 5) audio.stopLoop('zip');
  }

  if (prevAudio.grounded && !hero.grounded && hero.moveState === 1 /* Air */) {
    audio.play('jump', { gain: 0.7 });
  }
  if (!prevAudio.grounded && hero.grounded) {
    const impact = Math.min(1, Math.abs(hero.vy / 1000) / 12 + 0.35);
    audio.play('land', { gain: impact });
  }

  // Footsteps by distance travelled, not by a timer — so they stay in step
  // with actual speed instead of drifting when you strafe or slow down.
  const speed = Math.sqrt((hero.vx / MM) ** 2 + (hero.vz / MM) ** 2);
  if (hero.grounded && hero.moveState === 0 /* Ground */ && speed > 1.2) {
    prevAudio.stepAccum += speed * dt;
    if (prevAudio.stepAccum >= 2.1) {
      prevAudio.stepAccum = 0;
      prevAudio.stepFoot ^= 1;
      audio.play('step', {
        rate: prevAudio.stepFoot ? 1.0 : 0.92, // alternate feet
        gain: 0.55 + (speed / MOVEMENT.BASE_SPEED_MPS) * 0.35,
      });
    }
  } else {
    prevAudio.stepAccum = 1.6; // land already mid-stride
  }

  // --- camera --------------------------------------------------------------
  if (hero.camera !== prevAudio.camera && prevAudio.camera !== -1) audio.play('camera');
  const adsNow = hero.adsTicks > CAMERA.ADS_ENTER_TICKS * 0.5;
  if (adsNow !== prevAudio.ads) audio.play(adsNow ? 'adsIn' : 'adsOut');

  // --- glitch bomb ---------------------------------------------------------
  // Cooldown going from 0 to full means the sim ACCEPTED the cast. Wiring this
  // to the keypress instead would play a throw sound on a refused cast.
  if (hero.abilityQCooldown > prevAudio.qCooldown) audio.play('glitchThrow', { gain: 0.8 });
  const glitchedNow = hero.glitchTicksLeft > 0;
  if (glitchedNow && !prevAudio.glitched) {
    audio.play('glitchHit', { gain: 1.0 });
    audio.startLoop('glitch', 'glitchLoop', 0.7);
  } else if (!glitchedNow && prevAudio.glitched) {
    audio.stopLoop('glitch');
  }
  prevAudio.qCooldown = hero.abilityQCooldown;
  prevAudio.glitched = glitchedNow;

  // --- targets -------------------------------------------------------------
  let alive = 0;
  for (const t of world.state.targets) if (t.alive) alive++;
  if (alive > prevAudio.targetsAlive) {
    audio.play('respawn', { gain: 0.5 });
  }

  prevAudio.moveState = hero.moveState;
  prevAudio.ammo = hero.ammo;
  prevAudio.reloadTicks = hero.reloadTicksLeft;
  prevAudio.camera = hero.camera;
  prevAudio.ads = adsNow;
  prevAudio.grounded = hero.grounded;
  prevAudio.dashCharges = hero.dashCharges;
  prevAudio.targetsAlive = alive;
  void hx; void hy; void hz;
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

  const qReady = hero.abilityQCooldown === 0;
  el.qcd.classList.toggle('ready', qReady);
  el.qcdVal.textContent = qReady ? 'GLITCH' : `${(hero.abilityQCooldown / SPINE.SIM_HZ).toFixed(1)}s`;

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
