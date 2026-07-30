/**
 * balance.ts — ⭐ EVERY tunable number in OVRRUN. PRD §10.2, §13.
 *
 * Rules:
 *   - Pure data. No imports, no functions, no logic.
 *   - Never tune balance outside this file (PRD §13).
 *   - Every periodic value is an INTEGER TICK COUNT at 60Hz. If a value cannot
 *     be expressed as one, it is the wrong value — see SPINE.SIM_HZ.
 *
 * STATUS: M0 subset. ECONOMY, ABILITIES and WORLD land before M2; the
 * placeholders here are the ones M0 actually exercises and are marked.
 */

// ============================================================================
// SPINE — the anchors everything else derives from. Changing one of these is a
// design decision, not a tuning pass.
// ============================================================================
export const SPINE = {
  SIM_HZ: 60,
  TICK_S: 1 / 60,

  /**
   * 60Hz, not the PRD v1.0 30Hz. At 30Hz the two hitscan weapons land on
   * half-ticks (720 RPM = 2.5 ticks/shot, 240 RPM = 7.5), so both fire on a
   * jittering 2/3-tick cadence and "+12% fire rate" rounds to −17% or +25%.
   * The 20Hz snapshot rate is 1.5 ticks, so interpolation spacing alternates.
   * At 60Hz all four weapons, the snapshot rate and the visibility gate divide
   * evenly, aim latency halves, and a 45 m/s projectile advances 0.75m/tick
   * instead of 1.5m — still requiring swept collision, but tractably.
   */
  SNAPSHOT_INTERVAL_TICKS: 3, // 20Hz
  VISIBILITY_INTERVAL_TICKS: 4, // 15Hz, tick-locked (PRD §5.3)

  MATCH_TARGET_S: 720, // 12:00
  MATCH_SUDDEN_DEATH_S: 900, // 15:00

  HERO_BASE_HP: 550,
  HERO_ITEMIZED_HP_CEILING: 1000, // PRD v1.0 said ~1600; the item table cannot reach it

  /** Fixed point. HP and damage are integer milli-units; multipliers integer permille. */
  DAMAGE_SCALE: 1000,
  PERMILLE: 1000,

  /** Positions integrate in integer millimetres; floats survive only inside collision queries. */
  POS_SCALE_MM: 1000,
} as const;

// ============================================================================
// ENTITY — hero physical dimensions. Every spread number, the pellet pattern
// and the whole tunneling analysis in COMBAT are keyed to these.
// ============================================================================
export const ENTITY = {
  CAPSULE_RADIUS_M: 0.4,
  CAPSULE_HEIGHT_M: 1.8,
  CROUCH_HEIGHT_M: 1.1,
  SLIDE_HEIGHT_M: 0.9,

  EYE_HEIGHT_M: 1.62, // FPS camera origin AND the head-LOS ray origin (PRD §5.3)
  HEAD_SPHERE_RADIUS_M: 0.14,
  HEAD_SPHERE_CENTER_M: 1.62,

  MUZZLE_FORWARD_M: 0.35, // bullets originate here in world space, never at the camera
  MUZZLE_HEIGHT_M: 1.45,
} as const;

