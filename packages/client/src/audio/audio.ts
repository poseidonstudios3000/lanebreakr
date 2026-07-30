/**
 * audio — procedural sound. No assets, no downloads, no licensing.
 *
 * PRD §11: "Audio: Higher priority than visuals." §14 now carries a High risk
 * row saying ~80 clips have no source and hard-block M7. This is the answer to
 * that row: every sound is synthesised from arithmetic at load time, committed
 * as code, and tunable by editing a number rather than by re-recording.
 *
 * Two architectural rules, both from §14's "Web audio latency" mitigation:
 *
 *   1. EVERY buffer is rendered once, at init. Nothing is synthesised at fire
 *      time. A 720 RPM weapon fires 12 times a second; building a node graph
 *      per shot is how you get audible jitter on the one sound the player
 *      hears more than any other.
 *   2. Playback is a pooled BufferSource + gain + stereo pan. Three nodes,
 *      created and discarded — that part is cheap; buffer synthesis is not.
 *
 * Positional audio is stereo pan plus distance attenuation plus a distance
 * lowpass, not HRTF. §11 calls directional audio "a competitive information
 * channel", and reliable-and-simple beats accurate-and-inconsistent for that.
 */

type SoundName =
  | 'shot' | 'shotTail' | 'dryFire'
  | 'hit' | 'headshot' | 'kill' | 'impact'
  | 'dash' | 'slide' | 'jump' | 'land' | 'step'
  | 'magOut' | 'magIn' | 'charge'
  | 'zipAttach' | 'zipRide' | 'mantle'
  | 'camera' | 'adsIn' | 'adsOut' | 'respawn';

const SR = 48000;

// ---------------------------------------------------------------------------
// DSP primitives. Everything below operates in place on Float32Array.
// ---------------------------------------------------------------------------

function buf(seconds: number): Float32Array {
  return new Float32Array(Math.ceil(seconds * SR));
}

function noise(out: Float32Array, gain = 1): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + (Math.random() * 2 - 1) * gain;
  return out;
}

/** Exponential decay envelope. `curve` > 1 makes the tail snappier. */
function decay(out: Float32Array, seconds: number, curve = 3, start = 0): Float32Array {
  const n = Math.min(out.length, Math.ceil(seconds * SR));
  const s = Math.floor(start * SR);
  for (let i = 0; i < out.length; i++) {
    if (i < s) { out[i] = 0; continue; }
    const t = (i - s) / n;
    out[i] = t >= 1 ? 0 : out[i]! * Math.pow(1 - t, curve);
  }
  return out;
}

/** Short linear fade-in — removes the click a hard buffer start otherwise makes. */
function attack(out: Float32Array, seconds: number): Float32Array {
  const n = Math.ceil(seconds * SR);
  for (let i = 0; i < n && i < out.length; i++) out[i] = out[i]! * (i / n);
  return out;
}

function onePoleLP(out: Float32Array, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  let y = 0;
  for (let i = 0; i < out.length; i++) { y += a * (out[i]! - y); out[i] = y; }
  return out;
}

function onePoleHP(out: Float32Array, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  let y = 0;
  for (let i = 0; i < out.length; i++) { y += a * (out[i]! - y); out[i] = out[i]! - y; }
  return out;
}

/** State-variable bandpass with a swept centre frequency — the whoosh maker. */
function sweepBP(out: Float32Array, f0: number, f1: number, q: number): Float32Array {
  let low = 0, band = 0;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = f0 + (f1 - f0) * t;
    const fc = 2 * Math.sin((Math.PI * Math.min(f, SR * 0.45)) / SR);
    const high = out[i]! - low - q * band;
    band += fc * high;
    low += fc * band;
    out[i] = band;
  }
  return out;
}

/** Sine with an optional exponential pitch sweep. */
function sine(out: Float32Array, f0: number, f1 = f0, gain = 1): Float32Array {
  let phase = 0;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = f0 * Math.pow(f1 / f0, t);
    phase += (2 * Math.PI * f) / SR;
    out[i] = out[i]! + Math.sin(phase) * gain;
  }
  return out;
}

