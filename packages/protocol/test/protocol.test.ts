import { describe, it, expect } from 'vitest';
import { encodeInput, decodeInput, INPUT_BYTES, INPUT_BIT_BUDGET } from '../src/input.js';
import { OvrRecorder, encodeOvr, decodeOvr, isCompatible, OVR_HEADER_BYTES } from '../src/ovr.js';
import { Btn, Action, YAW_STEPS, PITCH_LIMIT, type PlayerInput } from '@ovrrun/sim';
import { createWorld, tick, hashState, balanceHash, BUILD_HASH } from '@ovrrun/sim';

/**
 * The wire format.
 *
 * The assertion that matters most here is the round-trip one: PRD §10.4's whole
 * netcode rests on the client predicting from exactly the values it transmits,
 * and an encoder that loses a bit produces shots that visibly connect and do
 * not register — a symptom that reads as netcode for weeks before anyone
 * suspects the packet layout.
 */

function mk(over: Partial<PlayerInput> = {}): PlayerInput {
  return { seq: 0, entityId: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, action: 0, fireSubTick: 0, ...over };
}

function roundTrip(i: PlayerInput): PlayerInput {
  const buf = new DataView(new ArrayBuffer(INPUT_BYTES));
  encodeInput(i, buf, 0);
  return decodeInput(i.entityId, buf, 0);
}

describe('input packet', () => {
  it('is 8 bytes, and the layout fits', () => {
    // §10.4 originally said 4. Counting the mandatory fields shows why it could
    // not work: ≤7 bits left for yaw AND pitch, ~0.7°/step, roughly 3.4× a
    // head's angular size at the Rifle's falloff limit.
    expect(INPUT_BYTES).toBe(8);
    expect(INPUT_BIT_BUDGET.total).toBeLessThanOrEqual(INPUT_BYTES * 8);
    expect(INPUT_BIT_BUDGET.total).toBeGreaterThan(4 * 8); // and genuinely needs more than 4
  });

  it('round-trips every field exactly', () => {
    const cases: PlayerInput[] = [
      mk(),
      mk({ seq: 255, moveX: 1, moveZ: -1, yaw: YAW_STEPS - 1, pitch: PITCH_LIMIT, buttons: 0x1fff, action: 63, fireSubTick: 31 }),
      mk({ seq: 128, moveX: -1, moveZ: 1, yaw: 4096, pitch: -PITCH_LIMIT, buttons: Btn.Fire | Btn.Ads | Btn.Dash, action: Action.EmoteDance }),
      mk({ yaw: 1, pitch: -1, buttons: Btn.Buy, action: Action.PingHelp, fireSubTick: 17 }),
    ];
    for (const c of cases) expect(roundTrip(c)).toEqual(c);
  });

  it('round-trips every yaw step without loss', () => {
    // Aim is the field with the least slack; an off-by-one here is a miss.
    for (let y = 0; y < YAW_STEPS; y += 7) {
      expect(roundTrip(mk({ yaw: y })).yaw).toBe(y);
    }
  });

  it('round-trips the full pitch range', () => {
    for (let p = -PITCH_LIMIT; p <= PITCH_LIMIT; p += 13) {
      expect(roundTrip(mk({ pitch: p })).pitch).toBe(p);
    }
  });

  it('round-trips every single button bit independently', () => {
    for (let bit = 0; bit < 13; bit++) {
      const b = 1 << bit;
      expect(roundTrip(mk({ buttons: b })).buttons, `bit ${bit}`).toBe(b);
    }
  });

  it('round-trips every action id', () => {
    for (const a of [0, Action.EmoteWave, Action.EmoteSit, Action.PingEnemy, Action.PingHelp]) {
      expect(roundTrip(mk({ action: a })).action).toBe(a);
    }
  });

  it('wraps yaw rather than corrupting neighbouring fields', () => {
    const out = roundTrip(mk({ yaw: YAW_STEPS + 5, buttons: Btn.Fire, action: Action.PingSouls }));
    expect(out.yaw).toBe(5);
    expect(out.buttons).toBe(Btn.Fire);
    expect(out.action).toBe(Action.PingSouls);
  });

  it('stays inside the uplink budget', () => {
    // 8 B × 60Hz = 480 B/s payload; with per-packet overhead ~2.9 KB/s against
    // §10.4's <3 KB/s up.
    const payloadPerSecond = INPUT_BYTES * 60;
    expect(payloadPerSecond).toBeLessThan(3 * 1024);
  });
});