// ============================================================================
// MOVEMENT — PROVISIONAL for M0. Base speed 6.0 m/s is spine; the rest is a
// first pass to be felt, then tuned. This is precisely what the M0 gate is for.
// ============================================================================
export const MOVEMENT = {
  BASE_SPEED_MPS: 6.0,
  ADS_SPEED_MULT: 0.6,
  AIR_SPEED_MULT: 0.9,

  GROUND_ACCEL_MPS2: 60.0, // 0.1s to top speed — snappy, CoD-adjacent
  GROUND_FRICTION_MPS2: 55.0,
  AIR_ACCEL_MPS2: 12.0,
  MAX_AIR_SPEED_GAIN_MPS: 1.2, // caps air-strafe accumulation

  GRAVITY_MPS2: -22.0, // heavier than real; keeps airtime short and readable
  JUMP_VELOCITY_MPS: 7.2, // ~1.18m apex, ~0.65s hang
  COYOTE_TICKS: 6, // 0.10s of grace after leaving a ledge
  JUMP_BUFFER_TICKS: 6, // 0.10s of pre-press forgiveness

  STEP_HEIGHT_M: 0.35,
  MAX_GROUND_SLOPE_COS: 0.6, // ~53°

  // --- Dash: PRD §6.4. The get-out-of-jail and the movement-tech enabler. ---
  DASH_CHARGES: 2,
  DASH_RECHARGE_TICKS: 480, // 8.0s per charge
  DASH_DISTANCE_M: 6.0,
  DASH_DURATION_TICKS: 12, // 0.20s → 30 m/s while dashing
  DASH_IFRAME_TICKS: 15, // 0.25s from dash start (PRD §6.4)
  DASH_COOLDOWN_TICKS: 18, // 0.30s between consecutive dashes; stops double-tap teleporting
  DASH_PRESERVES_SPEED_FRAC: 0.55, // exit speed carried into the ground state

  // --- Slide: PRD §1.3 P3 and §2 "slide-cancel snappiness". Never specified. ---
  SLIDE_MIN_ENTRY_SPEED_MPS: 5.0,
  SLIDE_ENTRY_SPEED_MULT: 1.35,
  SLIDE_MIN_EXIT_SPEED_FRAC: 0.6,
  SLIDE_DURATION_TICKS: 54, // 0.90s
  SLIDE_COOLDOWN_TICKS: 90, // 1.50s
  /**
   * 3.0, not 6.0. At 6.0 the slide decayed from an 8.1 m/s entry to 4.4 m/s
   * within 0.6s — below walking speed, which makes it a crouch animation
   * rather than a movement tech, and P3 calls movement tech the primary clip
   * source. At 3.0 you hold ~6.3 m/s through the useful window and exit at
   * ~5.4, so the 1.35× entry burst is a real gain that costs you a slower
   * exit. Caught by the M0 "preserves ≥80% of entry speed" criterion.
   */
  SLIDE_FRICTION_MPS2: 3.0,
  SLIDE_CANCELLABLE_INTO_DASH: true, // this is the slide-cancel

  // --- Mantle: replaces the PRD's "4 mantle points". Scripted mantle points
  //     are a level-design liability and the MID PIT already needed a fifth. ---
  MANTLE_MAX_HEIGHT_M: 2.2,
  MANTLE_MIN_HEIGHT_M: 0.5,
  MANTLE_REACH_M: 1.1,
  MANTLE_DURATION_TICKS: 27, // 0.45s, weapon locked
  MANTLE_MIN_LEDGE_DEPTH_M: 0.5,

  // --- Zipline: PRD §4.1, "2 ziplines running the length of the map". ---
  ZIPLINE_ATTACH_RANGE_M: 3.0,
  ZIPLINE_SPEED_MPS: 14.0,
  ZIPLINE_ACCEL_TICKS: 18, // 0.30s to reach speed
  ZIPLINE_DISMOUNT_ON_JUMP: true,
  ZIPLINE_DISMOUNT_ON_DAMAGE: true,
  ZIPLINE_WEAPON_LOCKED: true,

  MELEE_KEY_NOTE: 'F — see COMBAT.MELEE',
} as const;

