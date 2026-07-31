/**
 * balance.ts — ⭐ EVERY tunable number in OVRRUN. PRD §10.2, §13.
 *
 * Rules:
 *   - Pure data. No imports, no logic beyond the three derived functions at the
 *     bottom, each of which genuinely needs to be a function.
 *   - Never tune balance outside this file (PRD §13).
 *   - Every periodic value is an INTEGER TICK COUNT at 60Hz. If a value cannot
 *     be expressed as one, it is the wrong value.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RECONCILIATION NOTE
 *
 * Five domains derived these numbers in parallel against a shared spine, each
 * assuming values for the others' outputs. Two independent cross-verifiers then
 * checked the union and both returned "not coherent enough to author from":
 * eleven assumptions came back wrong, and every one was a case where both
 * files would land here and one would silently win.
 *
 * Each resolution below is marked ⚖. Where the two verifiers disagreed with
 * each other, the reasoning is spelled out — those are design calls, not
 * arithmetic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ============================================================================
// SPINE — the anchors everything derives from. Changing one is a design
// decision, not a tuning pass.
// ============================================================================
export const SPINE = {
  SIM_HZ: 60,
  TICK_S: 1 / 60,
  MINUTE_TICKS: 3600,

  SNAPSHOT_INTERVAL_TICKS: 3, // 20Hz
  VISIBILITY_INTERVAL_TICKS: 4, // 15Hz, tick-locked (PRD §5.3)

  MATCH_TARGET_S: 720,
  MATCH_TARGET_TICKS: 43_200,
  SUDDEN_DEATH_TICK: 54_000, // 15:00

  HERO_BASE_HP: 550,
  HERO_ITEMIZED_HP_CEILING: 1000, // PRD v1.0 said ~1600; the item table cannot reach it

  /** HP and damage are integer milli-units; multipliers integer permille. */
  DAMAGE_SCALE: 1000,
  PERMILLE: 1000,
  /** Positions integrate in integer millimetres. */
  POS_SCALE_MM: 1000,

  /**
   * ⚖ THE DAMAGE PIPELINE — specified twice, incompatibly. Weapons used
   * millidamage with truncation after every multiply; abilities used integer HP
   * with a single floor at the end. On an SMG shot at 40m with Hollowpoint that
   * is 19.494 vs 19 damage — 799 vs 779 over a kill, a 2.6% TTK difference and
   * a different shot count.
   *
   * Millidamage wins: it IS the byte-identical determinism contract, and it is
   * what already shipped.
   */
  PIPELINE: 'base × falloff × headshot × (1 + Σ additive percent bonuses)',
  ROUNDING: 'integer millidamage throughout; trunc toward zero after each multiply',
} as const;

// ============================================================================
// ENTITY — hero dimensions.
// ============================================================================
export const ENTITY = {
  CAPSULE_RADIUS_M: 0.4,
  CAPSULE_HEIGHT_M: 1.8,
  CROUCH_HEIGHT_M: 1.1,
  SLIDE_HEIGHT_M: 1.1,

  EYE_HEIGHT_M: 1.62, // FPS camera origin AND the head-LOS ray origin (§5.3)
  /**
   * ⚖ 0.14 @ 1.62, not world's 0.19 @ 1.66. The verifier flagged that weapons
   * solved every spread value against the smaller head and recommended adopting
   * the larger one — but that inverts HALO's identity: at r=0.19 the Rifle's
   * 0.12° ADS cone is a *guaranteed* headshot at 70m rather than "the skill
   * check". 0.14m radius is a 28cm head, already generous; 0.19 is 38cm.
   * Keeping the smaller head also means no spread value needs re-solving, and
   * it preserves the M0 feel that passed its gate.
   */
  HEAD_SPHERE_RADIUS_M: 0.14,
  HEAD_SPHERE_CENTER_M: 1.62,

  MUZZLE_FORWARD_M: 0.35, // bullets originate here in world space, never at the camera
  MUZZLE_HEIGHT_M: 1.45,
} as const;

// ============================================================================
// MOVEMENT
// ============================================================================
export const MOVEMENT = {
  BASE_SPEED_MPS: 6.0,
  ADS_SPEED_MULT: 0.6,
  AIR_SPEED_MULT: 0.9,

  GROUND_ACCEL_MPS2: 60.0,
  GROUND_FRICTION_MPS2: 55.0,
  AIR_ACCEL_MPS2: 12.0,
  MAX_AIR_SPEED_GAIN_MPS: 1.2,

  GRAVITY_MPS2: -22.0,
  JUMP_VELOCITY_MPS: 7.2, // apex 1.18m
  COYOTE_TICKS: 6,
  JUMP_BUFFER_TICKS: 6,

  STEP_HEIGHT_M: 0.35,
  MAX_GROUND_SLOPE_COS: 0.6, // ~53°

  // --- Dash (PRD §6.4) ---
  DASH_CHARGES: 2,
  DASH_RECHARGE_TICKS: 480, // 8.0s
  DASH_DISTANCE_M: 6.0,
  DASH_DURATION_TICKS: 12,
  DASH_IFRAME_TICKS: 15, // 0.25s
  DASH_COOLDOWN_TICKS: 18,
  DASH_PRESERVES_SPEED_FRAC: 0.55,
  DASH_PITCH_CLAMP_DEG: 35, // a 6m dash at 35° lifts 3.44m — clears the 3.0m pit rim

  // --- Slide ---
  SLIDE_MIN_ENTRY_SPEED_MPS: 5.0, // > ADS speed 3.6, so you can never slide out of ADS
  SLIDE_ENTRY_SPEED_MULT: 1.35,
  SLIDE_MIN_EXIT_SPEED_FRAC: 0.6,
  SLIDE_DURATION_TICKS: 54,
  SLIDE_COOLDOWN_TICKS: 90,
  /** 3.0, not 6.0: at 6.0 an 8.1 m/s entry decayed below walking speed within
   *  0.6s, making slide a crouch animation rather than movement tech. Caught by
   *  M0's "preserves ≥80% of entry speed" criterion. */
  SLIDE_FRICTION_MPS2: 3.0,
  SLIDE_CANCELLABLE_INTO_DASH: true,

  /**
   * --- Vault / mantle: a three-tier vertical vocabulary, all GEOMETRIC.
   *   ≤ 1.18m   jump onto it
   *   0.35–1.2m vault, weapon live (vault-over-cover-and-shoot is a clip)
   *   1.2–3.2m  mantle, weapon locked
   *   > 3.2m    needs a zipline, a dash, or VOLT's grapple
   *
   * Replaces PRD §4.1's "4 mantle points". Scripted markers are a level-design
   * liability and the MID PIT already needed a fifth the document never listed.
   * The 3.2m ceiling is what makes the pit rim (3.0m) and cover→roof (3.0m)
   * climbable without a special case.
   */
  VAULT_MIN_HEIGHT_M: 0.35,
  VAULT_MAX_HEIGHT_M: 1.2,
  VAULT_DURATION_TICKS: 15,
  VAULT_WEAPON_LOCKED: false,
  VAULT_MOMENTUM_RETAIN: 1.0,

  MANTLE_MIN_HEIGHT_M: 1.2,
  MANTLE_MAX_HEIGHT_M: 3.2,
  MANTLE_REACH_M: 1.0,
  MANTLE_MIN_LEDGE_DEPTH_M: 0.6,
  /** duration = BASE + ceil(PER_M × (h − 1.2)) — integer ticks for any ledge. */
  MANTLE_BASE_TICKS: 27,
  MANTLE_TICKS_PER_M: 9,
  MANTLE_MAX_DURATION_TICKS: 45,
  MANTLE_WEAPON_LOCKED: true,
  MANTLE_RECOVERY_TICKS: 12,
  MANTLE_MOMENTUM_RETAIN: 0.0,
  /** 44 + 12 ticks + re-accel ≈ PRD §4.1's "~1.2s of vulnerability" exiting the pit. */
  PIT_EXIT_NO_FIRE_TICKS: 56,

  // --- Zipline ---
  ZIPLINE_ATTACH_RANGE_M: 4.0,
  ZIPLINE_ATTACH_TICKS: 15,
  ZIPLINE_SPEED_MPS: 16.0,
  ZIPLINE_ACCEL_TICKS: 30,
  ZIPLINE_TEAM_NEUTRAL: true, // blocking a line at 3v3 is oppressive
  ZIPLINE_CAN_FIRE: true,
  ZIPLINE_CAN_ADS: false,
  ZIPLINE_DISMOUNT_ON_JUMP: true,
  ZIPLINE_DISMOUNT_DAMAGE_THRESHOLD: 60,
  ZIPLINE_DISMOUNT_LAUNCH_CAP_MPS: 12.0,
  ZIPLINE_REATTACH_COOLDOWN_TICKS: 60,
} as const;

