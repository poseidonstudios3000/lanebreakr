/**
 * input — keyboard, mouse, pointer lock, and the quantisation boundary.
 *
 * THE IMPORTANT PART is quantise(): yaw and pitch are rounded to their wire
 * resolution BEFORE they are handed to the sim, and the client predicts from
 * the same quantised value the server will receive. Predicting on
 * full-precision angles and transmitting quantised ones mismatches every
 * single shot, and the symptom — shots that visibly hit but do not register —
 * reads as netcode for weeks.
 */

import { Btn, YAW_STEPS, PITCH_LIMIT, type PlayerInput } from '@ovrrun/sim';

const MOUSE_SENS = 0.0022; // radians per pixel at 1.0 in-game sensitivity
const TAU = Math.PI * 2;

export class Input {
  private keys = new Set<string>();
  private mouseButtons = 0;
  private yawF = 0; // full-precision, accumulates mouse deltas
  private pitchF = 0;
  private seq = 0;
  locked = false;

  /** Recoil the client adds to the view, in radians. Set from sim state. */
  viewRecoilPitch = 0;
  viewRecoilYaw = 0;

  constructor(private readonly canvas: HTMLElement, startYawQ: number) {
    this.yawF = (startYawQ / YAW_STEPS) * TAU;

    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseButtons = 0; });

    canvas.addEventListener('mousedown', (e) => { this.mouseButtons |= 1 << e.button; });
    addEventListener('mouseup', (e) => { this.mouseButtons &= ~(1 << e.button); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yawF += e.movementX * MOUSE_SENS;
      this.pitchF -= e.movementY * MOUSE_SENS;
      const lim = (PITCH_LIMIT / (YAW_STEPS / 2)) * Math.PI * 0.5;
      const cap = Math.PI * 0.5 - 0.001;
      this.pitchF = Math.max(-cap, Math.min(cap, this.pitchF));
      void lim;
      this.yawF = ((this.yawF % TAU) + TAU) % TAU;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  /** Quantise to the wire format. The sim never sees a float angle. */
  private quantise(): { yaw: number; pitch: number } {
    const yaw = ((Math.round((this.yawF / TAU) * YAW_STEPS) % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
    const pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, Math.round((this.pitchF / (Math.PI * 0.5)) * PITCH_LIMIT)),
    );
    return { yaw, pitch };
  }

  /** Read back the exact angles the sim is using, for the camera. */
  get quantisedYawRad(): number {
    return (this.quantise().yaw / YAW_STEPS) * TAU;
  }
  get quantisedPitchRad(): number {
    return (this.quantise().pitch / PITCH_LIMIT) * (Math.PI * 0.5);
  }

  sample(entityId: number): PlayerInput {
    const k = (c: string): number => (this.keys.has(c) ? 1 : 0);
    const { yaw, pitch } = this.quantise();

    // MouseEvent.button is 0=left, 1=middle, 2=right, so `1 << e.button` gives
    // left=1, middle=2, right=4. Testing `& 2` for ADS put aim-down-sights on
    // the middle mouse button and melee on the right — silently, because both
    // still "worked", just on the wrong fingers.
    const LEFT = 1, MIDDLE = 2, RIGHT = 4;

    let buttons = 0;
    if (this.mouseButtons & LEFT) buttons |= Btn.Fire;
    if (this.mouseButtons & RIGHT) buttons |= Btn.Ads;
    if (this.keys.has('Space')) buttons |= Btn.Jump;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) buttons |= Btn.Dash;
    if (this.keys.has('KeyC') || this.keys.has('ControlLeft')) buttons |= Btn.Slide;
    if (this.keys.has('KeyR')) buttons |= Btn.Reload;
    if (this.keys.has('KeyF')) buttons |= Btn.Zipline;
    if (this.keys.has('KeyV')) buttons |= Btn.CameraToggle;
    if (this.keys.has('KeyQ')) buttons |= Btn.AbilityQ;
    if (this.keys.has('KeyE')) buttons |= Btn.AbilityE;
    if (this.keys.has('KeyB')) buttons |= Btn.Buy;
    if (this.mouseButtons & MIDDLE) buttons |= Btn.Melee;

    return {
      seq: this.seq++,
      entityId,
      moveX: k('KeyD') - k('KeyA'),
      moveZ: k('KeyW') - k('KeyS'),
      yaw,
      pitch,
      buttons,
      fireSubTick: 0,
    };
  }
}