/** Soft clip. Adds the harmonics that make a shot read as loud rather than big. */
function saturate(out: Float32Array, drive = 2): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]! * drive) / Math.tanh(drive);
  return out;
}

function mix(dst: Float32Array, src: Float32Array, gain = 1): Float32Array {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = dst[i]! + src[i]! * gain;
  return dst;
}

function normalise(out: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]!); if (a > max) max = a; }
  if (max > 1e-6) { const g = peak / max; for (let i = 0; i < out.length; i++) out[i] = out[i]! * g; }
  return out;
}

// ---------------------------------------------------------------------------
// The sound bank. Each entry is one recipe.
// ---------------------------------------------------------------------------

const RECIPES: Record<SoundName, () => Float32Array> = {
  /**
   * The SMG shot — by a wide margin the sound the player hears most, so it
   * gets four layers. Crack for presence, body for weight, thump for the low
   * end a laptop speaker will not reproduce but headphones will, and a short
   * air tail so consecutive shots at 12/s overlap into a texture instead of
   * machine-gunning the same 40ms sample.
   */
  shot: () => {
    const out = buf(0.22);
    mix(out, decay(onePoleHP(noise(buf(0.22)), 3500), 0.020, 4), 0.85); // crack
    mix(out, decay(sweepBP(noise(buf(0.22)), 1600, 700, 0.7), 0.075, 3), 1.0); // body
    mix(out, decay(sine(buf(0.22), 190, 62, 1), 0.090, 2.4), 0.55); // thump
    mix(out, decay(onePoleHP(noise(buf(0.22)), 1200), 0.180, 5), 0.16); // air
    return normalise(saturate(out, 1.8), 0.92);
  },

  shotTail: () => {
    const out = decay(onePoleLP(onePoleHP(noise(buf(0.35)), 400), 3000), 0.34, 4);
    return normalise(out, 0.20);
  },

  dryFire: () => {
    const out = buf(0.08);
    mix(out, decay(onePoleHP(noise(buf(0.08)), 2500), 0.012, 5), 1);
    mix(out, decay(sine(buf(0.08), 900, 400), 0.02, 4), 0.3);
    return normalise(out, 0.35);
  },

  /** Flesh hit. Deliberately dry and mid-forward so it cuts through the shot. */
  hit: () => {
    const out = buf(0.09);
    mix(out, decay(sweepBP(noise(buf(0.09)), 900, 380, 0.9), 0.055, 3), 1);
    mix(out, decay(sine(buf(0.09), 320, 150), 0.05, 3), 0.35);
    return normalise(out, 0.55);
  },

  /** Headshot. A bright two-partial ding — the reward tone. */
  headshot: () => {
    const out = buf(0.28);
    mix(out, decay(sine(buf(0.28), 1760, 1740), 0.26, 2.2), 0.5);
    mix(out, decay(sine(buf(0.28), 2640, 2600), 0.18, 2.6), 0.28);
    mix(out, decay(onePoleHP(noise(buf(0.28)), 4000), 0.03, 4), 0.25);
    return normalise(attack(out, 0.002), 0.62);
  },

  /** Kill confirm. Rising, not falling — a fall reads as "you died". */
  kill: () => {
    const out = buf(0.42);
    mix(out, decay(sine(buf(0.42), 440, 660), 0.20, 2), 0.42);
    mix(out, decay(sine(buf(0.42), 660, 990), 0.38, 2.4, 0.07), 0.34);
    mix(out, decay(onePoleHP(noise(buf(0.42)), 3000), 0.05, 4), 0.2);
    return normalise(attack(out, 0.003), 0.7);
  },

  /** Geometry impact — dry tick plus a puff of dust. */
  impact: () => {
    const out = buf(0.16);
    mix(out, decay(onePoleHP(noise(buf(0.16)), 2600), 0.018, 5), 0.7);
    mix(out, decay(onePoleLP(noise(buf(0.16)), 900), 0.130, 4), 0.32);
    return normalise(out, 0.42);
  },

  /** Dash. The whoosh is the whole feel of the ability. */
  dash: () => {
    const out = buf(0.34);
    mix(out, decay(sweepBP(noise(buf(0.34)), 260, 2200, 0.55), 0.20, 1.6), 1);
    mix(out, decay(sweepBP(noise(buf(0.34)), 2000, 300, 0.6), 0.30, 2.2, 0.05), 0.6);
    mix(out, decay(sine(buf(0.34), 120, 300), 0.10, 2), 0.25);
    return normalise(attack(out, 0.004), 0.62);
  },

  slide: () => {
    const out = decay(sweepBP(noise(buf(0.9)), 1400, 500, 1.1), 0.85, 1.4);
    return normalise(attack(out, 0.02), 0.34);
  },

  jump: () => {
    const out = buf(0.14);
    mix(out, decay(onePoleLP(noise(buf(0.14)), 1600), 0.06, 3), 0.5);
    mix(out, decay(sine(buf(0.14), 240, 380), 0.09, 2.5), 0.3);
    return normalise(out, 0.3);
  },

  land: () => {
    const out = buf(0.24);
    mix(out, decay(sine(buf(0.24), 150, 55), 0.14, 2.2), 0.8);
    mix(out, decay(onePoleLP(noise(buf(0.24)), 1100), 0.09, 3.5), 0.5);
    return normalise(out, 0.5);
  },

  /**
   * Footstep. §4.1 makes tunnel footsteps a deliberate information source, so
   * this needs to be legible and directional rather than ambient texture.
   */
  step: () => {
    const out = buf(0.13);
    mix(out, decay(onePoleLP(noise(buf(0.13)), 1300), 0.055, 3.2), 0.75);
    mix(out, decay(onePoleHP(noise(buf(0.13)), 3000), 0.016, 5), 0.22);
    mix(out, decay(sine(buf(0.13), 110, 70), 0.05, 3), 0.3);
    return normalise(out, 0.30);
  },

  magOut: () => {
    const out = buf(0.13);
    mix(out, decay(onePoleHP(noise(buf(0.13)), 2200), 0.02, 4), 0.6);
    mix(out, decay(sine(buf(0.13), 620, 380), 0.05, 3), 0.35);
    return normalise(out, 0.34);
  },

  magIn: () => {
    const out = buf(0.16);
    mix(out, decay(onePoleHP(noise(buf(0.16)), 1800), 0.025, 4), 0.75);
    mix(out, decay(sine(buf(0.16), 320, 190), 0.07, 2.6), 0.45);
    return normalise(out, 0.44);
  },

  charge: () => {
    const out = buf(0.15);
    mix(out, decay(onePoleHP(noise(buf(0.15)), 3200), 0.02, 5), 0.6);
    mix(out, decay(sine(buf(0.15), 900, 520), 0.045, 3), 0.3);
    mix(out, decay(sine(buf(0.15), 480, 300), 0.09, 3, 0.05), 0.28);
    return normalise(out, 0.40);
  },

  zipAttach: () => {
    const out = buf(0.2);
    mix(out, decay(onePoleHP(noise(buf(0.2)), 4000), 0.03, 4), 0.5);
    mix(out, decay(sine(buf(0.2), 1200, 1800), 0.12, 2), 0.3);
    return normalise(out, 0.42);
  },

  /** Metallic hum, looped while riding. */
  zipRide: () => {
    const out = buf(0.5);
    mix(out, sweepBP(noise(buf(0.5)), 2400, 2400, 0.25), 1);
    mix(out, sine(buf(0.5), 620, 620, 0.35), 0.4);
    mix(out, sine(buf(0.5), 933, 933, 0.2), 0.25);
    // Loopable: crossfade the seam so a repeat does not click.
    const n = out.length, f = Math.floor(SR * 0.02);
    for (let i = 0; i < f; i++) {
      const t = i / f;
      out[i] = out[i]! * t + out[n - f + i]! * (1 - t);
    }
    return normalise(out, 0.20);
  },

  mantle: () => {
    const out = buf(0.3);
    mix(out, decay(sweepBP(noise(buf(0.3)), 700, 1500, 0.9), 0.16, 2), 0.6);
    mix(out, decay(sine(buf(0.3), 130, 210), 0.22, 2), 0.35);
    return normalise(attack(out, 0.005), 0.4);
  },

  camera: () => {
    const out = buf(0.11);
    mix(out, decay(sine(buf(0.11), 1400, 900), 0.05, 3), 0.35);
    mix(out, decay(onePoleHP(noise(buf(0.11)), 4500), 0.012, 5), 0.25);
    return normalise(out, 0.24);
  },

  adsIn: () => normalise(decay(sine(buf(0.1), 500, 760), 0.07, 2.5), 0.2),
  adsOut: () => normalise(decay(sine(buf(0.1), 760, 500), 0.07, 2.5), 0.16),

  respawn: () => {
    const out = buf(0.32);
    mix(out, decay(sine(buf(0.32), 300, 900), 0.28, 2), 0.4);
    mix(out, decay(onePoleHP(noise(buf(0.32)), 2000), 0.06, 4), 0.15);
    return normalise(attack(out, 0.01), 0.34);
  },
};

