/**
 * camera — the signature mechanic (PRD §5).
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 * 1. THE SPRING ARM (§5.3 fix 1). The TPS camera collides with geometry and
 *    pulls toward the head. Without it, third person sees around corners the
 *    character cannot, and FPS becomes a strictly worse choice.
 *
 * 2. THE CAMERA IS NEVER THE SHOT ORIGIN. It only decides what you look at.
 *    Bullets leave the muzzle in world space (see systems/combat.ts), so a
 *    reticle resting on a wall from the character's point of view shoots the
 *    wall. This is the difference between a camera toggle and an exploit.
 *
 * Switching is never blocked — not mid-dash, not mid-air, not while stunned
 * (§5.2). The camera keeps moving during a stun on purpose; the spectacle is
 * the point.
 */

import * as THREE from 'three';
import { CAMERA, ENTITY, CameraMode, type Aabb, rayVsBoxes } from '@ovrrun/sim';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export class CameraRig {
  /** 0 = fully TPS, 1 = fully FPS. Smoothed across CAMERA.TRANSITION_TICKS. */
  private blend = 0;
  private adsBlend = 0;
  private shake = 0;
  private shakeSeed = 0;

  update(
    cam: THREE.PerspectiveCamera,
    mode: CameraMode,
    cameraLerpTicks: number,
    adsFrac: number,
    heroX: number, heroY: number, heroZ: number,
    yaw: number, pitch: number,
    boxes: readonly Aabb[],
    dt: number,
  ): { hideHero: boolean } {
    const targetBlend = mode === CameraMode.FPS ? 1 : 0;
    // cameraLerpTicks counts down from TRANSITION_TICKS; drive the blend from
    // the sim's own counter so the visual matches the state exactly.
    const k = cameraLerpTicks > 0 ? 1 - cameraLerpTicks / CAMERA.TRANSITION_TICKS : 1;
    this.blend = lerp(this.blend, targetBlend, Math.min(1, k * 0.55 + dt * 12));
    this.adsBlend = lerp(this.adsBlend, adsFrac, Math.min(1, dt * 16));

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // Forward matches the sim exactly: yaw 0 looks down −Z.
    const fx = sy * cp, fy = sp, fz = -cy * cp;
    const rx = cy, rz = sy;

    const eyeX = heroX;
    const eyeY = heroY + ENTITY.EYE_HEIGHT_M;
    const eyeZ = heroZ;

    // --- TPS anchor, then pull in on collision -----------------------------
    const anchorX = heroX + rx * CAMERA.TPS_RIGHT_OFFSET_M;
    const anchorY = heroY + CAMERA.TPS_HEIGHT_M;
    const anchorZ = heroZ + rz * CAMERA.TPS_RIGHT_OFFSET_M;

    let dist: number = CAMERA.TPS_DISTANCE_M;
    const hit = rayVsBoxes(anchorX, anchorY, anchorZ, -fx, -fy, -fz, dist + CAMERA.SPRING_ARM_RADIUS_M, boxes);
    if (hit.hit) dist = Math.max(0.15, hit.t - CAMERA.SPRING_ARM_RADIUS_M);

    const tpsX = anchorX - fx * dist;
    const tpsY = anchorY - fy * dist;
    const tpsZ = anchorZ - fz * dist;

    const b = this.blend;
    let px = lerp(tpsX, eyeX, b);
    let py = lerp(tpsY, eyeY, b);
    let pz = lerp(tpsZ, eyeZ, b);

    if (this.shake > 0.001) {
      this.shakeSeed += 1;
      const s = this.shake;
      px += Math.sin(this.shakeSeed * 12.9898) * s * 0.06;
      py += Math.sin(this.shakeSeed * 78.233) * s * 0.06;
      pz += Math.sin(this.shakeSeed * 39.425) * s * 0.06;
      this.shake *= 0.82;
    }

    cam.position.set(px, py, pz);
    cam.lookAt(px + fx, py + fy, pz + fz);

    const baseFov = lerp(CAMERA.TPS_FOV_DEG, CAMERA.FPS_FOV_DEG, b);
    const fov = lerp(baseFov, CAMERA.ADS_FOV_DEG, this.adsBlend * b);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    // Hide the body only once we are essentially inside the head, or the
    // capsule clips through the near plane and fills the screen.
    return { hideHero: b > 0.92 };
  }

  kick(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }
}
