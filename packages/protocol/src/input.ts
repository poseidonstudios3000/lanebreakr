/**
 * protocol/input — the 8-byte input packet.
 *
 * PRD §10.4 originally specified 4 bytes. Counting the fields this design
 * actually mandates shows why that could not work: a sequence number is
 * required (the server acks input seq), movement is two axes, and the button
 * set is thirteen — which leaves ≤7 bits for yaw AND pitch combined, roughly
 * 0.7°/step. That is about 3.4× a head's angular size at the Rifle's falloff
 * limit, so it deletes the ×1.5 headshot multiplier and HALO's entire identity.
 *
 * At 8 bytes the budget is comfortable and the cost is not: 8 B × 60Hz = 480 B/s
 * payload, ~2.9 KB/s with per-packet overhead, against a <3 KB/s up budget.
 *
 * Bit layout, LSB-first, 61 of 64 bits used:
 *
 *   seq            8    wraps every 4.3s at 60Hz — enough for any ack window
 *   moveX          2    ternary, biased by +1
 *   moveZ          2
 *   buttons       13    one per Btn
 *   action         6    emote / ping id, see Action
 *   yaw           13    0.0439°/step
 *   pitch         12    ±90° at 0.0439°/step
 *   fireSubTick    5    which 1/60 slice of the tick the press landed on
 *
 * THE QUANTISATION RULE: yaw and pitch arrive here already quantised, and the
 * client must predict from the same quantised value it sends. Predicting on
 * full-precision angles and transmitting rounded ones mismatches every single
 * shot, and the symptom — shots that visibly connect but do not register —
 * reads as netcode for weeks before anyone suspects the encoder.
 */

import { YAW_STEPS, PITCH_LIMIT, type PlayerInput } from '@ovrrun/sim';

export const INPUT_BYTES = 8;

const MOVE_BIAS = 1; // ternary −1..1 stored as 0..2

export function encodeInput(input: PlayerInput, out: DataView, offset: number): void {
  const yaw = ((input.yaw % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, input.pitch)) + PITCH_LIMIT;

  // Assembled as two 32-bit halves: JS bitwise ops are 32-bit, and doing this
  // with a BigInt would be both slower and a determinism hazard nobody needs.
  const lo =
    (input.seq & 0xff) |
    (((input.moveX + MOVE_BIAS) & 0x3) << 8) |
    (((input.moveZ + MOVE_BIAS) & 0x3) << 10) |
    ((input.buttons & 0x1fff) << 12) |
    ((input.action & 0x7f) << 25);

  const hi =
    (yaw & 0x1fff) |
    ((pitch & 0x3fff) << 13) |
    ((input.fireSubTick & 0x1f) << 27);

  out.setUint32(offset, lo >>> 0, true);
  out.setUint32(offset + 4, hi >>> 0, true);
}

export function decodeInput(entityId: number, view: DataView, offset: number): PlayerInput {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);

  return {
    seq: lo & 0xff,
    entityId,
    moveX: ((lo >>> 8) & 0x3) - MOVE_BIAS,
    moveZ: ((lo >>> 10) & 0x3) - MOVE_BIAS,
    buttons: (lo >>> 12) & 0x1fff,
    action: (lo >>> 25) & 0x7f,
    yaw: hi & 0x1fff,
    pitch: ((hi >>> 13) & 0x3fff) - PITCH_LIMIT,
    fireSubTick: (hi >>> 27) & 0x1f,
  };
}

/** Bits actually consumed — asserted in tests so the layout cannot silently grow. */
export const INPUT_BIT_BUDGET = {
  seq: 8, moveX: 2, moveZ: 2, buttons: 13, action: 7, yaw: 13, pitch: 14, fireSubTick: 5,
  get total(): number {
    return this.seq + this.moveX + this.moveZ + this.buttons + this.action
      + this.yaw + this.pitch + this.fireSubTick;
  },
} as const;
