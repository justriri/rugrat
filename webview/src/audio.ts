// A tiny procedural audio engine on the Web Audio API. No audio files, no dependencies.
// Every sound is triggered by a message that carries a real, already-decided replay fact (a buy, a
// sell, a wallet event, the collapse). Nothing here reads prices or decides anything: it only
// turns events into sound.
//
// Safety for long sessions and bursts of events:
//  - one AudioContext, created once;
//  - every oscillator/noise voice disconnects itself when it ends;
//  - a hard cap on simultaneous voices, and a minimum gap per sound type;
//  - one music timer, cleared on stop; muted = nothing is scheduled at all.

type OscType = 'sine' | 'square' | 'sawtooth' | 'triangle';

interface ToneOpts {
  type?: OscType;
  gain?: number;
  to?: number;
  attack?: number;
  dest?: AudioNode;
}
interface NoiseOpts {
  gain?: number;
  type?: BiquadFilterType;
  from?: number;
  to?: number;
  q?: number;
  dest?: AudioNode;
}

export interface AudioStats {
  voices: number;
  musicRunning: boolean;
  context: string;
  muted: boolean;
}

export interface Audio {
  unlock(): void;
  setMuted(muted: boolean): void;
  startMusic(): void;
  stopMusic(): void;
  /** 0..1, how much real price movement was just crossed. Drives music tempo and brightness. */
  setTension(t: number): void;
  /** False while the replay clock is frozen (verdict, result): the music ducks. */
  setPlaying(playing: boolean): void;
  /** The collapse: the music turns into a tense drone with a heartbeat. */
  setRug(on: boolean): void;
  buy(): void;
  sell(profit: boolean | null): void;
  warn(): void;
  dev(): void;
  crack(): void;
  crash(): void;
  blip(): void;
  whoosh(up: boolean): void;
  held(): void;
  stats(): AudioStats;
}