// ---------------------------------------------------------------------------

export interface PlayOpts {
  gain?: number;
  rate?: number;
  /** World position. Omit for sounds the local player makes. */
  pos?: { x: number; y: number; z: number };
  loop?: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fz: -1 };
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();

  ready = false;
  muted = false;

  /** Must be called from a user gesture — browsers refuse audio otherwise. */
  init(): void {
    if (this.ctx !== null) { void this.ctx.resume(); return; }

    const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ sampleRate: SR, latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;

    // A gentle limiter on the master bus. Twelve shots a second plus impacts
    // plus footsteps will clip an unprotected bus, and clipping reads as
    // "cheap" more than any individual sound does.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.14;
    this.master.connect(comp).connect(this.ctx.destination);

    for (const name of Object.keys(RECIPES) as SoundName[]) {
      const data = RECIPES[name]();
      const b = this.ctx.createBuffer(1, data.length, SR);
      b.getChannelData(0).set(data);
      this.buffers.set(name, b);
    }
    this.ready = true;
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x; this.listener.y = y; this.listener.z = z;
    // Matches the sim's convention: yaw 0 looks down −Z.
    this.listener.fx = Math.sin(yaw); this.listener.fz = -Math.cos(yaw);
    this.listener.rx = Math.cos(yaw); this.listener.rz = Math.sin(yaw);
  }

  play(name: SoundName, opts: PlayOpts = {}): void {
    if (!this.ready || this.muted || this.ctx === null || this.master === null) return;
    const b = this.buffers.get(name);
    if (b === undefined) return;

    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = opts.rate ?? 1;

    let node: AudioNode = src;
    let gain = opts.gain ?? 1;

    if (opts.pos !== undefined) {
      const dx = opts.pos.x - this.listener.x;
      const dy = opts.pos.y - this.listener.y;
      const dz = opts.pos.z - this.listener.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Inverse-distance with a 1m reference, floored so nothing vanishes.
      gain *= 1 / (1 + dist / 6);

      const pan = this.ctx.createStereoPanner();
      const inv = dist > 1e-4 ? 1 / dist : 0;
      pan.pan.value = Math.max(-1, Math.min(1, (dx * this.listener.rx + dz * this.listener.rz) * inv));
      node.connect(pan);
      node = pan;

      if (dist > 12) {
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(900, 14000 - dist * 220);
        node.connect(lp);
        node = lp;
      }
    }

    const g = this.ctx.createGain();
    g.gain.value = gain;
    node.connect(g).connect(this.master);
    src.start();
  }

  startLoop(key: string, name: SoundName, gain = 1): void {
    if (!this.ready || this.ctx === null || this.master === null || this.loops.has(key)) return;
    const b = this.buffers.get(name);
    if (b === undefined) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, this.ctx.currentTime + 0.06);
    src.connect(g).connect(this.master);
    src.start();
    this.loops.set(key, { src, gain: g });
  }

  stopLoop(key: string): void {
    const l = this.loops.get(key);
    if (l === undefined || this.ctx === null) return;
    l.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    l.gain.gain.setValueAtTime(l.gain.gain.value, this.ctx.currentTime);
    l.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.08);
    l.src.stop(this.ctx.currentTime + 0.1);
    this.loops.delete(key);
  }

  setMasterVolume(v: number): void {
    if (this.master !== null) this.master.gain.value = v;
  }
}