// ============================================================================
// CAMERA — PRD §5. The axis is mobility vs precision.
// ============================================================================
export const CAMERA = {
  TPS_DISTANCE_M: 3.5,
  TPS_RIGHT_OFFSET_M: 0.6,
  TPS_HEIGHT_M: 1.55,
  TPS_FOV_DEG: 95,

  FPS_FOV_DEG: 80,
  ADS_FOV_DEG: 65,

  TRANSITION_TICKS: 9, // 0.15s (§5.2), never blocked
  ADS_ENTER_TICKS: 12,
  ADS_EXIT_TICKS: 9,

  /** 1.0, not §5.1 v1.0's ×1.4. With the penalty TPS had only downsides in a
   *  fight, so the dominant macro was TPS traversal + RMB for every engagement:
   *  zero V presses, signature mechanic reduced to a traversal camera. Raise
   *  this if TPS dominates; it is the one constant that reverts the decision. */
  TPS_HIPFIRE_SPREAD_MULT: 1.0,

  SPRING_ARM_RADIUS_M: 0.25,
  SPRING_ARM_PULL_SPEED_MPS: 40.0,

  SILHOUETTE_HOLD_TICKS: 24, // 0.4s
  VIS_HYSTERESIS_SAMPLES: 2,
  VIS_MIN_DWELL_TICKS: 12,
  VIS_RAY_TARGETS: 3, // head / chest / feet
} as const;

