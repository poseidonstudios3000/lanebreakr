/**
 * protocol/ovr — the replay format.
 *
 * PRD §9.1 specified a rolling 20-second ring buffer of compressed world
 * snapshots, ~200KB. That is the design you need when the sim is not
 * reproducible — and §10.3 guarantees that it is. So a replay is its inputs:
 *
 *     .ovr = { seed, buildHash, balanceHash, inputLog }
 *
 * At 8 bytes × 60Hz × 6 players that is ~2.9 KB/s, so a whole 12-minute match
 * is ~2 MB — against 200KB for 3% of the match. It is also seekable (re-simulate
 * to the tick), it needs no server ring buffer (the server is authoritative
 * over the input stream and already has it), and it falls out of `replay-diff`,
 * which M1 requires anyway. Half of M6 disappears.
 *
 * The honest cost: an input-log replay only reproduces against the sim and
 * balance it was recorded with. Both hashes are pinned in the header, playback
 * refuses on mismatch rather than showing a subtly wrong match, and shared
 * links expire. For a clip that is the right trade — a clip is a moment, not an
 * archive.
 *
 * Layout:
 *   magic     4   "OVR1"
 *   version   2
 *   flags     2
 *   seed      4
 *   buildHash 4
 *   balHash   4
 *   players   1
 *   pad       1
 *   ticks     4
 *   ────────── 26-byte header, then ticks × players × 8 bytes
 */

import type { PlayerInput } from '@ovrrun/sim';
import { INPUT_BYTES, encodeInput, decodeInput } from './input.js';

export const OVR_MAGIC = 0x3152564f; // "OVR1" little-endian
export const OVR_VERSION = 1;
export const OVR_HEADER_BYTES = 26;

export interface OvrHeader {
  version: number;
  seed: number;
  buildHash: number;
  balanceHash: number;
  players: number;
  ticks: number;
}

export interface OvrReplay extends OvrHeader {
  /** `[tick][playerIndex]` — dense, because a missing input is a real input
   *  (§10.4: repeat the last for ≤3 ticks, then zero movement). Storing holes
   *  would make the replay ambiguous about which of those happened. */
  inputs: PlayerInput[][];
}

/** Accumulates inputs during a live match. Cheap enough to always be on. */
export class OvrRecorder {
  private readonly frames: PlayerInput[][] = [];

  constructor(
    readonly seed: number,
    readonly buildHash: number,
    readonly balanceHash: number,
    readonly players: number,
  ) {}

  /** Call once per tick with the inputs actually fed to `tick()`. */
  record(inputs: readonly PlayerInput[]): void {
    const frame: PlayerInput[] = [];
    // Dense and ordered by entity id, so playback needs no lookup and the
    // encoding is stable regardless of arrival order.
    for (let id = 0; id < this.players; id++) {
      const found = inputs.find((i) => i.entityId === id);
      frame.push(found ?? {
        seq: 0, entityId: id, moveX: 0, moveZ: 0,
        yaw: 0, pitch: 0, buttons: 0, action: 0, fireSubTick: 0,
      });
    }
    this.frames.push(frame);
  }

  get ticks(): number {
    return this.frames.length;
  }

  /** Keep only the last N ticks — the F9 "export the last 20 seconds" path. */
  trimTo(maxTicks: number): void {
    if (this.frames.length > maxTicks) this.frames.splice(0, this.frames.length - maxTicks);
  }

  encode(): Uint8Array {
    return encodeOvr({
      version: OVR_VERSION,
      seed: this.seed,
      buildHash: this.buildHash,
      balanceHash: this.balanceHash,
      players: this.players,
      ticks: this.frames.length,
      inputs: this.frames,
    });
  }
}

export function encodeOvr(r: OvrReplay): Uint8Array {
  const bytes = OVR_HEADER_BYTES + r.ticks * r.players * INPUT_BYTES;
  const buf = new Uint8Array(bytes);
  const view = new DataView(buf.buffer);

  view.setUint32(0, OVR_MAGIC, true);
  view.setUint16(4, r.version, true);
  view.setUint16(6, 0, true); // flags
  view.setUint32(8, r.seed >>> 0, true);
  view.setUint32(12, r.buildHash >>> 0, true);
  view.setUint32(16, r.balanceHash >>> 0, true);
  view.setUint8(20, r.players);
  view.setUint8(21, 0);
  view.setUint32(22, r.ticks, true);

  let off = OVR_HEADER_BYTES;
  for (let t = 0; t < r.ticks; t++) {
    const frame = r.inputs[t]!;
    for (let p = 0; p < r.players; p++) {
      encodeInput(frame[p]!, view, off);
      off += INPUT_BYTES;
    }
  }
  return buf;
}

export function decodeOvr(buf: Uint8Array): OvrReplay {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== OVR_MAGIC) throw new Error('not an .ovr file');
  const version = view.getUint16(4, true);
  if (version !== OVR_VERSION) throw new Error(`.ovr version ${version}, expected ${OVR_VERSION}`);

  const players = view.getUint8(20);
  const ticks = view.getUint32(22, true);
  const inputs: PlayerInput[][] = [];

  let off = OVR_HEADER_BYTES;
  for (let t = 0; t < ticks; t++) {
    const frame: PlayerInput[] = [];
    for (let p = 0; p < players; p++) {
      frame.push(decodeInput(p, view, off));
      off += INPUT_BYTES;
    }
    inputs.push(frame);
  }

  return {
    version,
    seed: view.getUint32(8, true),
    buildHash: view.getUint32(12, true),
    balanceHash: view.getUint32(16, true),
    players, ticks, inputs,
  };
}

/**
 * Whether this replay can be trusted against the current build.
 * Playback must REFUSE on mismatch rather than render a subtly wrong match —
 * a replay that silently diverges is worse than one that will not open, because
 * you cannot tell which frames were real.
 */
export function isCompatible(r: OvrHeader, buildHash: number, balanceHash: number): boolean {
  return r.buildHash === buildHash && r.balanceHash === balanceHash;
}
