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
  /** Duration this mantle was started with — height-derived, so it varies. */
  mantleTotalTicks: number;
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
  /** Last movement axes, and how long we have gone without a fresh input.
   *  PRD §10.4: a missing input repeats the last one for <=3 ticks, then zeroes
   *  the movement axes while holding view angles. It NEVER freezes the entity. */
  lastMoveX: number;
  lastMoveZ: number;
  noInputTicks: number;
}

export const enum TrooperKind {
  Line = 0,
  Lancer = 1,
  Sieger = 2,
}

export const enum StructureKind {
  TowerT1 = 0,
  TowerT2 = 1,
  Core = 2,
}

export interface TrooperState {
  id: EntityId;
  team: Team;
  kind: TrooperKind;
  alive: boolean;
  px: number;
  py: number;
  pz: number;
  hp: number;
  maxHp: number;
  waveIndex: number;
  targetId: EntityId;
  targetDwell: number;
  attackCooldown: number;
  retargetIn: number;
  /** tick at which an enemy HERO last damaged an allied hero near this trooper */
  retaliateUntil: number;
  retaliateTarget: EntityId;
}

/**
 * A soul orb. PRD §7 calls this the most important system in the game; it is
 * also the one the document specified least.
 *
 * Ownership was never stated, so "deny" had no referent. An orb belongs to the
 * team OPPOSITE the trooper that dropped it — deterministic, symmetric (4 orbs
 * per team per wave), and it renders in the owner's colour so the read is one
 * glance.
 *
 * Claim resolves against an HP pool with two independent progress counters.
 * Owner damage fills `claimProgress`, enemy damage fills `denyProgress`; never
 * the same pool, or chipping an enemy's orb would help them claim it.
 */
export interface OrbState {
  id: EntityId;
  ownerTeam: Team;
  px: number;
  py: number;
  pz: number;
  hoverTicksLeft: number;
  armTicksLeft: number;
  claimProgress: number;
  denyProgress: number;
  /** last hero of each side to damage it — credited on completion */
  lastClaimer: EntityId;
  lastDenier: EntityId;
  alive: boolean;
}

export interface StructureState {
  id: EntityId;
  team: Team;
  kind: StructureKind;
  alive: boolean;
  px: number;
  py: number;
  pz: number;
  hp: number;
  maxHp: number;
  attackCooldown: number;
  acquireDelay: number;
  targetId: EntityId;
  targetDwell: number;
  /** damage ramp, per tower, never reset by a target switch */
  rampStacks: number;
  rampDecayIn: number;
  /** ticks since last damaged — gates both regen paths */
  outOfCombat: number;
  aggroHeroUntil: number;
  aggroHeroId: EntityId;
}

export const enum MatchPhase {
  Warmup = 0,
  Live = 1,
  SuddenDeath = 2,
  Over = 3,
}

export interface TeamState {
  souls: number[];
  /** lifetime contestable earnings — SURGE's gap metric excludes passive */
  contestableEarned: number;
  surging: boolean;
  surgeTicksLeft: number;
  marchTicksLeft: number;
  towersLost: number;
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

export const enum SoulSource {
  Passive = 0,
  OrbClaim = 1,
  OrbDeny = 2,
  Takedown = 3,
  Assist = 4,
  Tower = 5,
  PitBoss = 6,
}

export interface SoulEvent {
  tick: number;
  heroId: EntityId;
  team: Team;
  source: SoulSource;
  amount: number;
  x: number;
  y: number;
  z: number;
}

export interface WorldState {
  tick: number;
  matchSeed: number;
  phase: MatchPhase;
  winner: Team | -1;
  heroes: HeroState[];
  troopers: TrooperState[];
  orbs: OrbState[];
  structures: StructureState[];
  /** indexed by Team.A / Team.B; Team.Neutral never has one */
  teams: TeamState[];
  nextWaveTick: number;
  waveIndex: number;
  nextEntityId: number;
  /** greybox only */
  targets: TargetState[];
  /** cleared at the top of every tick — consumers read them after tick() returns */
  events: HitEvent[];
  soulEvents: SoulEvent[];
}