// ============================================================================
// COMBAT — weapons, spread, recoil, headshots, reloads, melee.
// ============================================================================
export const COMBAT = {
  HEADSHOT_MULT_HITSCAN: 1.5,
  HEADSHOT_MULT_PROJECTILE: 1.0,
  HEADSHOT_MULT_ABILITY: 1.0,
  HEADSHOT_MULT_MELEE: 1.0,
  LIMB_MULT: 1.0, // no limb penalty — Pillar P4 legibility
  MIN_DAMAGE_MILLI: 1000,

  /** §6.2. Missing from the first build, and its absence was not subtle: a bot
   *  that dropped below its retreat threshold never recovered, so it walked
   *  backwards into its own core and stayed there for the rest of the match. */
  REGEN_FRAC_PER_S: 0.02,
  REGEN_OUT_OF_COMBAT_TICKS: 300, // 5.0s

  SPREAD_MOVE_SPEED_REF_MPS: 6.0,
  SPREAD_DASH_TAIL_TICKS: 12,

  RELOAD_CANCEL_ON_FIRE: false,
  RELOAD_CANCEL_ON_DASH: true, // dash IS the escape hatch
  RELOAD_CANCEL_ON_ABILITY: true,
  RELOAD_CANCEL_ON_MELEE: false, // reload + melee an orb without losing the reload
  RELOAD_CANCEL_ON_DAMAGE: false, // else you are reload-locked under suppression
  RELOAD_CANCEL_ON_STUN: true,
  RELOAD_PARTIAL_CREDIT: false, // commit or don't
  RELOAD_EMPTY_PENALTY_TICKS: 15,
  POST_RELOAD_LOCKOUT_TICKS: 3,
  AUTO_RELOAD_ON_EMPTY_DELAY_TICKS: 12,
  RESERVE_AMMO: -1, // −1 sentinel = infinite. Never Infinity.

  ADS_AVAILABLE_IN_TPS: false,
  ADS_BLOCKED_WHILE_DASHING: true,

  FALLOFF_APPLIES_TO_ORBS: true,
  /** ⚖ false, not weapons' true. World set structures to ignore falloff so one
   *  siege-DPS number is valid for all four archetypes — the assumption its
   *  whole match-length model rests on. Under falloff BULWARK cannot siege at
   *  all past 8m, which double-punishes it: the per-weapon STRUCTURE_DAMAGE_MULT
   *  already encodes archetype siege identity. */
  FALLOFF_APPLIES_TO_STRUCTURES: false,

  // ------------------------------------------------------------------------
  // VOLT — SMG. Hitscan, full auto.
  // ------------------------------------------------------------------------
  SMG: {
    HITSCAN: true, AUTO: true, PELLET_COUNT: 1,
    FIRE_INTERVAL_TICKS: 5, // 720 RPM — survives 60Hz exactly
    DAMAGE: 38, // 19 shots @700HP → 18/12 = 1.500s [IN BAND]
    MAG_SIZE: 32,
    RELOAD_TICKS: 84,
    FALLOFF_START_M: 18, FALLOFF_END_M: 40, FALLOFF_END_MULT: 0.45,
    BASE_SPREAD_DEG: 1.5, ADS_SPREAD_DEG: 0.7,
    SPREAD_PER_SHOT_DEG: 0.09, SPREAD_MAX_DEG: 2.6,
    SPREAD_DECAY_DEG_PER_S: 4.0, SPREAD_DECAY_DELAY_TICKS: 6,
    SPREAD_MOVE_MULT: 1.8, SPREAD_AIR_MULT: 2.0,
    RECOIL_VERTICAL_DEG: 0.28, RECOIL_HORIZONTAL_DEG: 0.22,
    RECOIL_ACCUM_MAX_DEG: 6.0, RECOIL_RECOVERY_DEG_PER_S: 9.0,
    RECOIL_RECOVERY_DELAY_TICKS: 6, // the only weapon that truly climbs
    STRUCTURE_DAMAGE_MULT: 0.35,
  },

  // ------------------------------------------------------------------------
  // HALO — Rifle. Hitscan, semi-auto.
  // ------------------------------------------------------------------------
  RIFLE: {
    HITSCAN: true, AUTO: false, PELLET_COUNT: 1,
    FIRE_INTERVAL_TICKS: 15, // 240 RPM
    DAMAGE: 104, // 7 shots @700HP → 6/4 = 1.500s [IN BAND]
    MAG_SIZE: 15,
    RELOAD_TICKS: 108,
    FALLOFF_START_M: 45, FALLOFF_END_M: 70, FALLOFF_END_MULT: 0.7,
    BASE_SPREAD_DEG: 1.1, ADS_SPREAD_DEG: 0.12,
    SPREAD_PER_SHOT_DEG: 0.22, SPREAD_MAX_DEG: 2.4,
    SPREAD_DECAY_DEG_PER_S: 3.5, SPREAD_DECAY_DELAY_TICKS: 10,
    SPREAD_MOVE_MULT: 2.4, SPREAD_AIR_MULT: 3.0, // HALO plants or misses
    RECOIL_VERTICAL_DEG: 0.85, RECOIL_HORIZONTAL_DEG: 0.35,
    RECOIL_ACCUM_MAX_DEG: 5.0, RECOIL_RECOVERY_DEG_PER_S: 6.5,
    RECOIL_RECOVERY_DELAY_TICKS: 10,
    STRUCTURE_DAMAGE_MULT: 0.6,
  },

  // ------------------------------------------------------------------------
  // BULWARK — Shotgun. 8 hitscan pellets.
  // ------------------------------------------------------------------------
  SHOTGUN: {
    HITSCAN: true, AUTO: false, PELLET_COUNT: 8,
    FIRE_INTERVAL_TICKS: 40, // 90 RPM
    DAMAGE: 32, // PER PELLET. 256/blast → 3 blasts @700 → 1.333s [IN BAND]
    /** ⚖ 1.25 capped to ONE pellet, not §6.2's blanket ×1.5. At ×1.5 per pellet
     *  a full head blast is 384, two-shotting both 550 and 700 HP for a 0.667s
     *  TTK — exactly the CoD-class TTK §6.1 rejects. Any per-shot head bonus
     *  above +36.7% two-shots the 700 reference. Abilities' pipeline must carry
     *  this exception explicitly. */
    HEADSHOT_MULT_OVERRIDE: 1.25,
    HEADSHOT_PELLET_CAP: 1,
    MAX_SHOT_DAMAGE_ALL_HEAD: 264, // 2×264 = 528 < 550 → 3 shots even vs a naked hero
    MAG_SIZE: 6,
    RELOAD_TICKS: 144, // whole-mag, not per-shell — determinism + cancel rules
    FALLOFF_START_M: 8, FALLOFF_END_M: 20, FALLOFF_END_MULT: 0.2,
    BASE_SPREAD_DEG: 3.2, ADS_SPREAD_DEG: 2.4,
    PELLET_RING_RADIUS_FRAC: 0.62, // 1 centre + 7 on a ring
    PELLET_JITTER_ANGLE_DEG: 25, PELLET_JITTER_RADIAL_FRAC: 0.18,
    SPREAD_PER_SHOT_DEG: 0.6, SPREAD_MAX_DEG: 6.0,
    SPREAD_DECAY_DEG_PER_S: 3.0, SPREAD_DECAY_DELAY_TICKS: 12,
    SPREAD_MOVE_MULT: 1.2, SPREAD_AIR_MULT: 1.4, // barely cares — "walks at you"
    RECOIL_VERTICAL_DEG: 2.2, RECOIL_HORIZONTAL_DEG: 0.9,
    RECOIL_ACCUM_MAX_DEG: 6.0, RECOIL_RECOVERY_DEG_PER_S: 7.0,
    RECOIL_RECOVERY_DELAY_TICKS: 12,
    STRUCTURE_DAMAGE_MULT: 0.4,
  },

  // ------------------------------------------------------------------------
  // RIFT — Launcher. Projectile + splash.
  // ------------------------------------------------------------------------
  LAUNCHER: {
    HITSCAN: false, AUTO: false, PELLET_COUNT: 1,
    /** 36 ticks (100 RPM), NOT the PRD's 60 RPM: at 60 RPM impact-to-impact TTK
     *  quantises to 1.0/2.0/3.0s and no damage value lands inside 1.2–2.0s. */
    FIRE_INTERVAL_TICKS: 36,
    DAMAGE: 210, // 4 rockets @700HP → 3×0.6 = 1.800s [IN BAND]
    MAG_SIZE: 5,
    RELOAD_TICKS: 156,
    FALLOFF_START_M: 999, FALLOFF_END_M: 1000, FALLOFF_END_MULT: 1.0, // "Flat"
    PROJECTILE_SPEED_MPS: 45,
    PROJECTILE_RADIUS_M: 0.15, // REQUIRES SWEPT COLLISION — 0.75 m/tick vs a 0.80m capsule
    PROJECTILE_LIFETIME_TICKS: 144,
    PROJECTILE_GRAVITY_MPS2: 0,
    SPLASH_RADIUS_M: 3.0,
    SPLASH_DAMAGE_CENTER: 90, // chip and zoning, not a kill route
    SPLASH_DAMAGE_EDGE: 30,
    SPLASH_EXCLUDES_DIRECT_TARGET: true,
    SPLASH_SELF_DAMAGE_MULT: 0,
    BASE_SPREAD_DEG: 0.9, ADS_SPREAD_DEG: 0.35,
    SPREAD_PER_SHOT_DEG: 0.2, SPREAD_MAX_DEG: 1.8,
    SPREAD_DECAY_DEG_PER_S: 3.0, SPREAD_DECAY_DELAY_TICKS: 12,
    SPREAD_MOVE_MULT: 1.8, SPREAD_AIR_MULT: 2.2,
    RECOIL_VERTICAL_DEG: 1.3, RECOIL_HORIZONTAL_DEG: 0.5,
    RECOIL_ACCUM_MAX_DEG: 4.0, RECOIL_RECOVERY_DEG_PER_S: 6.0,
    RECOIL_RECOVERY_DELAY_TICKS: 12,
    STRUCTURE_DAMAGE_MULT: 1.0, // RIFT is the sieger
  },

  // ------------------------------------------------------------------------
  // MELEE — universal. §7.1 makes it an economy input; §6.4 gave it nothing.
  // ------------------------------------------------------------------------
  MELEE: {
    RANGE_M: 3.0,
    RANGE_TPS_BONUS_M: 0.5, // implements §5.1's "TPS best for … melee"
    CONE_HALF_ANGLE_DEG: 45, // a claim tool, not a duel tool
    WINDUP_TICKS: 6, TOTAL_TICKS: 27, COOLDOWN_TICKS: 54,
    HERO_DAMAGE: 75, // 10 swings to kill 700 — never a kill tool
    STRUCTURE_DAMAGE: 0, // prevents melee backdoor
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
    /**
     * ⚖ THE BAND IS A BASE-KIT REFERENCE, and §6.1 never said so — which is
     * what produced the Overcharge conflict. Abilities cut VOLT's E from +40%
     * to +30% to protect the 1.2s floor and constrained SMG DPS as the price;
     * weapons then shipped a faster SMG, and on the gun that actually exists
     * +30% gives 1.154s. But *every* variant breaks the floor once items are
     * added, because a power spike is supposed to. So the band is asserted
     * against base kit, no items, no buffs — and a separate, looser floor
     * guards the fully-stacked case so it can never reach CoD territory.
     */
    BUFFED_ITEMIZED_FLOOR_S: 0.85,
    MEASURE_MODE: 'first-damage-to-death',
    SHOT_PLACEMENT: 'body',
    ALL_PELLETS_CONNECT: true,
    REGEN_DISABLED: true,
    BENCH_DISTANCE_M: { SMG: 15, RIFLE: 30, SHOTGUN: 6, LAUNCHER: 18 },
    /**
     * ⚖ Three domains derived everything from a single REFERENCE_DPS = 437.5.
     * None of the four shipped weapons is 437.5. The verifier called the
     * shotgun "+20% out of band" and proposed retuning it — but that measures
     * *burst* DPS, which is the wrong metric for a 1.5 shots/sec weapon: the
     * shotgun's TTK is 1.333s (in band) and its sustained DPS including reload
     * is 268, the LOWEST of the four. Publishing the vector is the fix; the
     * shotgun is not retuned.
     */
    BURST_DPS: { SMG: 456.0, RIFLE: 416.0, SHOTGUN: 384.0, LAUNCHER: 350.0 },
    /** magazine ÷ (dump time + reload) — the number siege models must use. */
    SUSTAINED_DPS: { SMG: 305.0, RIFLE: 294.3, SHOTGUN: 268.0, LAUNCHER: 210.0 },
    /** ⚖ 0.669, not world's 0.78. Recomputed from the shipped magazines and
     *  reloads; 0.78 overstated hero throughput by 16.6% and every row of the
     *  siege table inherited the error. */
    SIEGE_RELOAD_UPTIME: 0.669,
  },
} as const;