// ============================================================================
// CAMERA — PRD §5. The axis is mobility vs precision, NOT good vs bad camera.
// ============================================================================
export const CAMERA = {
  TPS_DISTANCE_M: 3.5,
  TPS_RIGHT_OFFSET_M: 0.6,
  TPS_HEIGHT_M: 1.55,
  TPS_FOV_DEG: 95,

  FPS_FOV_DEG: 80,
  ADS_FOV_DEG: 65,

  TRANSITION_TICKS: 9, // 0.15s (PRD §5.2), never blocked — not mid-dash, not stunned
  ADS_ENTER_TICKS: 12,
  ADS_EXIT_TICKS: 9,

  /**
   * 1.0, not the PRD v1.0 ×1.4. With the penalty, TPS had only downsides in a
   * fight — §5.3's anti-peek fix already removes its awareness edge, and
   * hold-RMB auto-switches for you — so the dominant macro was TPS traversal
   * plus RMB for every engagement: zero V presses, and the signature mechanic
   * reduced to a traversal camera. Raise this if M0 shows TPS dominating; it is
   * the single constant that reverts the decision.
   */
  TPS_HIPFIRE_SPREAD_MULT: 1.0,

  SPRING_ARM_RADIUS_M: 0.25, // camera collides and pulls in (§5.3 fix 1)
  SPRING_ARM_PULL_SPEED_MPS: 40.0,

  // §5.3 fix 2 — enemy visibility gating
  SILHOUETTE_HOLD_TICKS: 24, // 0.4s
  VIS_HYSTERESIS_SAMPLES: 2, // consecutive occluded samples before hiding
  VIS_MIN_DWELL_TICKS: 12, // 0.2s minimum visible dwell
  VIS_RAY_TARGETS: 3, // head / chest / feet — one ray is unusable vs cover
} as const;