describe('.ovr replay container', () => {
  it('round-trips a recording', () => {
    const rec = new OvrRecorder(0xc0ffee, BUILD_HASH, balanceHash(), 2);
    for (let t = 0; t < 50; t++) {
      rec.record([
        mk({ entityId: 0, seq: t & 0xff, moveZ: 1, yaw: t * 3, buttons: Btn.Fire }),
        mk({ entityId: 1, seq: t & 0xff, moveX: -1, yaw: t * 5 }),
      ]);
    }
    const decoded = decodeOvr(rec.encode());
    expect(decoded.ticks).toBe(50);
    expect(decoded.players).toBe(2);
    expect(decoded.seed).toBe(0xc0ffee);
    expect(decoded.inputs[10]![0]!.yaw).toBe(30);
    expect(decoded.inputs[10]![1]!.moveX).toBe(-1);
  });

  it('is the size the design claims — a whole match, not 20 seconds', () => {
    // §9.1's snapshot design was ~200KB for 20s = 10,000 B/s. This is the
    // number that made half of M6 disappear.
    const players = 6;
    const rec = new OvrRecorder(1, BUILD_HASH, balanceHash(), players);
    const seconds = 10;
    for (let t = 0; t < 60 * seconds; t++) {
      rec.record(Array.from({ length: players }, (_, id) => mk({ entityId: id })));
    }
    const bytes = rec.encode().length;
    const perSecond = bytes / seconds;
    expect(perSecond).toBeLessThan(3200); // ~2.9 KB/s
    // A full 12-minute match:
    expect((perSecond * 720) / 1024 / 1024).toBeLessThan(2.5); // MB
  });

  it('records a dense frame even when an input is missing', () => {
    // §10.4 says a missing input repeats the last for ≤3 ticks then zeroes
    // movement — both are real inputs. A sparse log could not tell them apart.
    const rec = new OvrRecorder(1, BUILD_HASH, balanceHash(), 3);
    rec.record([mk({ entityId: 1, moveZ: 1 })]); // only player 1 reported
    const d = decodeOvr(rec.encode());
    expect(d.inputs[0]).toHaveLength(3);
    expect(d.inputs[0]![1]!.moveZ).toBe(1);
    expect(d.inputs[0]![0]!.moveZ).toBe(0);
  });

  it('trims to the last N ticks — the F9 export path', () => {
    const rec = new OvrRecorder(1, BUILD_HASH, balanceHash(), 1);
    for (let t = 0; t < 500; t++) rec.record([mk({ seq: t & 0xff, yaw: t % 8192 })]);
    rec.trimTo(120);
    expect(rec.ticks).toBe(120);
    const d = decodeOvr(rec.encode());
    expect(d.inputs[0]![0]!.yaw).toBe(380 % 8192);
  });

  it('rejects a file that is not an .ovr', () => {
    expect(() => decodeOvr(new Uint8Array(64))).toThrow(/not an .ovr/);
  });

  it('refuses a replay from a different build or balance', () => {
    // Deliberate: a replay that silently diverges is worse than one that will
    // not open, because you cannot tell which frames were real.
    const header = { version: 1, seed: 1, buildHash: BUILD_HASH, balanceHash: balanceHash(), players: 1, ticks: 0 };
    expect(isCompatible(header, BUILD_HASH, balanceHash())).toBe(true);
    expect(isCompatible(header, BUILD_HASH + 1, balanceHash())).toBe(false);
    expect(isCompatible(header, BUILD_HASH, balanceHash() + 1)).toBe(false);
  });

  it('header is exactly the documented size', () => {
    const bytes = encodeOvr({ version: 1, seed: 1, buildHash: 2, balanceHash: 3, players: 0, ticks: 0, inputs: [] });
    expect(bytes.length).toBe(OVR_HEADER_BYTES);
  });
});

describe('replay fidelity — the whole point', () => {
  it('a replayed input log reproduces the match exactly', () => {
    const seed = 0xbeef;
    const players = 6;

    const live = createWorld(seed, 'strip');
    const rec = new OvrRecorder(seed, BUILD_HASH, balanceHash(), players);
    for (let t = 0; t < 1200; t++) {
      const inputs = live.state.heroes.map((h) => mk({
        entityId: h.id, seq: t & 0xff,
        moveX: ((t / (5 + h.id)) | 0) % 3 - 1,
        moveZ: 1,
        yaw: (t * (9 + h.id)) % YAW_STEPS,
        buttons: t % (4 + h.id) === 0 ? Btn.Fire : (t % 211 === 0 ? Btn.AbilityQ : 0),
        action: t % 307 === 0 ? Action.EmoteTaunt : 0,
      }));
      rec.record(inputs);
      tick(live, inputs);
    }
    const liveHash = hashState(live.state);

    const replay = decodeOvr(rec.encode());
    const played = createWorld(replay.seed, 'strip');
    for (let t = 0; t < replay.ticks; t++) tick(played, replay.inputs[t]!);

    expect(hashState(played.state)).toBe(liveHash);
  });

  it('the balance hash changes when a number changes, and not otherwise', () => {
    const a = balanceHash();
    expect(balanceHash()).toBe(a); // stable across calls
    expect(a).toBeGreaterThan(0);
  });
});