// ============================================================================
// ECONOMY — souls. PRD §7.
// ============================================================================
export const ECONOMY = {
  STARTING_SOULS: 0,
  TARGET_GROSS_PER_PLAYER: 4500,

  /**
   * PASSIVE TRICKLE — the P2 violation, fixed.
   * PRD v1.0's 12/s per team = 4/s per player = 2,880 per match, which was
   * ~58% of all income and more than every soul orb in the match combined.
   * Cut 3.2×. Granted as an integer every 48 ticks so nothing accumulates in
   * floating point, and 48 divides the 3-tick snapshot interval.
   */
  PASSIVE_GRANT_SOULS: 1,
  PASSIVE_GRANT_INTERVAL_TICKS: 48, // 1.25/s per player, 3.75/s per team
  PASSIVE_PAYS_WHILE_DEAD: true, // this IS the floor; it is the only uncontestable income
  PASSIVE_SURGE_ELIGIBLE: false, // keeps the ≤25% cap true in every game state
  PASSIVE_TOTAL_PER_PLAYER: 900, // 20.1% of realized gross — under the P2 ceiling

  // --- Soul orbs ---------------------------------------------------------
  /** OWNERSHIP: §7.1 never stated it, so "deny" had no referent. An orb from a
   *  dead trooper is owned by the OPPOSING team — deterministic, symmetric
   *  (4 orbs per team per wave), and it renders in the owner's colour. */
  ORB_OWNER_IS_DEAD_TROOPER_ENEMY: true,
  ORB_HOVER_TICKS: 180, // 3.0s (§7.1 said 2.5s; extended so slow weapons fit the window)
  ORB_ARM_DELAY_TICKS: 15, // invulnerable on spawn — kills bullet-already-in-flight luck
  ORB_HITBOX_RADIUS_M: 0.6,
  ORB_EXPIRE_SOULS: 0, // unclaimed orbs pay nobody

  /**
   * ⚖ CLAIM RESOLUTION — the conflict the two verifiers split on.
   * Economy shipped ORB_HP 120; weapons derived its whole table against an
   * assumed 100. Cross-applied, the Launcher (110 < 120) and the Shotgun
   * (8×13 = 104 < 120) claim nothing and melee stops working — 44% of income
   * broken three ways. Coherence said take 120 + economy's table; matchsim said
   * take 100 + weapons'.
   *
   * 120 + economy's table wins, because it is exact against weapons' REAL tick
   * intervals and gives a wider spread of committed time, which is what makes
   * the contest a decision rather than a reflex:
   *   SMG  5 shots × 5t  = 20t = 0.333s
   *   RIFLE 3 shots × 15t = 30t = 0.500s
   *   SHOTGUN 1 blast (8×20 = 160 ≥ 120), inside falloff
   *   LAUNCHER 1 direct hit
   *   MELEE 1 swing
   * An HP pool at all is the load-bearing part: under one-hit-claims a 720 RPM
   * hitscan gets 12 claim attempts/sec against the Launcher's 1/sec, so the
   * plurality income source would be a function of hero pick.
   */
  ORB_HP: 120,
  /** Two independent counters. Owner damage fills claimProgress, enemy damage
   *  fills denyProgress — never the same pool, or chipping an enemy's orb would
   *  help them claim it. */
  ORB_DUAL_PROGRESS: true,
  /**
   * ⚖ Economy said orb damage ignores the whole pipeline; weapons said falloff
   * applies. Both marked SETTLED, directly opposite. Split the flag — they were
   * protecting different things. Economy's real concern is an
   * itemization→faster-farm spiral; weapons' is BULWARK's range gate.
   */
  ORB_DAMAGE_IGNORES_ITEM_BONUSES: true, // no % items, no headshot, no ability damage
  ORB_DAMAGE_APPLIES_FALLOFF: true, // orb damage = BASE × FALLOFF, nothing else
  ORB_DAMAGE_SMG: 24,
  ORB_DAMAGE_RIFLE: 40,
  ORB_DAMAGE_SHOTGUN_PER_PELLET: 20,
  ORB_DAMAGE_LAUNCHER_DIRECT: 120,
  /** ⚖ 0, not economy's 40. Both verifiers agreed: 3m splash from 40m with zero
   *  aim deletes §7.1's mini-duel, and the orb budget does not depend on it
   *  while Pillar P2 does. RIFT claims by direct hit only.
   *  Note BULWARK's wall lands at ~11.75m, not 8m: 8×20 = 160 needs falloff
   *  ≥ 0.75, which the shotgun curve reaches at 11.75m. */
  ORB_DAMAGE_LAUNCHER_SPLASH: 0,
  ORB_DAMAGE_MELEE: 120,
  ORB_DAMAGE_ABILITY: 0, // orb contest is a gunplay mechanic or it is nothing
  SHOTGUN_ORB_WALL_M: 11.75,

  /** Value ramps by floored match minute so late waves are not dead income. */
  ORB_CLAIM_BY_MINUTE: [32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88],
  ORB_DENY_BY_MINUTE: [16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44],
  ORB_VALUE_MINUTE_CLAMP: 14,

  /** Implements §6.2's own sentence ("sustain comes from items and soul
   *  pickups"), which its income table never delivered. Flat, not percent, so
   *  it matters most to the un-itemized player. The denier is by definition the
   *  one being pushed, so denying heals more — that is the poke-loser's
   *  recovery path in a game with no healers and no fog. */
  ORB_CLAIM_HEAL_HP: 30,
  ORB_DENY_HEAL_HP: 60,
  ORB_HEAL_RESETS_COMBAT_TIMER: false, // shooting an orb is not "in combat"

  ORB_DENY_STREAK_ANNOUNCE: 5, // "STARVED" (§9.3)

  // --- Kills -------------------------------------------------------------
  /** §7.3 paired "takedown 100 + bounty, split among participants" with a flat
   *  "Assist 60", so in a 3-player kill each assister netted 93 and the killer
   *  33. Nothing splits now. */
  TAKEDOWN_SOULS: 150, // killer only, plus the FULL bounty
  ASSIST_SOULS: 60, // every other participant, flat, never divided
  ASSIST_WINDOW_TICKS: 300, // 5s; participation = damage OR hard CC

  /** §7.4's +75 per TWO consecutive kills capped +450 needed 12 straight kills
   *  for the cap and 8 for the minimap reveal, against ~4 kills per player per
   *  match — both unreachable, so the reveal that creates the hunt never fired. */
  BOUNTY_PER_KILL: 65,
  BOUNTY_CAP: 390, // reachable at 6 straight
  BOUNTY_MINIMAP_REVEAL_AT: 130, // 2 straight — fires in most matches
  BOUNTY_ANNOUNCE_AT: 390,
  BOUNTY_RESETS_ON_DEATH: true,

  // --- Objectives (paid PER PLAYER, dead members included) ----------------
  TOWER_T1_SOULS_PER_PLAYER: 175, // §7.3's 200 team-wide was 67/player, less than one wave
  TOWER_T2_SOULS_PER_PLAYER: 250,
  CORE_SOULS_PER_PLAYER: 0, // the match is over
  MID_PIT_SOULS_PER_PLAYER: 350, // §7.3's 500 team was 167/player for "the biggest clip generator"
  MID_PIT_STEAL_TAKES_FULL_VALUE: true, // §9.4. No smite, no protection. Never balance away.
  MID_PIT_BUFF_GRANTS_INCOME: false, // an income buff would compound the swing and re-break P5

  // --- Death penalty -----------------------------------------------------
  /** §7.3's "−10% capped 200" was annotated "discourages hoarding" but went
   *  regressive above 2,000 unspent (10% → 7.7% at the T3 price → 5.0% at
   *  4,000) — the exact range where hoarding happens. Replaced with progressive
   *  marginal brackets set AT the item prices, so the rate is literally a
   *  function of what you could have bought and didn't. */
  DEATH_PENALTY_BRACKETS: [
    { FLOOR: 0, RATE_NUM: 0, RATE_DEN: 100 },
    { FLOOR: 400, RATE_NUM: 10, RATE_DEN: 100 },
    { FLOOR: 950, RATE_NUM: 20, RATE_DEN: 100 },
    { FLOOR: 1700, RATE_NUM: 35, RATE_DEN: 100 },
  ],
  DEATH_PENALTY_MAX: 1200, // binds only above 4,543 — more than a match's income
  DEATH_PENALTY_SOULS_ARE_DESTROYED: true,

  // --- Upgrades ----------------------------------------------------------
  UPGRADE_TIER_COST: [0, 400, 950, 1700],
  UPGRADE_SLOTS: 3,
  UPGRADE_COUNT: 12,
  UPGRADE_CAST_TICKS: 30, // 0.5s, cancels on damage, buyable anywhere (§7.5)
  /** Pay-the-difference replaces §7.5's replace-and-sell-at-60%. The haircut
   *  taxed laddering harder than the death penalty taxed hoarding — 473 souls
   *  cheaper to hoard, the exact opposite of the annotation. */
  UPGRADE_PAY_THE_DIFFERENCE: true,
  UPGRADE_SIDEGRADE_ALLOWED: false,
  UPGRADE_SELL_ALLOWED: false,
  UPGRADE_DUPLICATES_ALLOWED: false, // 3 copies also read as one model change (P4)
  UPGRADE_FULL_T3_BUILD_COST: 5100, // deliberately above the 4,500 income target
  UPGRADE_STRONG_GAME_BUILD_COST: 4350, // T3+T3+T2 — the realistic end state

  /** 4/4/4. §7.5 listed 11 against a stated 12, and its only HP item was +150
   *  at T1 (capping a build at 700 against a claimed ~1600) while its only DPS
   *  item was +12% fire rate — so HP scaled ×1.8 and damage ×1.12 and TTK
   *  lengthened monotonically all match. HP now exists at all three tiers
   *  (550 + 3×150 = 1000 = the spine ceiling exactly) and weapon damage exists
   *  at T2 and T3. */
  UPGRADES: [
    { ID: 'plate', TIER: 1, COST: 400, NAME: 'PLATE', MODS: { MAX_HP_FLAT: 150 } },
    { ID: 'hair_trigger', TIER: 1, COST: 400, NAME: 'HAIR TRIGGER', MODS: { FIRE_RATE_PCT: 0.12 } },
    { ID: 'kickstart', TIER: 1, COST: 400, NAME: 'KICKSTART', MODS: { DASH_CHARGES_FLAT: 1 } },
    { ID: 'fast_hands', TIER: 1, COST: 400, NAME: 'FAST HANDS', MODS: { RELOAD_SPEED_PCT: 0.18, MAGAZINE_PCT: 0.25 } },

    { ID: 'bulkhead', TIER: 2, COST: 950, NAME: 'BULKHEAD', MODS: { MAX_HP_FLAT: 150, REGEN_RATE_PCT: 0.25 } },
    { ID: 'hollowpoint', TIER: 2, COST: 950, NAME: 'HOLLOWPOINT', MODS: { WEAPON_DAMAGE_PCT: 0.14 } },
    { ID: 'siphon', TIER: 2, COST: 950, NAME: 'SIPHON', MODS: { LIFESTEAL_PCT: 0.12 } },
    { ID: 'kinetic_ward', TIER: 2, COST: 950, NAME: 'KINETIC WARD', MODS: {}, SPECIAL: 'SLOW_ROOT_IMMUNE_AFTER_DASH', SPECIAL_TICKS: 180 },

    { ID: 'aegis_core', TIER: 3, COST: 1700, NAME: 'AEGIS CORE', MODS: { MAX_HP_FLAT: 150 }, SPECIAL: 'CHEAT_DEATH_ONCE_PER_LIFE', SPECIAL_TICKS: 60 },
    { ID: 'overpressure', TIER: 3, COST: 1700, NAME: 'OVERPRESSURE', MODS: { WEAPON_DAMAGE_PCT_VS_LOW_HP: 0.2 }, THRESHOLD_HP_PCT: 0.4 },
    { ID: 'resonance', TIER: 3, COST: 1700, NAME: 'RESONANCE', MODS: { ABILITY_DAMAGE_PCT: 0.25 }, SPECIAL: 'ULT_CD_REFUND_ON_TAKEDOWN', SPECIAL_REFUND_PCT: 0.4 },
    { ID: 'breaker', TIER: 3, COST: 1700, NAME: 'BREAKER', MODS: { STRUCTURE_DAMAGE_PCT: 0.35, MID_PIT_DAMAGE_PCT: 0.35 } },
  ],
  /** All damage percents feed the SAME additive sum. FIRE_RATE_PCT does not —
   *  it scales cadence, not the damage number. */
  ITEM_MAX_ADDITIVE_DAMAGE_SUM: 0.34,
  ITEM_MAX_HP_STACK: 1000,

  // --- Respawn -----------------------------------------------------------
  RESPAWN_TICKS_BY_MINUTE: [480, 600, 720, 840, 960, 1080, 1200, 1320, 1440, 1500, 1500, 1500, 1500, 1500, 1500],
  RESPAWN_MINUTES_FLOORED: true,

  // --- SURGE (§9.5) ------------------------------------------------------
  /** §9.5 armed at >2,500 behind on TOTAL souls after 6:00 and disarmed below
   *  1,200 — a 1,300 swing that +15% could never produce (~1,031 across the
   *  whole remaining match), so it never disarmed; and the identical per-team
   *  trickle diluted the gap so it only armed in a ~62/38 stomp. */
  SURGE_GAP_METRIC: 'contestable_lifetime_earned', // excludes passive and the death sink
  SURGE_ARM_EARLIEST_TICK: 21_600, // 6:00
  SURGE_ARM_GAP: 1800,
  SURGE_DISARM_GAP: 900, // reachable hysteresis band
  SURGE_INCOME_BONUS_NUM: 140, // +40% on contestable income only
  SURGE_INCOME_BONUS_DEN: 100,
  SURGE_RESPAWN_MULT_NUM: 13, // ×0.65 — the losing team's real problem is being dead, not poor
  SURGE_RESPAWN_MULT_DEN: 20,
  SURGE_RESPAWN_APPLIES_AFTER_CAP: true,
  SURGE_ENEMY_BOUNTY_MULT_NUM: 3, // ×1.5 on every enemy while you surge — P5 in its purest form
  SURGE_ENEMY_BOUNTY_MULT_DEN: 2,
  SURGE_EVAL_INTERVAL_TICKS: 60,
  SURGE_MIN_DURATION_TICKS: 1200, // stops one kill flickering the aura mid-fight
  SURGE_DISABLED_IN_SUDDEN_DEATH: true,

  SOUL_GRANT_ORDER: ['BASE', 'DENY_RATIO', 'SURGE', 'CREDIT'],
  SOULS_WIRE_BITS: 14,
} as const;

