// ============================================================================
// OVRRUN -- ABILITIES, DASH, CC TAXONOMY, DAMAGE PIPELINE
// Destination: packages/sim/src/balance.ts
// SIM_HZ = 60. Every *_TICKS value is authoritative; *_S is documentation.
// Test invariant: for every X_S/X_TICKS pair, X_TICKS === Math.round(X_S * 60)
//   AND X_S * 60 is an exact integer. (Verified: all 60 pairs pass.)
// ============================================================================

export const ABILITIES = {

  // == 0. GLOBAL FRAME / RULE CONSTANTS ====
  SIM_HZ: 60, // spine; fixed timestep 1/60 s
  SNAPSHOT_EVERY_TICKS: 3, // spine; 20 Hz snapshots = 60/3
  VISIBILITY_GATE_EVERY_TICKS: 4, // spine; 15 Hz head-ray test (PRD S5.3 "15Hz") = 60/4
  LAG_COMP_MAX_REWIND_TICKS: 12, // PRD S10.4 clamp 200ms -> 0.200*60 = 12 ticks
  LAG_COMP_MAX_REWIND_S: 0.2, // 12 ticks
  ABILITY_LOCKOUT_S: 0.2, // post-cast lockout, blocks same-tick Q+E+R
  ABILITY_LOCKOUT_TICKS: 12, // 0.2 * 60
  ABILITY_HAS_GLOBAL_COOLDOWN: false, // this is a shooter; only the 12-tick lockout exists
  CAST_INTERRUPT_BY_STUN: true, // any cast interrupted by STUN -> full CD, no refund
  CAST_INTERRUPT_REFUND_FRACTION: 0.0, // stun-interrupt costs the whole cooldown (deliberate: it is the clip)
  MANUAL_CANCEL_REFUND_FRACTION: 0.6, // self-cancel before a commit point refunds 60% of CD
  WHIFF_REFUND_FRACTION: 0.5, // targeted abilities that hit nothing refund 50% of CD

  // == 1. DAMAGE PIPELINE (spine-settled order, as an ordered list) ====
  // Applied in exactly this order, once, per damage instance:
  //   step 0  base        = ability flat damage | weapon per-shot (or per-pellet) damage
  //   step 1  x falloff   = range falloff (WEAPONS ONLY; abilities exempt, falloff = 1.0)
  //   step 2  x headshot  = x1.5 hitscan weapon | x1.0 projectile | x1.0 ALL abilities (PRD S6.2)
  //   step 3  x (1 + SUM) = ONE sum of every additive percent bonus. NEVER a product.
  //   step 4  floor()     = single integer quantization at the write to HP
  DAMAGE_PIPELINE_ORDER: ['BASE', 'FALLOFF', 'HEADSHOT', 'ADDITIVE_PERCENT_SUM', 'FLOOR_TO_INT'],
  ABILITIES_IGNORE_FALLOFF: true, // ability damage is flat at all ranges (PRD S6.3 "Launcher: Flat")
  ABILITIES_IGNORE_HEADSHOT: true, // headshot mult is x1.0 for abilities (PRD S6.2)
  DAMAGE_ROUNDING: 'FLOOR_ONCE_AT_END', // never round intermediates; one floor at the HP write

  // Bucket membership. A bonus lives in EXACTLY ONE bucket.
  BUCKET_DAMAGE_ADDITIVE: [ // -> step 3, summed then applied once
    'HALO_TAG_+12', // +0.12, attacker TEAM vs the tagged target, all damage types
    'ITEM_T2_ABILITY_DAMAGE_+25', // +0.25, ability-typed damage only
    'ITEM_T3_VS_STRUCTURES_+35', // +0.35, structure targets only
  ],
  BUCKET_FIRE_RATE_ADDITIVE: [ // -> rpm_eff = rpm_base * (1 + SUM); NEVER touches per-shot damage
    'VOLT_OVERCHARGE_+30', // +0.30
    'ITEM_T1_FIRE_RATE_+12', // +0.12
  ],
  BUCKET_MOVE_SPEED_ADDITIVE: [ // -> speed = 6.0 * (1 + SUM selfMods) * (1 - strongestExternalSlow)
    'BULWARK_SIEGE_FORM_-25', // -0.25 SELF_SLOW, never cleansable
    'HALO_LINE_SHOT_CHANNEL_-65', // -0.65 while channelling
    'BULWARK_CONCUSS_CAST_-50', // -0.50 during the 21-tick windup
  ],
  BUCKET_EXCLUDED_MULTIPLICATIVE: [ // these are their own ordered steps, NOT in the sum
    'FALLOFF', // step 1
    'HEADSHOT', // step 2
  ],
  BUCKET_NON_ADDITIVE_SPECIAL: [
    'EXTERNAL_SLOWS', // strongest-slow-only, see SLOW_STACKING_RULE
    'PERCENT_MAX_HP_DAMAGE', // computed from target maxHp, THEN enters the pipeline as `base`
  ],
  MOVE_SPEED_MULT_MIN: 0.20, // hard floor; nothing can drop below 1.2 m/s
  MOVE_SPEED_MULT_MAX: 1.50, // hard ceiling

  // Worked example baked in as a regression target -- Line Shot on a Tagged target with T2:
  //   floor(320 * 1.0 * 1.0 * (1 + 0.12 + 0.25)) = floor(438.4) = 438
  //   multiplicative (WRONG) would be 320 * 1.12 * 1.25 = 448 -> 10 damage of drift
  PIPELINE_TEST_LINE_SHOT_TAGGED_T2: 438, // assert this exact integer

  // == 2. CC TAXONOMY ====
  CC_KIND: {
    NONE: 0,
    SLOW: 1, // speed * (1 - s). Can shoot, cast, dash. Dash distance unchanged.
    STUN: 2, // no move/shoot/cast/dash/ADS. Camera+aim still move (PRD S5.2). Cancels channels.
    ROOT: 3, // speed = 0. CAN shoot/cast/ADS. Cannot dash, Hook Line, or Vault.
    SILENCE: 4, // no Q/E/R and no dash. CAN move and shoot. (No MVP source; defined for the matrix.)
    DISPLACEMENT: 5, // forced position change. Retains aim+fire. Cannot dash during it.
    DASH_DISABLE: 6, // universal dash unusable. Hero mobility abilities STILL usable.
    BLACKOUT: 7, // information denial only. ZERO mechanical effect.
  },
  UNIT_STATE: {
    I_FRAMES: 0, // dash. Blocks DAMAGE only.
    DISPLACEMENT_IMMUNE: 1, // Siege Form; post-Displace grace
    SLOW_IMMUNE: 2, // item T2 "slow immunity 3s after dash"
    SELF_SLOW: 3, // self-inflicted speed penalty; NEVER cleansed, NEVER DR'd
    CC_IMMUNE: 4, // full hard-CC immunity (only Siege Form's 18-tick cast window)
  },

  HARD_CC_KINDS: ['STUN', 'ROOT', 'SILENCE'], // subject to diminishing returns
  HARD_CC_DR_MULTIPLIERS: [1.0, 0.5, 0.25, 0.0], // 1st/2nd/3rd/4th+ application on the same target
  HARD_CC_DR_WINDOW_S: 12.0, // resets after 12s with no hard CC applied
  HARD_CC_DR_WINDOW_TICKS: 720, // 12.0 * 60
  DISPLACEMENT_HAS_DR: false, // displacement uses a flat grace window instead of DR
  POST_DISPLACEMENT_IMMUNE_S: 0.5, // prevents Displace ping-pong chaining
  POST_DISPLACEMENT_IMMUNE_TICKS: 30, // 0.5 * 60

  SLOW_STACKING_RULE: 'STRONGEST_ONLY', // slows never sum: max(activeSlows). Prevents 40%+50% = 90% lockdown.
  SELF_SLOW_STACKING_RULE: 'SEPARATE_BUCKET', // speed = base * (1 + SUM selfMods) * (1 - strongestExternalSlow)
  // e.g. Siege Form (-25% self) + Concuss (-35% external) = 6.0 * 0.75 * 0.65 = 2.925 m/s

  // Immunity x incoming-effect matrix. true = BLOCKED by that immunity, false = APPLIES anyway.
  CC_IMMUNITY_MATRIX: {
    I_FRAMES:            { DAMAGE: true,  SLOW: false, STUN: false, ROOT: false, SILENCE: false, DISPLACEMENT: false, DASH_DISABLE: false, BLACKOUT: false },
    DISPLACEMENT_IMMUNE: { DAMAGE: false, SLOW: false, STUN: false, ROOT: false, SILENCE: false, DISPLACEMENT: true,  DASH_DISABLE: false, BLACKOUT: false },
    SLOW_IMMUNE:         { DAMAGE: false, SLOW: true,  STUN: false, ROOT: false, SILENCE: false, DISPLACEMENT: false, DASH_DISABLE: false, BLACKOUT: false },
    CC_IMMUNE:           { DAMAGE: false, SLOW: true,  STUN: true,  ROOT: true,  SILENCE: true,  DISPLACEMENT: true,  DASH_DISABLE: false, BLACKOUT: false },
  },

  // The ambiguities the PRD never resolved, settled explicitly:
  RULE_SIEGE_FORM_BLOCKS_DISPLACE_PULL: true, // pull negated; Displace's 45 damage STILL lands
  RULE_SIEGE_FORM_BLOCKS_CONCUSS_STUN: false, // Siege Form is displacement immunity, NOT CC immunity
  RULE_SIEGE_FORM_BLOCKS_HOOK_LINE: false, // no interaction: Hook Line is VOLT self-displacement, never targets an enemy
  RULE_SIEGE_FORM_BLOCKS_COLLAPSE_DASH_DISABLE: false, // Siege BULWARK also cannot dash out of Collapse
  RULE_IFRAMES_BLOCK_CC: false, // i-frames are DAMAGE-ONLY; dashing "through" a Concuss still stuns you
  RULE_IFRAMES_BLOCK_DISPLACEMENT: false, // you cannot i-frame out of a pull; you must POSITION out of it (Pillar P3)
  RULE_IFRAMES_BLOCK_DOT_FIELDS: true, // Collapse ticks are damage, so they are blocked while i-framed
  RULE_IFRAMES_EVALUATED_AT_REWOUND_TICK: true, // see below -- the most important netcode rule in this file
  RULE_DASH_UNINTERRUPTIBLE: true, // CC landing mid-dash is QUEUED and applies at dash end (no mid-dash cancel to reconcile)

  // Lag compensation: i-frames and EVERY CC/immunity state are evaluated at the REWOUND tick,
  // not at present server time. hitTick = clamp(serverTick - rttTicks - interpTicks, serverTick - 12, serverTick)
  // If the victim was i-framed AT hitTick the shot deals 0, even if the i-frames have already
  // expired on the server now. This is what eliminates "I dashed and still died."
  CC_STATE_EVALUATED_AT: 'REWOUND_TICK',
  CC_STATE_REWIND_BUFFER_TICKS: 12, // must store i-frame/CC flags for the full rewind window

  // == 3. UNIVERSAL DASH ====
  DASH_MAX_CHARGES_BASE: 2, // PRD S6.4; item T1 "+1 dash charge" raises this to 3
  DASH_RECHARGE_S: 8.0, // PRD S6.4; charges refill SEQUENTIALLY, not in parallel
  DASH_RECHARGE_TICKS: 480, // 8.0 * 60
  DASH_DISTANCE_M: 6.0, // PRD S6.4
  DASH_DURATION_S: 0.25, // 6.0 m at 24 m/s
  DASH_DURATION_TICKS: 15, // 0.25 * 60; per-tick step = 6.0/15 = 0.4 m exactly
  DASH_SPEED_MPS: 24.0, // 6.0 / 0.25
  DASH_IFRAME_S: 0.25, // PRD S6.4 "0.25s i-frames at start" = co-terminal with the whole dash
  DASH_IFRAME_TICKS: 15, // no i-frame ever exists outside dash movement
  DASH_CHARGE_GATE_S: 0.75, // NEW: min interval between CONSUMING charges. Caps CONTIGUOUS
  DASH_CHARGE_GATE_TICKS: 45, // invulnerability at 0.25s (21% of the 1.2s TTK floor) not 0.50s (42%).
  // Max TTK inflation from spending the entire dash budget: +0.5s (1.20s -> 1.70s). See arithmetic.
  DASH_DIRECTION_SOURCE: 'MOVE_INPUT_ELSE_FACING', // no input -> forward
  DASH_BLOCKED_BY: ['STUN', 'ROOT', 'SILENCE', 'DASH_DISABLE'],
  DASH_CANCELS_CHANNELS: true, // dashing aborts your own channel (Line Shot forbids dash entirely)
  DASH_COLLIDES_WITH_SLAB: true, // you cannot dash through a Slab

  // == 4. VOLT -- Duelist (SMG) ====
  VOLT_Q_HOOK_LINE: {
    COOLDOWN_S: 9.0, // S6.4 band 8-16s; low end -- it is both the clip tool and the escape
    COOLDOWN_TICKS: 540, // 9.0 * 60
    CAST_S: 0.15, // fire the hook
    CAST_TICKS: 9, // 0.15 * 60
    MAX_RANGE_M: 25.0, // PRD S8
    PROJECTILE_SPEED_MPS: 75.0, // 25 m in exactly 20 ticks
    PROJECTILE_MAX_TICKS: 20, // 25.0 / 75.0 * 60
    ANCHOR_TARGETS: 'GEOMETRY_ONLY', // never latches onto a hero -- hence no Siege Form interaction
    PULL_SPEED_MPS: 25.0, // 25 m max range traversed in exactly 60 ticks
    PULL_MAX_TICKS: 60, // 1.0 s hard cap; per-tick step = 25/60 m
    PULL_MAX_S: 1.0, // a ~1s window where VOLT is a predictable moving target
    EXIT_MOMENTUM_RETAIN: 0.6, // 60% of arrival velocity kept -- the movement-tech enabler
    EXIT_MOMENTUM_S: 0.4,
    EXIT_MOMENTUM_TICKS: 24, // 0.4 * 60
    EARLY_RELEASE: true, // re-press Q drops the pull mid-flight (clip enabler)
    MISS_REFUND_FRACTION: 0.5, // whiff -> 4.5s effective cooldown
    DAMAGE: 0, // 0.0% of 550, 0.0% of 1000 -- pure mobility
    CC_APPLIED: 'NONE',
    SELF_DISPLACEMENT: true, // cancelled by STUN/ROOT (VOLT drops where he is)
  },

  VOLT_E_OVERCHARGE: {
    COOLDOWN_S: 14.0, // S6.4 band 8-16s
    COOLDOWN_TICKS: 840, // 14.0 * 60
    CAST_S: 0.0, // instant self-buff, no gunplay pause
    CAST_TICKS: 0,
    DURATION_S: 4.5, // PRD said 4.0s; extended to preserve throughput after the rate cut
    DURATION_TICKS: 270, // 4.5 * 60
    FIRE_RATE_BONUS: 0.30, // PRD said +0.40 -- OVERRULED, +0.40 breaks the 1.20s TTK floor.
    // Lives in BUCKET_FIRE_RATE_ADDITIVE: additive with item T1 (+0.12), never multiplied.
    CHAIN_FRACTION: 0.25, // 25% of the PRIMARY hit's post-pipeline damage
    CHAIN_RADIUS_M: 6.0, // measured from the PRIMARY TARGET, not from VOLT
    CHAIN_MAX_TARGETS: 1, // never chains a second time
    CHAIN_HITS_TROOPERS: false, // heroes only -- VOLT is a duelist, not a wave-clearer
    CHAIN_DAMAGE_TYPE: 'WEAPON', // NOT ability damage: the T2 +25% ability item must not double-dip
    CHAIN_CAN_HEADSHOT: false, // chain is untargeted, so x1.0
    DAMAGE: 0, // the ability itself deals 0; all output is weapon-routed
    // Constraint imposed on the WEAPONS domain: VOLT's SMG base TTK@700 must be >= 1.60s
    // (DPS <= 437.5, at or below the band midpoint) so 437.5 * 1.30 = 568.75 -> 700/568.75 = 1.231s.
    TTK_FLOOR_GUARD_S: 1.2, // 72 ticks
    REQUIRED_SMG_BASE_TTK_AT_700_S: 1.6, // 96 ticks; implies SMG DPS <= 437.5
  },

  VOLT_R_BLACKOUT: {
    // REWORKED: dash-denial -> INFORMATION denial. Argument in open_conflicts.
    EFFECT_KIND: 'BLACKOUT', // CC_KIND.BLACKOUT -- zero mechanical effect
    COOLDOWN_S: 90.0, // S6.4 band 90-110s; cheapest ult in the roster (0 damage, 0 CC)
    COOLDOWN_TICKS: 5400, // 90.0 * 60
    CAST_S: 0.4, // telegraphed; interruptible by STUN
    CAST_TICKS: 24, // 0.4 * 60
    DURATION_S: 4.0, // PRD said 3.0s; info denial needs a full fight window to matter
    DURATION_TICKS: 240, // 4.0 * 60
    RADIUS_M: 12.0, // PRD S8 radius kept: 24 m diameter covers a fight, not the lane
    PLACEMENT: 'GROUND_STATIC_AT_CASTER', // static dome, NOT attached to VOLT -- legibility (Pillar P4)
    LINGER_AFTER_EXIT_S: 0.75, // cannot tap in/out to refresh your HUD
    LINGER_AFTER_EXIT_TICKS: 45, // 0.75 * 60
    DAMAGE: 0, // 0.0% of 550, 0.0% of 1000
    AFFECTS_ALLIES: false, // team-filtered
    SUPPRESSES: [ // what an enemy standing inside the dome loses
      'ENEMY_NAMEPLATES', 'ENEMY_HEALTH_BARS', 'ALLY_HEALTH_BARS', 'MINIMAP_ALL_BLIPS',
      'HITMARKERS', 'DAMAGE_NUMBERS', 'KILL_FEED', 'HALO_TAG_WALL_OUTLINE',
    ],
    PRESERVES: ['OWN_HP', 'OWN_AMMO', 'OWN_COOLDOWNS', 'WORLD_AUDIO', 'ENEMY_MODELS', 'DOME_VFX'],
    SCREEN_BLIND: false, // never darken the screen: unreadable on stream, rage-inducing
    HUD_DESATURATE_TELL: true, // affected HUD desaturates + static SFX -> legible in a clip
  },

  // == 5. BULWARK -- Frontliner (Shotgun) ====
  BULWARK_Q_SLAB: {
    COOLDOWN_S: 15.0, // S6.4 band 8-16s; CD starts ON CAST
    COOLDOWN_TICKS: 900, // 15.0 * 60
    CAST_S: 0.25, // deploy animation; can move, cannot fire
    CAST_TICKS: 15, // 0.25 * 60
    DURATION_S: 6.0, // PRD said 8.0s -- OVERRULED. 8s/16s = 50% wall uptime re-authors a map
    DURATION_TICKS: 360, // built on "sightline breakers every ~15m". 6/15 = 40% uptime.
    HP: 800, // PRD S8. ~1.83s of one reference gun (437.5 DPS); 0.61s of three.
    WIDTH_M: 4.0, // PRD S8
    HEIGHT_M: 3.0, // PRD S8 -- deliberately above any mantle height (movement domain must keep mantle < 3.0m)
    THICKNESS_M: 0.4,
    YAW_SNAP_DEG: 90, // *** ENGINE FLAG *** snaps to {0,90,180,270} world yaw, nearest to BULWARK's aim.
    IS_ALWAYS_AABB: true, // Guarantees a world-axis AABB at all times, therefore:
    // -> lag-comp rewind stores 6 floats/tick (12 ticks = 288 bytes), not transform+basis (480 bytes)
    // -> collision stays capsule-vs-AABB + ray-vs-AABB (PRD S10.1's ~500 LOC budget)
    // -> no OBB/SAT code path is ever needed
    MUST_BE_IN_LAGCOMP_REWIND: true, // *** ENGINE FLAG *** runtime-spawned collider: a Slab that
    // existed at the rewound tick must still block the rewound ray, and vice versa.
    MAX_PLACE_DISTANCE_M: 8.0, // ground-targeted
    MAX_ACTIVE_PER_HERO: 1, // recast destroys the previous Slab
    BLOCKS_BULLETS_BOTH_WAYS: true, // PRD S8; blocks your own team too
    BLOCKS_PROJECTILES: true,
    BLOCKS_LINE_SHOT: true, // *** signature interaction *** the beam that pierces ALL terrain is
    // stopped by the one piece of RUNTIME terrain (PRD S8's named clip: "blocking an ultimate")
    BLOCKS_DISPLACE_PROJECTILE: true, // blocking the projectile is how you deny the pull
    BLOCKS_DOME_AURAS: false, // Collapse / Blackout are volumes, not rays
    IMMUNE_TO_PERCENT_MAX_HP_DAMAGE: true, // Collapse cannot melt a Slab
    PERSISTS_AFTER_CASTER_DEATH: true, // it is a physical object
    DAMAGE: 0, // 0.0% of 550, 0.0% of 1000
  },

  BULWARK_E_CONCUSS: {
    COOLDOWN_S: 13.0, // S6.4 band 8-16s; the ONLY hard CC in the game
    COOLDOWN_TICKS: 780, // 13.0 * 60
    CAST_S: 0.35, // visible 4m ground-ring telegraph during the windup
    CAST_TICKS: 21, // 0.35 * 60
    CAST_MOVE_MULT: 0.5, // -50% during windup (BUCKET_MOVE_SPEED_ADDITIVE)
    RADIUS_M: 4.0, // PRD S8; point-blank punish, correct for a shotgun frontliner
    DAMAGE: 70, // 12.73% of 550 / 7.00% of 1000; ability -> no headshot, no falloff
    STUN_S: 0.7, // PRD said 1.0s -- OVERRULED. 1.0s = 83% of the 1.2s TTK floor at point-blank
    STUN_TICKS: 42, // shotgun range = a guaranteed kill with zero counterplay. 0.7s = 58%.
    SLOW_FRACTION: 0.35, // PRD said 0.40
    SLOW_S: 1.5, // applies AFTER the stun ends; PRD left the duration unstated
    SLOW_TICKS: 90, // 1.5 * 60
    SUBJECT_TO_DR: true, // stun is HARD_CC: 1.0 / 0.5 / 0.25 / immune within a 720-tick window
    HITS_TROOPERS: true,
    DAMAGES_FRIENDLY_SLAB: false,
  },

  BULWARK_R_SIEGE_FORM: {
    COOLDOWN_S: 100.0, // S6.4 band 90-110s
    COOLDOWN_TICKS: 6000, // 100.0 * 60
    CAST_S: 0.3, // transformation
    CAST_TICKS: 18, // 0.3 * 60
    CAST_CC_IMMUNE: true, // CC_IMMUNE for the 18-tick cast only -- a 0.7s stun must not eat a 100s ult
    DURATION_S: 6.0, // PRD S8
    DURATION_TICKS: 360, // 6.0 * 60
    MAX_HP_BONUS: 0.60, // PRD said +0.80 -- OVERRULED against the corrected ~1000 ceiling.
    // +0.80 -> 1800 HP -> 4.12s solo TTK = 2.06x the 2.0s band top.
    // +0.60 -> 1600 HP -> 3.66s solo, 1.22s under 3-man focus (= the TTK floor).
    BONUS_HP_GRANTED_AS_CURRENT: true, // instant +330 (base) / +600 (itemized) -- the single largest
    // sustain source in a game with no healers (PRD S6.2)
    ON_EXPIRY_HP_RULE: 'CLAMP_TO_BASE_MAX', // hp = min(hp, maxHpBase); never lethal, floors at 1
    MOVE_SPEED_MOD: -0.25, // PRD S8; SELF_SLOW -> 6.0 * 0.75 = 4.5 m/s
    MOVE_SPEED_IS_SELF_SLOW: true, // NEVER removed by SLOW_IMMUNE or tenacity -- it is a cost, not a CC
    DISPLACEMENT_IMMUNE: true, // PRD S8
    GRANTS_STUN_IMMUNITY: false, // explicit
    GRANTS_SLOW_IMMUNITY: false, // explicit
    GRANTS_DASH_DISABLE_IMMUNITY: false, // explicit -- Siege BULWARK still cannot dash out of Collapse
    DASH_DISTANCE_UNCHANGED: true, // dash stays 6.0m; no hidden per-state math
    DAMAGE: 0, // 0.0% of 550, 0.0% of 1000
  },

  // == 6. HALO -- Marksman (Rifle) ====
  HALO_Q_TAG: {
    COOLDOWN_S: 12.0, // S6.4 band 8-16s
    COOLDOWN_TICKS: 720, // 12.0 * 60
    CAST_S: 0.2,
    CAST_TICKS: 12, // 0.2 * 60
    DURATION_S: 6.0, // PRD S8; 6/12 = 50% single-target uptime
    DURATION_TICKS: 360, // 6.0 * 60
    APPLICATION: 'HITSCAN', // PRD unspecified; hitscan so a marksman can actually land it
    RANGE_M: 45.0, // matches the Rifle's 100%-falloff band (PRD S6.3)
    REQUIRES_LOS: true,
    MISS_REFUND_FRACTION: 0.5, // whiff -> 6.0s effective cooldown
    MAX_ACTIVE_PER_HERO: 1, // recasting moves the Tag
    DAMAGE: 0, // 0.0% of 550, 0.0% of 1000 -- it is a debuff
    DAMAGE_BONUS: 0.12, // PRD S8; ADDITIVE, in BUCKET_DAMAGE_ADDITIVE, applies to the whole team
    BONUS_APPLIES_TO: 'ALL_DAMAGE_TYPES', // weapons and abilities alike
    WALL_OUTLINE_FOR_TEAM: true, // PRD S8
    MINIMAP_REVEAL_FOR_TEAM: true,
    SUPPRESSED_BY_BLACKOUT: true, // *** rock-paper-scissors *** VOLT's reworked ult deletes HALO's
    // wallhack for exactly those players standing inside the dome
  },

  HALO_E_VAULT: {
    COOLDOWN_S: 10.0, // S6.4 band 8-16s
    COOLDOWN_TICKS: 600, // 10.0 * 60
    CAST_S: 0.0, // instant commit
    CAST_TICKS: 0,
    DISTANCE_M: 11.0, // "long" = meaningfully longer than the 6m dash
    TRAVEL_S: 0.55, // 11.0 m at 20 m/s horizontal
    TRAVEL_TICKS: 33, // 0.55 * 60
    ARC_PEAK_M: 2.5, // ballistic hop, not a ground dash: readable, predictable path
    DIRECTION: 'OPPOSITE_AIM_YAW', // strictly backward, no input steering. Cannot be used to chase.
    AIM_SLOW_S: 0.4, // PRD S8; settled as a SELF cost -- HALO cannot instantly re-acquire
    AIM_SLOW_TICKS: 24, // 0.4 * 60
    AIM_SLOW_TURN_MULT: 0.45, // turn-rate multiplier during the window
    IFRAMES: false, // *** deliberate *** Vault grants DISTANCE; invulnerability is the dash's job only
    DAMAGE: 0, // 0.0% of 550, 0.0% of 1000
    USABLE_UNDER_DASH_DISABLE: true, // *** the counterplay to Collapse *** it is a hero ability, not the dash
    BLOCKED_BY: ['STUN', 'ROOT', 'SILENCE'],
  },

  HALO_R_LINE_SHOT: {
    COOLDOWN_S: 105.0, // S6.4 band 90-110s; the highest-damage, longest-reach ult
    COOLDOWN_TICKS: 6300, // 105.0 * 60
    CHARGE_S: 1.2, // PRD S8
    CHARGE_TICKS: 72, // 1.2 * 60
    AIM_LOCK_AT_S: 0.6, // *** FIX *** beam direction FREEZES at 0.6s -- HALO cannot track a dodge
    AIM_LOCK_AT_TICK: 36, // targets get a guaranteed 36-tick FROZEN line to step out of
    TELEGRAPH: 'ENEMY_VISIBLE_LINE_THROUGH_TERRAIN', // *** FIX *** magenta (#FF2E88) charge line
    TELEGRAPH_START_TICK: 0, // rendered through walls to every enemy from tick 0; tracks aim to tick 36, then freezes
    RANGE_M: 90.0, // *** FIX *** replaces "full map length". 90/220 = 40.9% of THE STRIP.
    // T1-to-T1 = 0.40 * 220 = 88 m <= 90 m, so the signature cross-lane snipe survives.
    // Max reach from MID (110 m) = [20, 200] -> BOTH spawns (0 m, 220 m) are unreachable. No spawn camping.
    BEAM_RADIUS_M: 0.6, // 1.2 m wide; with a ~0.4 m capsule radius, 1.0 m of lateral clearance escapes
    DAMAGE: 320, // *** FIX *** 320, NOT 480. 58.18% of 550 / 32.00% of 1000.
    DAMAGE_TYPE: 'ABILITY', // *** FIX *** declared an ability -> headshot x1.0 (PRD S6.2), falloff exempt
    CAN_HEADSHOT: false, // settles the 320-vs-480 ambiguity permanently
    PIERCES_TERRAIN: true, // PRD S8
    PIERCES_HEROES: true, // hits every enemy on the line at full damage -- the multi-kill clip
    PIERCES_SLAB: false, // *** BULWARK's Slab is the ONE hard counter ***
    HITS_STRUCTURES: true, // 320 to a tower is negligible; no siege abuse
    HIT_TICKS: 1, // instantaneous hitscan on the tick after the charge completes
    VFX_PERSIST_S: 0.5, // beam trail lingers for the killcam
    VFX_PERSIST_TICKS: 30, // 0.5 * 60
    CHANNEL_MOVE_MULT: 0.35, // 6.0 * 0.35 = 2.1 m/s; committed
    CHANNEL_CAN_DASH: false, // no dash-cancel; the commitment is the cost
    CHANNEL_CAN_CAST_QE: false,
    CANCEL_BEFORE_LOCK_REFUND: 0.6, // manual cancel before tick 36 refunds 60% of CD
    CANCEL_AFTER_LOCK_ALLOWED: false, // past the lock it fires no matter what
    STUN_INTERRUPT_REFUND: 0.0, // *** BULWARK stunning a charging HALO eats the ENTIRE 105s ult ***
    // Concuss's 4m radius means it must be earned. This is the best counterplay clip in the game.
  },

  // == 7. RIFT -- Zoner (Launcher) ====
  RIFT_Q_MINE_FIELD: {
    COOLDOWN_S: 15.0, // S6.4 band 8-16s; one cast places all 3
    COOLDOWN_TICKS: 900, // 15.0 * 60
    CAST_S: 0.4, // lobs a 3-mine spread
    CAST_TICKS: 24, // 0.4 * 60
    MINE_COUNT: 3, // PRD S8
    MAX_ACTIVE_PER_HERO: 3, // recast FIFO-removes the previous set (20s life > 15s CD)
    THROW_DISTANCE_MAX_M: 18.0,
    THROW_FLIGHT_S: 0.5, // fixed ballistic solve to the aim point, distance-independent -> integer ticks
    THROW_FLIGHT_TICKS: 30, // 0.5 * 60
    SPREAD_RADIUS_M: 2.5, // landing scatter around the aim point
    ARM_S: 0.8, // inert on landing; prevents instant detonation
    ARM_TICKS: 48, // 0.8 * 60
    TRIGGER_RADIUS_M: 2.0,
    SPLASH_RADIUS_M: 2.5, // > trigger radius, so a 3-mine spread reliably chain-detonates
    LIFETIME_S: 20.0,
    LIFETIME_TICKS: 1200, // 20.0 * 60
    DAMAGE_EACH: 60, // PRD S8. 10.91% of 550 / 6.00% of 1000
    DAMAGE_FULL_CHAIN: 180, // 3 x 60. 32.73% of 550 / 18.00% of 1000
    SLOW_FRACTION: 0.40, // PRD said 0.50; under STRONGEST_ONLY a 3-chain is still 40%, not 120%.
    SLOW_S: 1.5, // that stacking rule is exactly why the chain is survivable
    SLOW_TICKS: 90, // 1.5 * 60
    TRIGGERS_ON_TROOPERS: false, // heroes only -- otherwise RIFT free-farms the wave
    GROUND_ONLY: true, // no wall/ceiling sticking; keeps placement AABB-friendly
    MINE_HP: 25, // one bullet clears it, but you spend a shot and reveal yourself
    IMMUNE_TO_PERCENT_MAX_HP_DAMAGE: true,
    DAMAGE_TYPE: 'ABILITY', // no headshot, no falloff
  },

  RIFT_E_DISPLACE: {
    COOLDOWN_S: 14.0, // S6.4 band 8-16s
    COOLDOWN_TICKS: 840, // 14.0 * 60
    CAST_S: 0.25,
    CAST_TICKS: 15, // 0.25 * 60
    PROJECTILE_SPEED_MPS: 45.0, // matches the Launcher archetype (PRD S6.3)
    MAX_RANGE_M: 30.0, // 30 / 45 = 0.6667 s = exactly 40 ticks
    PROJECTILE_MAX_TICKS: 40,
    PULL_RADIUS_M: 5.0, // PRD S8
    PULL_DURATION_S: 0.25, // FIXED-duration lerp, distance-independent -> always integer ticks
    PULL_DURATION_TICKS: 15, // 0.25 * 60
    PULL_STOP_DISTANCE_M: 1.0, // targets are pulled to 1.0 m from the impact point
    PULL_MAX_TRAVEL_M: 4.0, // 5.0 - 1.0; effective 16 m/s
    DAMAGE: 45, // 8.18% of 550 / 4.50% of 1000. Sized so RIFT's full rotation lands
    // exactly ON the 385 solo-burst cap (180 + 45 + 160 = 385), not over it.
    DAMAGE_TYPE: 'ABILITY', // no headshot, no falloff
    CC_APPLIED: 'DISPLACEMENT',
    NEGATED_BY_DISPLACEMENT_IMMUNE: true, // Siege Form stops the PULL; the 45 damage still lands
    TARGET_CAN_AIM_AND_FIRE_DURING_PULL: true,
    TARGET_CAN_DASH_DURING_PULL: false, // dash input is queued to the end of the 15-tick pull
    PULLS_TROOPERS: true, // pulling a wave into a Slab or the MID PIT is the clip
    BLOCKED_BY_SLAB: true, // the projectile is stopped, so the pull never happens
  },

  RIFT_R_COLLAPSE: {
    COOLDOWN_S: 105.0, // S6.4 band 90-110s; the last remaining dash-denial in the roster
    COOLDOWN_TICKS: 6300, // 105.0 * 60
    CAST_S: 0.5,
    CAST_TICKS: 30, // 0.5 * 60
    PLACEMENT_RANGE_M: 25.0, // ground-targeted
    RADIUS_M: 7.0, // *** FIX *** PRD's "15m dome" read as a radius = 30 m diameter in a 35 m lane
    // = 85.7% of lane width = laterally undodgeable. 7.0 m -> 14 m diameter = 40.0% of lane width,
    // leaving 21 m of passable lane. Walk-out from dead centre = 7.0/6.0 = 1.167s = 70 ticks.
    DIAMETER_M: 14.0,
    DURATION_S: 5.0, // PRD S8
    DURATION_TICKS: 300, // 5.0 * 60
    DAMAGE_PERCENT_MAX_HP_PER_TICK: 0.03, // PRD said 8%/s; set to 6%/s delivered as 3% every 0.5s
    DAMAGE_TICK_INTERVAL_S: 0.5,
    DAMAGE_TICK_INTERVAL_TICKS: 30, // 0.5 * 60
    DAMAGE_TICK_COUNT_MAX: 10, // 300 / 30
    FIRST_TICK_AFTER_ENTRY_TICKS: 30, // no damage on entry -- clipping the edge costs nothing
    DAMAGE_FORMULA: 'Math.floor(target.maxHp * 0.03)', // integer-quantized per tick; deterministic
    DAMAGE_TYPE: 'ABILITY', // the quantized result then runs the normal pipeline as `base`
    DAMAGE_FULL_SOAK_AT_550: 160, // 16/tick x 10 = 29.09% of the 550 pool
    DAMAGE_FULL_SOAK_AT_1000: 300, // 30/tick x 10 = 30.00% of the 1000 pool
    APPLIES_DASH_DISABLE: true, // PRD S8 "cannot dash out"
    DASH_DISABLE_SCOPE: 'INSIDE_VOLUME_ONLY', // no linger; step outside and your dash is live again
    DASH_INTO_DOME_ALLOWED: true, // dash legality is checked at cast; a dash may legally end inside
    HERO_MOBILITY_STILL_USABLE: true, // Hook Line and Vault beat it -- the intended counterplay
    HITS_STRUCTURES: false, // percent-max-HP never applies to structures or deployables
    ANTI_HP_STACK_INTERACTION_IS_INTENDED: true, // Siege Form's +60% max HP makes Collapse hurt MORE (48/tick), by design
  },

  // == 8. ULTIMATE COOLDOWN REDUCTION (resolves PRD S6.4's "charges") ====
  // PRD S6.4: "Ultimate -- R, 90-110s cooldown, charges reduced by 8s per takedown participation."
  // Ultimates have exactly ONE charge and this is NOT a charge system. Settled, unambiguous reading:
  // the ultimate's REMAINING COOLDOWN is reduced by 8 seconds per takedown participation.
  ULT_CHARGES: 1, // there is no ultimate charge system. The word "charges" is deleted from the spec.
  ULT_CDR_PER_TAKEDOWN_S: 8.0, // applied to REMAINING cooldown, not to a charge counter
  ULT_CDR_PER_TAKEDOWN_TICKS: 480, // 8.0 * 60
  ULT_CDR_PARTICIPATION_WINDOW_S: 5.0, // same window as the soul bounty split (PRD S7.3)
  ULT_CDR_PARTICIPATION_WINDOW_TICKS: 300, // 5.0 * 60
  ULT_CDR_APPLIES_WHEN_READY: false, // no banking: if the ult is already up, the reduction is discarded
  ULT_CDR_CLAMP_MIN_TICKS: 0, // never below ready
  ULT_CDR_MAX_APPLICATIONS_PER_CYCLE: 0, // 0 = uncapped. A full 3v3 wipe removes 24s.
  ULT_CDR_STACKS_WITH_T3_REFUND: 'ADDITIVE_IN_SECONDS', // flat 8s first, then item T3's 40%-of-BASE refund; summed, never multiplied
  ULT_INITIAL_COOLDOWN_S: 60.0, // all ults start on cooldown; first ult at 1:00 (30s after wave 1)
  ULT_INITIAL_COOLDOWN_TICKS: 3600, // 60.0 * 60

  // == 9. GUARDRAILS (assert these in headless-bench) ====
  SOLO_BURST_CAP_FRACTION_OF_BASE_HP: 0.70, // no hero's full Q+E+R rotation may exceed 70% of the 550 base pool
  SOLO_BURST_CAP_DAMAGE: 385, // 0.70 * 550. Measured on BASE ability damage, pre-SUM-bonus.
  SOLO_BURST_VOLT: 0, // 0 / 385 -- 0.0% of 550 (VOLT is 100% gun)
  SOLO_BURST_BULWARK: 70, // 70 / 385 -- 12.7% of 550
  SOLO_BURST_HALO: 320, // 320 / 385 -- 58.2% of 550
  SOLO_BURST_RIFT: 385, // 180 + 45 + 160 = 385 -- sits EXACTLY on the cap; RIFT is the burst ceiling
  ABILITY_DAMAGE_REFERENCE_POOL_BASE: 550, // spine
  ABILITY_DAMAGE_REFERENCE_POOL_CEILING: 1000, // spine (the PRD's "~1600" is corrected)
  TTK_REFERENCE_POOL: 700, // spine: 550 + one T1 HP item
  TTK_BAND_MIN_S: 1.2, // spine
  TTK_BAND_MAX_S: 2.0, // spine
  TTK_ALLOWANCE_AT_1000_S: 2.6, // spine
  REFERENCE_DPS: 437.5, // 700 / 1.6 -- band midpoint. The WEAPONS domain owns the real numbers.
} as const;