// ============================================================================
// COMBAT — weapons, spread, recoil, headshots, reloads, melee.
//
// DAMAGE PIPELINE (settled, do not reorder):
//   final = BASE × FALLOFF × HEADSHOT × (1 + Σ additive % bonuses)
// All percent bonuses are ADDITIVE with each other. Never multiplicative.
// ============================================================================
export const COMBAT = {
  HEADSHOT_MULT_HITSCAN: 1.5, // PRD §6.2
  HEADSHOT_MULT_PROJECTILE: 1.0,
  HEADSHOT_MULT_ABILITY: 1.0,
  HEADSHOT_MULT_MELEE: 1.0,
  LIMB_MULT: 1.0, // no limb penalty — Pillar P4 legibility
  MIN_DAMAGE_MILLI: 1000, // a connecting shot never deals < 1.0

  SPREAD_MOVE_SPEED_REF_MPS: 6.0,
  SPREAD_DASH_TAIL_TICKS: 12, // air spread persists 0.20s after a dash ends

  RELOAD_CANCEL_ON_FIRE: false, // you cannot shoot out of a reload
  RELOAD_CANCEL_ON_DASH: true, // dash IS the escape hatch
  RELOAD_CANCEL_ON_ABILITY: true,
  RELOAD_CANCEL_ON_MELEE: false, // reload + melee an orb at 2m without losing the reload
  RELOAD_CANCEL_ON_DAMAGE: false, // else you are reload-locked under suppression
  RELOAD_CANCEL_ON_STUN: true,
  RELOAD_PARTIAL_CREDIT: false, // cancel = zero ammo gained; commit or don't
  RELOAD_EMPTY_PENALTY_TICKS: 15, // 0.25s tax for running dry
  POST_RELOAD_LOCKOUT_TICKS: 3,
  AUTO_RELOAD_ON_EMPTY_DELAY_TICKS: 12,
  RESERVE_AMMO: -1, // −1 sentinel = infinite (PRD §6.3). Never Infinity.

  ADS_AVAILABLE_IN_TPS: false,
  ADS_BLOCKED_WHILE_DASHING: true,

  /** mult(d) = 1 for d ≤ START, linear to END_MULT at END, clamped after. */
  FALLOFF_APPLIES_TO_ORBS: true, // range-gates orb claiming — that is the point
  FALLOFF_APPLIES_TO_STRUCTURES: true,
  FALLOFF_APPLIES_TO_SPLASH: false,

  // ------------------------------------------------------------------------
  // VOLT — SMG. Hitscan, full auto. This is the M0 weapon.
  // ------------------------------------------------------------------------
  SMG: {
    HITSCAN: true,
    AUTO: true,
    PELLET_COUNT: 1,
    FIRE_INTERVAL_TICKS: 5, // 720 RPM — the PRD value survives 60Hz exactly
    DAMAGE: 38, // 700/38 → 19 shots → 18/12 = 1.500s @700HP [IN BAND]
    MAG_SIZE: 32,
    RELOAD_TICKS: 84, // 1.4s
    FALLOFF_START_M: 18,
    FALLOFF_END_M: 40,
    FALLOFF_END_MULT: 0.45,
    BASE_SPREAD_DEG: 1.5,
    ADS_SPREAD_DEG: 0.7,
    SPREAD_PER_SHOT_DEG: 0.09,
    SPREAD_MAX_DEG: 2.6,
    SPREAD_DECAY_DEG_PER_S: 4.0,
    SPREAD_DECAY_DELAY_TICKS: 6, // > fire interval, so sustained fire never decays
    SPREAD_MOVE_MULT: 1.8,
    SPREAD_AIR_MULT: 2.0,
    RECOIL_VERTICAL_DEG: 0.28,
    RECOIL_HORIZONTAL_DEG: 0.22,
    RECOIL_ACCUM_MAX_DEG: 6.0,
    RECOIL_RECOVERY_DEG_PER_S: 9.0,
    RECOIL_RECOVERY_DELAY_TICKS: 6, // the only weapon that truly climbs
    STRUCTURE_DAMAGE_MULT: 0.35,
    ORB_DAMAGE: 34, // 3 shots to claim → 0.167s committed
  },

  // ------------------------------------------------------------------------
  // HALO — Rifle. Hitscan, semi-auto.
  // ------------------------------------------------------------------------
  RIFLE: {
    HITSCAN: true,
    AUTO: false,
    PELLET_COUNT: 1,
    FIRE_INTERVAL_TICKS: 15, // 240 RPM
    DAMAGE: 104, // 700/104 → 7 shots → 6/4 = 1.500s [IN BAND]
    MAG_SIZE: 15,
    RELOAD_TICKS: 108,
    FALLOFF_START_M: 45,
    FALLOFF_END_M: 70,
    FALLOFF_END_MULT: 0.7,
    BASE_SPREAD_DEG: 1.1,
    ADS_SPREAD_DEG: 0.12,
    SPREAD_PER_SHOT_DEG: 0.22,
    SPREAD_MAX_DEG: 2.4,
    SPREAD_DECAY_DEG_PER_S: 3.5,
    SPREAD_DECAY_DELAY_TICKS: 10,
    SPREAD_MOVE_MULT: 2.4, // HALO plants or misses
    SPREAD_AIR_MULT: 3.0,
    RECOIL_VERTICAL_DEG: 0.85,
    RECOIL_HORIZONTAL_DEG: 0.35,
    RECOIL_ACCUM_MAX_DEG: 5.0,
    RECOIL_RECOVERY_DEG_PER_S: 6.5,
    RECOIL_RECOVERY_DELAY_TICKS: 10,
    STRUCTURE_DAMAGE_MULT: 0.6,
    ORB_DAMAGE: 55,
  },

  // ------------------------------------------------------------------------
  // BULWARK — Shotgun. 8 hitscan pellets.
  // ------------------------------------------------------------------------
  SHOTGUN: {
    HITSCAN: true,
    AUTO: false,
    PELLET_COUNT: 8,
    FIRE_INTERVAL_TICKS: 40, // 90 RPM
    DAMAGE: 32, // PER PELLET. 8×32 = 256/blast → 3 blasts @700 → 1.333s [IN BAND]
    /**
     * 1.25, not §6.2's blanket ×1.5, and capped to ONE pellet per blast.
     * At ×1.5 per pellet a full head blast is 384, which two-shots both 550 and
     * 700 HP for a 0.667s TTK — precisely the CoD-class TTK §6.1 rejects. The
     * threshold is unforgiving: any per-shot bonus above +36.7% two-shots the
     * 700 reference, above +7.4% two-shots a naked 550.
     */
    HEADSHOT_MULT_OVERRIDE: 1.25,
    HEADSHOT_PELLET_CAP: 1,
    MAX_SHOT_DAMAGE_ALL_HEAD: 264, // 7×32 + 40. 2×264 = 528 < 550 → 3 shots even vs a naked hero
    MAG_SIZE: 6,
    RELOAD_TICKS: 144, // whole-mag, not per-shell — determinism + cancel rules
    FALLOFF_START_M: 8,
    FALLOFF_END_M: 20,
    FALLOFF_END_MULT: 0.2,
    BASE_SPREAD_DEG: 3.2,
    ADS_SPREAD_DEG: 2.4,
    PELLET_RING_RADIUS_FRAC: 0.62, // 1 centre pellet + 7 on a ring
    PELLET_JITTER_ANGLE_DEG: 25,
    PELLET_JITTER_RADIAL_FRAC: 0.18,
    SPREAD_PER_SHOT_DEG: 0.6,
    SPREAD_MAX_DEG: 6.0,
    SPREAD_DECAY_DEG_PER_S: 3.0,
    SPREAD_DECAY_DELAY_TICKS: 12,
    SPREAD_MOVE_MULT: 1.2, // barely cares — "walks at you"
    SPREAD_AIR_MULT: 1.4,
    RECOIL_VERTICAL_DEG: 2.2,
    RECOIL_HORIZONTAL_DEG: 0.9,
    RECOIL_ACCUM_MAX_DEG: 6.0,
    RECOIL_RECOVERY_DEG_PER_S: 7.0, // net zero climb between shells
    RECOIL_RECOVERY_DELAY_TICKS: 12,
    STRUCTURE_DAMAGE_MULT: 0.4,
    ORB_DAMAGE: 13, // PER PELLET. 8×13 = 104 ≥ orb HP; 7 pellets = 91 = fail → a hard 8m claim wall
  },

  // ------------------------------------------------------------------------
  // RIFT — Launcher. Projectile + splash.
  // ------------------------------------------------------------------------
  LAUNCHER: {
    HITSCAN: false,
    AUTO: false,
    PELLET_COUNT: 1,
    /**
     * 36 ticks (100 RPM), NOT the PRD's 60 RPM. At 60 RPM the impact-to-impact
     * TTK quantises to 1.0 / 2.0 / 3.0s and no damage value lands in the
     * interior of the 1.2–2.0s band at all. 36 ticks gives a 0.6s quantum, so
     * 1.2s and 1.8s both land. 40 ticks also works but its 5-shot case is
     * 2.667s, breaking the 2.6s ceiling at 1000 HP.
     */
    FIRE_INTERVAL_TICKS: 36,
    DAMAGE: 210, // direct impact. 700/210 → 4 → 3×0.6 = 1.800s [IN BAND]
    MAG_SIZE: 5,
    RELOAD_TICKS: 156,
    FALLOFF_START_M: 999, // PRD "Flat" — no range falloff
    FALLOFF_END_M: 1000,
    FALLOFF_END_MULT: 1.0,
    PROJECTILE_SPEED_MPS: 45,
    PROJECTILE_RADIUS_M: 0.15, // REQUIRES SWEPT COLLISION — 0.75 m/tick vs a 0.80m capsule
    PROJECTILE_LIFETIME_TICKS: 144,
    PROJECTILE_GRAVITY_MPS2: 0,
    SPLASH_RADIUS_M: 3.0,
    SPLASH_DAMAGE_CENTER: 90, // 8 splashes to kill 700 → chip and zoning, not a kill route
    SPLASH_DAMAGE_EDGE: 30,
    SPLASH_EXCLUDES_DIRECT_TARGET: true, // a direct hit takes 210, not 210+90
    SPLASH_SELF_DAMAGE_MULT: 0,
    SPLASH_ORB_DAMAGE: 0, // splash cannot claim orbs. Direct hit or nothing.
    BASE_SPREAD_DEG: 0.9,
    ADS_SPREAD_DEG: 0.35,
    SPREAD_PER_SHOT_DEG: 0.2,
    SPREAD_MAX_DEG: 1.8,
    SPREAD_DECAY_DEG_PER_S: 3.0,
    SPREAD_DECAY_DELAY_TICKS: 12,
    SPREAD_MOVE_MULT: 1.8,
    SPREAD_AIR_MULT: 2.2,
    RECOIL_VERTICAL_DEG: 1.3,
    RECOIL_HORIZONTAL_DEG: 0.5,
    RECOIL_ACCUM_MAX_DEG: 4.0,
    RECOIL_RECOVERY_DEG_PER_S: 6.0,
    RECOIL_RECOVERY_DELAY_TICKS: 12,
    STRUCTURE_DAMAGE_MULT: 1.0, // RIFT is the sieger
    ORB_DAMAGE: 110, // one direct hit claims. Hardest claim in the game.
  },

  // ------------------------------------------------------------------------
  // MELEE — universal. §7.1 makes it an economy input ("or melee it"); §6.4
  // never gave it a key, damage, range or cooldown. This settles all of it.
  // ------------------------------------------------------------------------
  MELEE: {
    RANGE_M: 3.0,
    RANGE_TPS_BONUS_M: 0.5, // 3.5m in TPS — implements §5.1's "TPS best for … melee"
    CONE_HALF_ANGLE_DEG: 45, // forgiving: this is a claim tool, not a duel tool
    WINDUP_TICKS: 6,
    TOTAL_TICKS: 27,
    COOLDOWN_TICKS: 54,
    HERO_DAMAGE: 75, // 10 swings to kill 700 — never a kill tool
    STRUCTURE_DAMAGE: 0, // prevents melee backdoor
    ORB_DAMAGE: 100, // always claims in one swing
    CANCELS_RELOAD: false,
    BLOCKED_WHILE_DASHING: false, // dash-melee an orb is a legal, and good, clip
  },

  // ------------------------------------------------------------------------
  // TTK BENCH — makes M3's acceptance criterion mechanically evaluable.
  // ------------------------------------------------------------------------
  TTK_BENCH: {
    TARGET_HP_PRIMARY: 700, // 550 base + one T1 HP item
    TARGET_HP_FLOOR: 550,
    TARGET_HP_CEILING: 1000,
    BAND_MIN_S: 1.2,
    BAND_MAX_S: 2.0,
    BAND_MAX_S_AT_CEILING: 2.6, // the band is a curve, not a point
    /** first-damage-to-death, NOT trigger-to-death: otherwise the Launcher's
     *  TTK is a function of range (geometry) rather than of balance. */
    MEASURE_MODE: 'first-damage-to-death',
    SHOT_PLACEMENT: 'body',
    ALL_PELLETS_CONNECT: true, // state it, or the shotgun row is a lie
    REGEN_DISABLED: true,
    BENCH_DISTANCE_M: { SMG: 15, RIFLE: 30, SHOTGUN: 6, LAUNCHER: 18 },
  },
} as const;

// ============================================================================
// M0 TARGET RANGE — the grey box. Not shipped content; this is the fun gate.
// ============================================================================
export const M0 = {
  TARGET_HP: 700, // the TTK reference target, so M0 measures the real number
  TARGET_RESPAWN_TICKS: 120, // 2.0s
  ARENA_HALF_X_M: 40,
  ARENA_HALF_Z_M: 28,
  ARENA_WALL_HEIGHT_M: 12,
} as const;