// ============================================================================
// WORLD — map, troopers, structures, objective, sudden death. PRD §4.
// ============================================================================
export const WORLD = {
  MAP: {
    LANE_LENGTH_M: 220, // x ∈ [−110, +110]
    LANE_WIDTH_M: 35, // z ∈ [−17.5, +17.5]
    ROOF_HEIGHT_M: 6.0, // cover 3.0 + one 3.0m mantle
    COVER_BLOCK_HEIGHT_M: 3.0, // taller than a hero → a true sightline breaker
    COVER_BLOCK_SPACING_M: 15, // §4.1 "sightline breakers every ~15m"
    CORE_X_ABS_M: 100,
    TOWER_T2_X_ABS_M: 77, // 15% of the lane out from base
    TOWER_T1_X_ABS_M: 44, // 30%
    HERO_SPAWN_X_ABS_M: 106,
    TROOPER_SPAWN_X_ABS_M: 96,
    PIT_HALF_EXTENT_M: 11,
    PIT_DEPTH_M: 3.0, // rim is exactly one standard mantle
    PIT_CATWALK_WIDTH_M: 6.0, // creeps march straight over the pit
    ZIPLINE_COUNT: 2,
    ZIPLINE_Z_ABS_M: 14.0,
    ZIPLINE_Y_M: 7.5,
    ZIPLINE_X_ABS_END_M: 100,
    TUNNEL_COUNT_PER_SIDE: 2,
    TUNNEL_FLOOR_Y_M: -4.0, TUNNEL_HEIGHT_M: 3.0, TUNNEL_WIDTH_M: 4.0,
    TUNNEL_Z_ABS_M: 16.0,
    TUNNEL_ENTRY_X_ABS_M: 30, TUNNEL_EXIT_X_ABS_M: 58,
    TUNNEL_PATH_LENGTH_M: 95, // 15.8s vs 14.7s on the surface — a real trade
    TUNNEL_FOOTSTEP_GAIN_DB: 6, // §4.1 "footstep audio is loud in tunnels"
    FALL_DAMAGE_ENABLED: false, // dropping into the pit must never punish
  },

  TROOPERS: {
    FIRST_WAVE_TICK: 1800, // 0:30
    WAVE_INTERVAL_TICKS: 1500, // 25s
    UNITS_PER_WAVE: 4,
    SIEGE_WAVE_EVERY: 4,
    COMPOSITION_NORMAL: ['LINE', 'LINE', 'LINE', 'LANCER'],
    COMPOSITION_SIEGE: ['LINE', 'LINE', 'SIEGER', 'LANCER'], // swaps, never adds a 5th
    /** 4.0 m/s. NOT derived from lane length ÷ wave interval — only wave 1's
     *  clash location depends on speed; after that waves clash every 25s at the
     *  moving front regardless. Chosen for feel, then the clash was computed:
     *  2 × 96m closing at 8.0 m/s = 24.0s, so wave 1 meets at t=54s at x=0 —
     *  on the catwalk directly over the MID PIT. The first fight of the match
     *  happens at the objective. */
    MOVE_SPEED_MPS: 4.0,
    PATH_Z_M: 0,
    RETARGET_INTERVAL_TICKS: 30, // not every tick — cheap and deterministic
    TARGET_MIN_DWELL_TICKS: 60,
    RETALIATE_WINDOW_TICKS: 180,
    /** Damaging an allied TROOPER never redirects a wave — same ruling as
     *  towers. The other reading makes every last hit pull aggro. */
    RETALIATION_ALLY_MEANS_HERO_ONLY: true,
    BLOCKS_BULLETS: true, // a wave is mobile cover
    BLOCKS_HERO_MOVEMENT: false,
    HEADSHOTS_ENABLED: true, // last-hitting is aim practice with stakes (§7.2)
    HITBOX_RADIUS_M: 0.45, HITBOX_HEIGHT_M: 1.7,
    HEAD_SPHERE_RADIUS_M: 0.22, HEAD_SPHERE_CENTER_Y_M: 1.55,
    HP_SCALE_PER_WAVE: 0.025, STRUCT_DMG_SCALE_PER_WAVE: 0.025, SCALE_CAP_WAVE: 24,
    LINE: { HP: 320, DMG_VS_HERO: 18, DMG_VS_TROOPER: 20, DMG_VS_STRUCTURE: 14, ATTACK_INTERVAL_TICKS: 45, RANGE_M: 16, AGGRO_RADIUS_M: 20 },
    LANCER: { HP: 240, DMG_VS_HERO: 26, DMG_VS_TROOPER: 30, DMG_VS_STRUCTURE: 10, ATTACK_INTERVAL_TICKS: 96, RANGE_M: 26, AGGRO_RADIUS_M: 30 },
    SIEGER: { HP: 420, MOVE_SPEED_MPS: 3.2, DMG_VS_HERO: 30, DMG_VS_TROOPER: 30, DMG_VS_STRUCTURE: 90, ATTACK_INTERVAL_TICKS: 120, RANGE_M: 20, AGGRO_RADIUS_M: 22 },
    IGNORES_PIT_BOSS: true,
  },

  STRUCTURES: {
    /**
     * ⚖ Structure damage existed TWICE — a global ×0.55 here and per-weapon
     * multipliers in COMBAT. If they composed, mean hero siege DPS fell to 97.9
     * and the median match ran 19:07, past sudden death's own ceiling, so every
     * game would have resolved by decay timer. The per-weapon values win
     * (RIFT-as-sieger is real archetype identity), the global is deleted, and
     * the HP pool is rescaled by 0.80 to absorb both that and the corrected
     * 0.669 reload uptime.
     */
    TOWER_T1_HP: 12_400,
    TOWER_T2_HP: 16_200,
    CORE_HP: 21_000, // 49,600 total per side
    HEADSHOTS_ENABLED: false,

    TOWER_RANGE_M: 30, TOWER_REQUIRES_LOS: true, // cover genuinely shields a dive
    TOWER_ATTACK_INTERVAL_TICKS: 60,
    TOWER_ACQUIRE_DELAY_TICKS: 30, // the readable grace before shot 1
    TOWER_PROJECTILE_SPEED_MPS: 90, // 0.33s of travel at max range — legible, dodgeable
    TOWER_DMG_VS_HERO_BASE: 110,
    TOWER_DMG_VS_HERO_RAMP: 35, TOWER_DMG_VS_HERO_CAP: 180,
    // cumulative 110/255/435/615/795 → a 700 HP hero dies on shot 5 (4.5s of dive)
    TOWER_RAMP_DECAY_TICKS: 120,
    TOWER_RAMP_RESETS_ON_TARGET_SWITCH: false, // kills the tank-swap-by-plinking exploit
    TOWER_DMG_VS_TROOPER: 130,
    CORE_IS_ARMED: false,

    /** ⚖ SETTLED: "ally" in M2's "switch to hero on hero-damages-ally" means an
     *  allied HERO. The trooper reading re-aggros the tower on every last hit,
     *  which makes contesting souls under a tower impossible and falsifies P2
     *  in exactly the zone a pushed lane puts the contested farm. */
    AGGRO_ALLY_MEANS_HERO_ONLY: true,
    TOWER_HERO_AGGRO_WINDOW_TICKS: 240,
    TOWER_TARGET_MIN_DWELL_TICKS: 60,

    /** ⚖ SETTLED: no invulnerability gates. §3's tower order is descriptive of
     *  normal play, not a rule — §9.1 lists "tower backdoor" as an auto-clip
     *  trigger, which an order gate would make unreachable. */
    ATTACKABLE_OUT_OF_ORDER: true,
    BACKDOOR_PROTECTION_IS_REGEN_ONLY: true, // a committed backdoor always works
    BACKDOOR_REGEN_HPS: 500,
    BACKDOOR_REGEN_DELAY_TICKS: 240,
    TOWER_REGEN_HPS: 45,
    TOWER_REGEN_DELAY_TICKS: 480,
    CORE_REGEN_HPS: 0,

    TOWER_COLLIDER_M: [4.0, 9.0, 4.0],
    CORE_COLLIDER_M: [8.0, 10.0, 8.0],
  },

  PIT_BOSS: {
    FIRST_SPAWN_TICK: 14_400, // 4:00
    RESPAWN_TICKS: 14_400,
    HP_BASE: 26_700, // rescaled with the structure pool
    HP_SCALE_PER_SPAWN: 0.3,
    ATTACK_RANGE_M: 18, // > pit radius: rim-poking is punished, not free
    ATTACK_INTERVAL_TICKS: 75,
    DMG_VS_HERO: 120,
    DMG_VS_TROOPER: 400,
    SLAM_INTERVAL_TICKS: 480, SLAM_WINDUP_TICKS: 60, // telegraphed, dashable
    SLAM_RADIUS_M: 7, SLAM_DMG: 180, SLAM_KNOCKBACK_M: 4,
    AGGRO_RADIUS_M: 16, LEASH_RADIUS_M: 20,
    RESET_DELAY_TICKS: 180, RESET_HEAL_HPS: 4000,
    OOC_REGEN_HPS: 1200, OOC_REGEN_DELAY_TICKS: 300,
    // a failed 40% attempt resets in ~9.3s: commit and finish, or chip for nothing
    LAST_HIT_TAKES_ALL: true, // §9.4 THE STEAL. Never balance away.
    HP_ALWAYS_VISIBLE_TO_BOTH_TEAMS: true,
    STEAL_HIGHLIGHT_FRAC: 0.15, // below 15% the boss burns magenta and both HUDs show raw HP
    IGNORES_TROOPERS: true,
  },

  /**
   * THE MARCH — §7.3 specified the boss reward as the single word "buff".
   * Requirements it has to meet: legible on screen (P4), team-wide, survives
   * death (a buff that dies with you cannot be a comeback tool), and visibly
   * becomes map pressure inside 60s or THE STEAL cannot carry §9.4's drama.
   */
  MARCH: {
    DURATION_TICKS: 5400, // 90s — spans 3–4 trooper waves
    IS_TEAM_WIDE: true,
    SURVIVES_DEATH: true,
    STACKS: false, REFRESHES_TO_FULL: true,
    CANCELS_ENEMY_MARCH_ON_KILL: true, // stealing it also STRIPS it — the full ROBBED payoff
    TROOPER_HP_MULT: 1.75,
    TROOPER_STRUCT_DMG_MULT: 1.75, // combined effect on a tower = 3.06×
    TROOPER_MOVE_SPEED_MPS: 6.0, // mid → enemy T1 in 7.3s, not 11.0s
    TROOPER_SCALE_MULT: 1.5, TROOPER_EMISSIVE_TEAM_COLOUR: true, // P4: you can SEE the buffed wave
    HERO_STRUCTURE_DAMAGE_BONUS: 0.2, // additive with BREAKER, per the pipeline
    RESPAWN_MULT: 0.5,
    HUD_BANNER_BOTH_TEAMS: true, // the enemy watches the 90s clock tick down
  },

  SUDDEN_DEATH: {
    START_TICK: 54_000, // 15:00
    WARNING_TICK: 50_400, // 14:00 countdown for both teams
    /** ⚖ WORLD owns match flow. Economy also shipped a flat 45s; deleted. */
    RESPAWN_TICKS: 1800, // replaces the 8 + 2×min formula outright
    RESPAWN_ADD_PER_DEATH_TICKS: 360, // uncapped: 30, 36, 42, 48… one ace ends it
    DISABLE_ALL_STRUCTURE_REGEN: true,
    DISABLE_BACKDOOR_PROTECTION: true,
    /** Everything decays, and the team behind on the map decays faster — which
     *  is also the draw resolver: being ahead on structures wins by default. */
    DECAY_FRAC_PER_S: 0.008,
    DECAY_RAMP_FRAC_PER_S_PER_MIN: 0.004,
    DECAY_LEADER_MULT: 0.6,
    DECAY_TRAILER_MULT: 1.0,
    HARD_CEILING_TICK: 59_460, // 16:31 — decay alone deletes a full core 91s after 15:00
    FORCE_BOSS_SPAWN: true, BOSS_HP_MULT: 0.5, MARCH_DURATION_MULT: 2.0,
    DISABLE_SURGE: true, // sudden death exists to END the match
    BOUNTY_MULT: 2.0,
    TIEBREAK_ORDER: ['CORE_HP_FRAC', 'TOWERS_ALIVE', 'SOULS_EARNED', 'STRUCTURE_DMG_DEALT', 'DRAW'],
  },

  /** Reference values headless-bench asserts against. NOT gameplay inputs. */
  MATCH_MODEL: {
    MEAN_SUSTAINED_SIEGE_DPS: 150.2, // mean of COMBAT.TTK_BENCH.SUSTAINED_DPS × per-weapon mult
    TARGET_HERO_SIEGE_UPTIME_FRAC: 0.115,
    EXPECTED_TROOPER_SIEGE_SHARE: 0.28,
    ACCEPT_BAND_S: [600, 840], // M8 "median match length 10–14 min"
  },
} as const;

