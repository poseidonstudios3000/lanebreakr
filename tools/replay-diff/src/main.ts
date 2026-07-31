/**
 * replay-diff — the determinism verifier. PRD §10.2, §12/M1.
 *
 * Three jobs, and the third is the one that pays for the other two:
 *
 *   record   run a scripted match, write a .ovr
 *   verify   replay a .ovr N times, assert every run produces the same state
 *            hash at every checkpoint
 *   hash     print the 10,000-tick hash, for the cross-engine CI job to compare
 *            against the same number produced in Chrome and Firefox
 *
 * §12/M1's criterion is an identical hash across Node, Chrome and Firefox. This
 * tool is the Node half; the browser half runs the same `verify` against the
 * same file under Playwright, which is why the checkpoint format is plain text.
 *
 * The reason any of this exists: from here on, a bug report is a seed and a
 * tick number rather than a description. Six of the seven bugs found last
 * session were found by running the game and reading the output, and every one
 * of them would have been faster to isolate with a replay.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createWorld, tick, hashState, fillWithBots, BOT_TIERS,
  balanceHash, BUILD_HASH, Btn,
  type PlayerInput, type World,
} from '@ovrrun/sim';
import { OvrRecorder, decodeOvr, isCompatible } from '@ovrrun/protocol';

const CHECKPOINT_EVERY = 500;

/** A deterministic, varied input script — movement, look, fire, dash, social. */
function scripted(t: number, id: number): PlayerInput {
  return {
    seq: t & 0xff,
    entityId: id,
    moveX: ((t / (7 + id)) | 0) % 3 - 1,
    moveZ: ((t / (11 + id)) | 0) % 3 - 1,
    yaw: (t * (13 + id * 7)) % 8192,
    pitch: ((t * 5) % 600) - 300,
    buttons:
      (t % (5 + id) === 0 ? Btn.Fire : 0) |
      (t % 137 === 0 ? Btn.Dash : 0) |
      (t % 313 === 0 ? Btn.AbilityQ : 0) |
      (t % 59 === 0 ? Btn.Jump : 0),
    action: t % 211 === 0 ? 1 + (t % 6) : 0,
    fireSubTick: 0,
  };
}

interface RunResult {
  finalHash: number;
  checkpoints: { tick: number; hash: number }[];
}

function runWorld(w: World, ticks: number, feed: (t: number) => PlayerInput[]): RunResult {
  const checkpoints: { tick: number; hash: number }[] = [];
  for (let t = 0; t < ticks; t++) {
    tick(w, feed(t));
    if ((t + 1) % CHECKPOINT_EVERY === 0) {
      checkpoints.push({ tick: t + 1, hash: hashState(w.state) });
    }
  }
  return { finalHash: hashState(w.state), checkpoints };
}

function cmdRecord(out: string, ticks: number, seed: number): void {
  const w = createWorld(seed, 'strip');
  const players = w.state.heroes.length;
  const rec = new OvrRecorder(seed, BUILD_HASH, balanceHash(), players);

  for (let t = 0; t < ticks; t++) {
    const inputs = w.state.heroes.map((h) => scripted(t, h.id));
    rec.record(inputs);
    tick(w, inputs);
  }

  const bytes = rec.encode();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  const kbPerS = (bytes.length / (ticks / 60) / 1024).toFixed(2);
  console.log(`recorded ${ticks} ticks, ${players} players → ${out}`);
  console.log(`  ${(bytes.length / 1024).toFixed(1)} KB  (${kbPerS} KB/s)`);
  console.log(`  final hash 0x${hashState(w.state).toString(16).padStart(8, '0')}`);
}

function cmdVerify(file: string, runs: number): number {
  if (!existsSync(file)) { console.error(`no such file: ${file}`); return 1; }
  const replay = decodeOvr(new Uint8Array(readFileSync(file)));

  if (!isCompatible(replay, BUILD_HASH, balanceHash())) {
    console.error('REFUSED: replay was recorded against a different build or balance.');
    console.error(`  replay build 0x${replay.buildHash.toString(16)} balance 0x${replay.balanceHash.toString(16)}`);
    console.error(`  current build 0x${BUILD_HASH.toString(16)} balance 0x${balanceHash().toString(16)}`);
    console.error('  This is deliberate: a replay that silently diverges is worse');
    console.error('  than one that will not open, because you cannot tell which');
    console.error('  frames were real.');
    return 2;
  }

  let reference: RunResult | null = null;
  for (let r = 0; r < runs; r++) {
    const w = createWorld(replay.seed, 'strip');
    const res = runWorld(w, replay.ticks, (t) => replay.inputs[t]!);
    if (reference === null) { reference = res; continue; }

    if (res.finalHash !== reference.finalHash) {
      const first = res.checkpoints.find((c, i) => c.hash !== reference!.checkpoints[i]?.hash);
      console.error(`DIVERGED on run ${r + 1}`);
      console.error(`  expected 0x${reference.finalHash.toString(16)}, got 0x${res.finalHash.toString(16)}`);
      if (first !== undefined) console.error(`  first divergent checkpoint: tick ${first.tick}`);
      return 1;
    }
  }

  console.log(`OK  ${runs} runs × ${replay.ticks} ticks identical`);
  console.log(`  final hash 0x${reference!.finalHash.toString(16).padStart(8, '0')}`);
  for (const c of reference!.checkpoints) {
    console.log(`  t=${String(c.tick).padStart(6)}  0x${c.hash.toString(16).padStart(8, '0')}`);
  }
  return 0;
}

/** The value the cross-engine CI job compares. Printed alone, so a browser run
 *  can emit the same line and a diff is the whole test. */
function cmdHash(ticks: number, seed: number): void {
  const w = createWorld(seed, 'strip');
  fillWithBots(w, [], BOT_TIERS.normal);
  const res = runWorld(w, ticks, (t) => [scripted(t, 0)]);
  console.log(`seed=${seed} ticks=${ticks} balance=0x${balanceHash().toString(16)}`);
  for (const c of res.checkpoints) {
    console.log(`t=${c.tick} 0x${c.hash.toString(16).padStart(8, '0')}`);
  }
  console.log(`final 0x${res.finalHash.toString(16).padStart(8, '0')}`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'record':
    cmdRecord(rest[0] ?? 'replays/scripted.ovr', Number(rest[1] ?? 3000), Number(rest[2] ?? 0xc0ffee));
    break;
  case 'verify':
    process.exitCode = cmdVerify(rest[0] ?? 'replays/scripted.ovr', Number(rest[1] ?? 3));
    break;
  case 'hash':
    cmdHash(Number(rest[0] ?? 10000), Number(rest[1] ?? 0xc0ffee));
    break;
  default:
    console.log('usage: replay-diff <record|verify|hash> [args]');
    console.log('  record [out.ovr] [ticks] [seed]');
    console.log('  verify [in.ovr] [runs]');
    console.log('  hash   [ticks] [seed]');
    process.exitCode = 1;
}