const MAX_VOICES = 48;
const MASTER = 0.85;
const MUSIC_PLAYING = 0.15;
const MUSIC_DUCKED = 0.045;
// A minor: Am - F - C - G (MIDI notes)
const PROGRESSION = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const ARP = [0, 1, 2, 1, 2, 1, 0, 2];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export function createAudio(): Audio {
  const AC = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
  let ctx: AudioContext | null = null;
  let master: GainNode;
  let sfx: GainNode;
  let music: GainNode;
  let musicFilter: BiquadFilterNode;
  let noiseBuf: AudioBuffer | null = null;

  let muted = false;
  let voices = 0;
  let musicTimer: ReturnType<typeof setInterval> | null = null;
  let tension = 0;
  let tensionTarget = 0;
  let playing = true;
  let rugMode = false;
  let step = 0;
  let nextTime = 0;
  const lastAt: Record<string, number> = {};

  function ensure(): AudioContext | null {
    if (!AC) return null;
    if (!ctx) {
      try {
        ctx = new AC();
      } catch {
        return null;
      }
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER;
      master.connect(ctx.destination);
      sfx = ctx.createGain();
      sfx.gain.value = 0.8;
      sfx.connect(master);
      musicFilter = ctx.createBiquadFilter();
      musicFilter.type = 'lowpass';
      musicFilter.frequency.value = 900;
      music = ctx.createGain();
      music.gain.value = 0;
      musicFilter.connect(music);
      music.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  }

  function tone(freq: number, at: number, dur: number, o: ToneOpts = {}) {
    const c = ctx;
    if (!c || voices >= MAX_VOICES) return;
    const osc = c.createOscillator();
    const g = c.createGain();
    voices++;
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + dur);
    const peak = o.gain ?? 0.2;
    const atk = o.attack ?? 0.006;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(dur, atk + 0.01));
    osc.connect(g);
    g.connect(o.dest ?? sfx);
    osc.onended = () => {
      voices--;
      osc.disconnect();
      g.disconnect();
    };
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  function noise(at: number, dur: number, o: NoiseOpts = {}) {
    const c = ctx;
    if (!c || !noiseBuf || voices >= MAX_VOICES) return;
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    voices++;
    src.buffer = noiseBuf;
    src.loop = true;
    f.type = o.type ?? 'lowpass';
    f.frequency.setValueAtTime(o.from ?? 2000, at);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, at + dur);
    f.Q.value = o.q ?? 0.7;
    g.gain.setValueAtTime(o.gain ?? 0.2, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.dest ?? sfx);
    src.onended = () => {
      voices--;
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
    src.start(at);
    src.stop(at + dur + 0.03);
  }

  /** Minimum gap per sound type, so a burst of identical events cannot become a wall of noise. */
  function gate(name: string, minMs: number): boolean {
    const now = performance.now();
    if (now - (lastAt[name] ?? -1e9) < minMs) return false;
    lastAt[name] = now;
    return true;
  }

  /** The audio context once ready, or null when audio is unavailable or muted. */
  function ready(name: string, minMs: number): AudioContext | null {
    if (muted) return null;
    const c = ensure();
    if (!c || !gate(name, minMs)) return null;
    return c;
  }

  // ------------------------------------------------------------------ music
  function scheduleMusic() {
    const c = ctx;
    if (!c) return;
    if (muted) {
      nextTime = c.currentTime + 0.1; // nothing queued while muted
      return;
    }
    tension += (tensionTarget - tension) * 0.2;
    const bpm = 76 + 54 * tension;
    const eighth = 60 / bpm / 2;
    while (nextTime < c.currentTime + 0.35) {
      const chord = PROGRESSION[Math.floor(step / 8) % PROGRESSION.length];
      const s = step % 8;
      if (rugMode) {
        // collapse: a low saw drone and a heartbeat
        if (s % 4 === 0) tone(55, nextTime, eighth * 3.6, { type: 'sawtooth', gain: 0.06, dest: musicFilter });
        if (s % 4 === 0) tone(64, nextTime, 0.2, { gain: 0.32, to: 36, dest: music });
        if (s % 4 === 2) tone(58, nextTime, 0.16, { gain: 0.2, to: 34, dest: music });
      } else {
        if (s === 0) for (const n of chord) tone(mtof(n - 12), nextTime, eighth * 8, { type: 'triangle', gain: 0.05, attack: 0.5, dest: musicFilter });
        tone(mtof(chord[ARP[s]] + 12), nextTime, eighth * 0.9, { type: 'square', gain: 0.016 + 0.03 * tension, dest: musicFilter });
        if (s % 4 === 0) tone(mtof(chord[0] - 24), nextTime, eighth * 1.8, { gain: 0.1, dest: musicFilter });
        if (tension > 0.45 && s % 2 === 1) noise(nextTime, 0.04, { type: 'highpass', from: 7000, gain: 0.035, dest: music });
      }
      nextTime += eighth;
      step++;
    }
    musicFilter.frequency.setTargetAtTime(700 + 2300 * tension - (rugMode ? 250 : 0), c.currentTime, 0.25);
  }

  // ------------------------------------------------------------------ public API
  return {
    unlock() {
      ensure();
    },
    setMuted(m) {
      muted = m;
      if (ctx) master.gain.setTargetAtTime(m ? 0 : MASTER, ctx.currentTime, 0.05);
    },
    startMusic() {
      if (musicTimer) return;
      const c = ensure();
      if (!c) return;
      nextTime = c.currentTime + 0.1;
      step = 0;
      rugMode = false;
      music.gain.setTargetAtTime(playing ? MUSIC_PLAYING : MUSIC_DUCKED, c.currentTime, 0.4);
      musicTimer = setInterval(scheduleMusic, 120);
    },
    stopMusic() {
      if (musicTimer) {
        clearInterval(musicTimer);
        musicTimer = null;
      }
      if (ctx) music.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    },
    setTension(t) {
      tensionTarget = Math.max(0, Math.min(1, t));
    },
    setPlaying(p) {
      playing = p;
      if (ctx && musicTimer) music.gain.setTargetAtTime(p ? MUSIC_PLAYING : MUSIC_DUCKED, ctx.currentTime, 0.5);
    },
    setRug(on) {
      rugMode = on;
    },
    buy() {
      const c = ready('buy', 80);
      if (!c) return;
      const t = c.currentTime;
      tone(660, t, 0.09, { type: 'square', gain: 0.11, to: 990 });
      tone(990, t + 0.08, 0.12, { type: 'square', gain: 0.11, to: 1480 });
      tone(1480, t + 0.17, 0.22, { type: 'triangle', gain: 0.12 });
      tone(150, t, 0.14, { gain: 0.3, to: 70 });
    },
    sell(profit) {
      const c = ready('sell', 120);
      if (!c) return;
      const t = c.currentTime;
      noise(t, 0.05, { type: 'highpass', from: 5000, gain: 0.14 });
      [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, t + 0.07 * (i + 1), 0.4, { type: 'triangle', gain: 0.13 }));
      tone(130, t, 0.18, { gain: 0.32, to: 60 });
      if (profit === true) {
        // a profitable cash-out: sparkle and a bright chord
        [2093, 2637, 3136, 3951, 4186].forEach((f, i) => tone(f, t + 0.38 + 0.05 * i, 0.28, { gain: 0.06 }));
        [523, 659, 784].forEach((f) => tone(f, t + 0.32, 0.9, { gain: 0.08, attack: 0.04 }));
      } else if (profit === false) {
        tone(330, t + 0.34, 0.32, { type: 'triangle', gain: 0.11, to: 220 });
        tone(247, t + 0.55, 0.45, { type: 'triangle', gain: 0.1, to: 165 });
      }
    },
    warn() {
      const c = ready('warn', 500);
      if (!c) return;
      const t = c.currentTime;
      [988, 740, 988, 740].forEach((f, i) => tone(f, t + 0.13 * i, 0.11, { type: 'square', gain: 0.085 }));
      tone(110, t, 0.5, { gain: 0.26, to: 70 });
    },
    dev() {
      const c = ready('dev', 400);
      if (!c) return;
      const t = c.currentTime;
      noise(t, 0.55, { type: 'highpass', from: 6000, to: 2500, gain: 0.16 });
      tone(70, t + 0.4, 0.4, { gain: 0.28, to: 40 });
    },
    crack() {
      const c = ready('crack', 300);
      if (!c) return;
      const t = c.currentTime;
      noise(t, 0.4, { from: 2600, to: 180, gain: 0.3 });
      tone(120, t, 0.35, { gain: 0.3, to: 45 });
    },
    crash() {
      const c = ready('crash', 3000);
      if (!c) return;
      const t = c.currentTime;
      noise(t, 2.3, { from: 3200, to: 60, gain: 0.5 });
      noise(t, 0.3, { type: 'highpass', from: 800, gain: 0.35 });
      tone(110, t, 1.9, { type: 'sawtooth', gain: 0.18, to: 28 });
      tone(55, t, 1.9, { gain: 0.5, to: 24 });
      [440, 370, 311, 220].forEach((f, i) => tone(f, t + 0.12 * i, 0.55, { type: 'sawtooth', gain: 0.09, to: f * 0.8 }));
    },
    blip() {
      const c = ready('blip', 70);
      if (!c) return;
      tone(740, c.currentTime, 0.05, { gain: 0.05 });
    },
    whoosh(up) {
      const c = ready('whoosh', 250);
      if (!c) return;
      tone(up ? 320 : 700, c.currentTime, 0.15, { type: 'triangle', gain: 0.07, to: up ? 820 : 200 });
    },
    held() {
      const c = ready('held', 800);
      if (!c) return;
      tone(220, c.currentTime, 0.55, { type: 'triangle', gain: 0.12, to: 110 });
    },
    stats() {
      return { voices, musicRunning: musicTimer !== null, context: ctx ? ctx.state : 'none', muted };
    },
  };
}