// ============================================================================
// GLITCH BOMB — the tone's first mechanic. See docs/DIRECTION.md §0.
//
// "Enemies that are hit cannot use their controls for a few seconds and freak
// out." The bar it has to clear is that it is FUNNY TO BE HIT BY, not only
// funny to land — removing control is among the most hated mechanics in games
// when it is long, unclear or lethal, and among the most beloved when it is
// short, telegraphed and survivable. Every constant below is that bar:
// ============================================================================
export const GLITCH = {
  COOLDOWN_TICKS: 720, // 12.0s — §6.4's 8–16s active band
  CAST_TICKS: 12, // 0.20s wind-up, so the throw is committed and readable
  /** Fuse. The victim gets time to leave; being hit is a read you lost. */
  ARM_TICKS: 42, // 0.70s
  MAX_RANGE_M: 28,
  RADIUS_M: 6.0,

  /** 1.8s. Long enough to lose a duel, short enough not to resent. */
  DURATION_TICKS: 108,
  /** Damage is deliberately near-zero: it creates the opening, someone else
   *  still has to take it. A glitch bomb must never be the thing that killed
   *  you, only the thing that made you killable. */
  DAMAGE: 15,

  /** SCRAMBLE, not freeze. A player who can still flail can still get lucky,
   *  and that near-miss is the clip. */
  REMAP_INTERVAL_TICKS: 18, // the mapping re-rolls ~3× per glitch
  /** Aim jitter in milli-degrees per tick while glitched. */
  AIM_JITTER_MILLIDEG: 900,
  /** Movement is slowed but never zeroed. */
  MOVE_MULT: 0.75,
  /** Firing still works — being unable to shoot back is the un-fun version. */
  BLOCKS_FIRE: false,
  BLOCKS_DASH: true, // the dash is the counterplay you are being denied

  /** Accessibility: the mechanical penalty stays, the screen distortion can be
   *  turned off. Input scramble and heavy chromatic aberration cause real
   *  problems for motion-sensitive and motor-impaired players, and "turn off
   *  the effect" must not mean "turn off the game". */
  REDUCED_EFFECTS_KEEPS_MECHANIC: true,
} as const;

