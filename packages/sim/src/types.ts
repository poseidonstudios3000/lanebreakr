/**
 * types — the sim's whole vocabulary.
 *
 * REPRESENTATION RULE (PRD §10.3): state is stored as INTEGERS. Positions and
 * velocities are integer millimetres and mm/s; HP and damage are integer
 * milli-units; angles are quantised integer steps. Floats appear only *inside*
 * a tick, in collision queries, and every float value is rounded back to an
 * integer before it is written to state.
 *
 * That rounding boundary is the entire determinism story. Float arithmetic
 * using only + - * / and sqrt is bit-identical across engines, but error would
 * still *accumulate* across 43,200 ticks of a 12-minute match if state itself
 * were float. Quantising at the tick boundary makes accumulation impossible:
 * every tick starts from an exactly-representable integer.
 */

/** Angle quantisation — matches the wire format in PRD §10.4. */
export const YAW_STEPS = 8192; // 13 bits, 0.0439°/step
export const PITCH_STEPS = 4096; // 12 bits over ±90°, 0.0439°/step
export const YAW_TO_RAD = 6.283185307179586 / YAW_STEPS;
export const PITCH_TO_RAD = 3.141592653589793 / PITCH_STEPS;
export const PITCH_LIMIT = PITCH_STEPS / 4; // ±2048 steps = ±90°

export type EntityId = number;

export const enum Team {
  A = 0,
  B = 1,
  Neutral = 2,
}

export const enum CameraMode {
  TPS = 0,
  FPS = 1,
}

export const enum MoveState {
  Ground = 0,
  Air = 1,
  Dash = 2,
  Slide = 3,
  Mantle = 4,
  Zipline = 5,
}

/** Button bits. 13 of them — this is the count that forces 8-byte inputs. */
export const enum Btn {
  Fire = 1 << 0,
  Ads = 1 << 1,
  Jump = 1 << 2,
  Dash = 1 << 3,
  Slide = 1 << 4,
  Reload = 1 << 5,
  Melee = 1 << 6,
  CameraToggle = 1 << 7,
  Zipline = 1 << 8,
  AbilityQ = 1 << 9,
  AbilityE = 1 << 10,
  AbilityR = 1 << 11,
  Buy = 1 << 12,
}

/**
 * One player's input for one tick. 8 bytes on the wire.
 * `moveX`/`moveZ` are ternary (−1, 0, 1) — 2 bits each.
 * `yaw`/`pitch` arrive ALREADY QUANTISED. The client must quantise before
 * feeding its own prediction, or client and server predict from different
 * angles on every single shot.
 */
export interface PlayerInput {
  seq: number;
  entityId: EntityId;
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** Which 1/60 slice of the tick the fire press landed on, 0–31. */
  fireSubTick: number;
}

export interface HeroState {
  id: EntityId;
  team: Team;
  alive: boolean;

  /** integer millimetres */
  px: number;
  py: number;
  pz: number;
  /** integer millimetres per second */
  vx: number;
  vy: number;
  vz: number;

  yaw: number;
  pitch: number;

  /** integer milli-HP */
  hp: number;
  maxHp: number;

  moveState: MoveState;
  grounded: boolean;
  groundedTick: number;
  jumpBufferedTick: number;

  camera: CameraMode;
  /** 0..CAMERA.TRANSITION_TICKS, counts down during the lerp */
  cameraLerp: number;
  adsTicks: number;
  /** Camera mode to restore when ADS is released; −1 when ADS did not switch it. */
  adsPriorCamera: number;

  dashCharges: number;
  dashRechargeTicks: number;
  dashTicksLeft: number;
  dashCooldownTicks: number;
  iframeTicksLeft: number;
  /** dash direction, unit vector × 1000 */
  dashDirX: number;
  dashDirZ: number;

  slideTicksLeft: number;
  slideCooldownTicks: number;
  mantleTicksLeft: number;
  mantleTargetX: number;
  mantleTargetY: number;
  mantleTargetZ: number;

  ziplineId: number;
  ziplineT: number; // milli-fraction along the line
  ziplineDir: number; // +1 or −1

  ammo: number;
  reloadTicksLeft: number;
  fireCooldownTicks: number;
  postReloadLockout: number;
  meleeTicksLeft: number;
  meleeCooldownTicks: number;

  /** milli-degrees, so spread and recoil accumulate as integers */
  spreadMilliDeg: number;
  spreadDecayDelay: number;
  recoilVertMilliDeg: number;
  recoilHorizMilliDeg: number;
  recoilRecoveryDelay: number;

  shotsFired: number;
  hitsLanded: number;
  headshots: number;
  damageDealt: number;

  /** Last tick's button mask. Part of state, not a side table — edge detection
   *  must survive rewind-and-replay or every press replays as a fresh press. */
  prevButtons: number;
}

export interface TargetState {
  id: EntityId;
  px: number;
  py: number;
  pz: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  respawnTicksLeft: number;
  /** for the moving targets — mm/s, bounces between bounds */
  vx: number;
  minX: number;
  maxX: number;
}

/** Purely visual, but produced by the sim so replays reproduce them exactly. */
export interface HitEvent {
  tick: number;
  shooterId: EntityId;
  targetId: EntityId;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  damage: number;
  headshot: boolean;
  killed: boolean;
  /** true when the ray hit world geometry rather than an entity */
  geometry: boolean;
}

export interface WorldState {
  tick: number;
  matchSeed: number;
  heroes: HeroState[];
  targets: TargetState[];
  /** cleared at the top of every tick — consumers read it after tick() returns */
  events: HitEvent[];
}