// ============================================================================
// M0 TARGET RANGE — the grey box. Not shipped content; this is the fun gate.
// ============================================================================
export const M0 = {
  TARGET_HP: 700, // the TTK reference target, so M0 measures the real number
  TARGET_RESPAWN_TICKS: 120,
  ARENA_HALF_X_M: 40,
  ARENA_HALF_Z_M: 28,
  ARENA_WALL_HEIGHT_M: 12,
} as const;

// ============================================================================
// Derived functions. Each genuinely needs to be a function; everything else
// above is data.
// ============================================================================

/** Wave scaling — HP and structure damage share the curve. */
export function waveScale(waveIndex: number): number {
  const k = Math.min(waveIndex, WORLD.TROOPERS.SCALE_CAP_WAVE);
  return 1 + WORLD.TROOPERS.HP_SCALE_PER_WAVE * k;
}

/** Mantle duration — an exact integer tick count for any ledge height. */
export function mantleDurationTicks(ledgeHeightM: number): number {
  const lo = MOVEMENT.MANTLE_MIN_HEIGHT_M;
  const h = Math.min(Math.max(ledgeHeightM, lo), MOVEMENT.MANTLE_MAX_HEIGHT_M);
  return MOVEMENT.MANTLE_BASE_TICKS + Math.ceil(MOVEMENT.MANTLE_TICKS_PER_M * (h - lo));
}

/** Progressive marginal brackets, integer-only, capped. */
export function deathPenalty(unspentSouls: number): number {
  const b = ECONOMY.DEATH_PENALTY_BRACKETS;
  let lost = 0;
  for (let i = 0; i < b.length; i++) {
    const cur = b[i]!;
    const next = b[i + 1];
    const top = next !== undefined ? next.FLOOR : unspentSouls;
    const inBracket = Math.min(unspentSouls, top) - cur.FLOOR;
    if (inBracket <= 0) continue;
    lost += Math.floor((inBracket * cur.RATE_NUM) / cur.RATE_DEN);
  }
  return Math.min(lost, ECONOMY.DEATH_PENALTY_MAX);
}

/** Respawn in integer ticks: floored minutes, cap THEN multiply. */
export function respawnTicks(matchTick: number, surging: boolean, suddenDeath: boolean, deathsThisPhase = 0): number {
  if (suddenDeath) {
    return WORLD.SUDDEN_DEATH.RESPAWN_TICKS + WORLD.SUDDEN_DEATH.RESPAWN_ADD_PER_DEATH_TICKS * deathsThisPhase;
  }
  const minute = Math.min(Math.floor(matchTick / SPINE.MINUTE_TICKS), 14);
  const capped = ECONOMY.RESPAWN_TICKS_BY_MINUTE[minute]!;
  if (!surging) return capped;
  return (capped * ECONOMY.SURGE_RESPAWN_MULT_NUM) / ECONOMY.SURGE_RESPAWN_MULT_DEN;
}

/** Orb value: clamped minute index, then deny ratio, then SURGE. */
export function orbSouls(matchTick: number, isDeny: boolean, surging: boolean): number {
  const m = Math.min(Math.floor(matchTick / SPINE.MINUTE_TICKS), ECONOMY.ORB_VALUE_MINUTE_CLAMP);
  let v: number = isDeny ? ECONOMY.ORB_DENY_BY_MINUTE[m]! : ECONOMY.ORB_CLAIM_BY_MINUTE[m]!;
  if (surging) v = Math.floor((v * ECONOMY.SURGE_INCOME_BONUS_NUM) / ECONOMY.SURGE_INCOME_BONUS_DEN);
  return v;
}

/** Sudden-death decay as a per-tick fraction of max HP, ramping with overtime. */
export function suddenDeathDecayPerTick(matchTick: number, isStructureLeader: boolean): number {
  const sd = WORLD.SUDDEN_DEATH;
  if (matchTick < sd.START_TICK) return 0;
  const overtimeS = (matchTick - sd.START_TICK) / SPINE.SIM_HZ;
  const perSec = sd.DECAY_FRAC_PER_S + sd.DECAY_RAMP_FRAC_PER_S_PER_MIN * (overtimeS / 60);
  return (perSec * (isStructureLeader ? sd.DECAY_LEADER_MULT : sd.DECAY_TRAILER_MULT)) / SPINE.SIM_HZ;
}

/**
 * A stable hash over every tunable in this file.
 *
 * A `.ovr` replay is its input log, which only reproduces against the sim AND
 * the numbers it was recorded with. Pinning this in the replay header is what
 * lets playback refuse on mismatch rather than render a subtly wrong match —
 * and a replay that silently diverges is worse than one that will not open,
 * because you cannot tell which frames were real.
 *
 * Computed from a canonical key-sorted serialisation, so reordering this file
 * does not change the hash but changing a value always does.
 */
export function balanceHash(): number {
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${k}:${canon(o[k])}`).join(',')}}`;
  };
  const src = canon({ SPINE, ENTITY, MOVEMENT, CAMERA, COMBAT, ECONOMY, WORLD, GLITCH, M0 });
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Bumped by hand when tick() changes shape. Pinned into every replay. */
export const BUILD_HASH = 0x00030001; // M3.1
