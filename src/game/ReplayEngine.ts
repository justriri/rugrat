import type { HostMessage } from '../bridge/protocol';
import {
  applyBuy,
  applySell,
  canBuy,
  canSell,
  currentValueSol,
  newPlayer,
  PlayerState,
  totalSol,
  TradeMoment,
} from './player';
import { ClockState, ReplayClock } from './ReplayClock';
import { buildTerrain } from './terrain';
import { buildRevealSummary, eventPriority, revealMarkers, RevealSummary } from './reveal';
import { rugTickIndex, TimelineCursor } from './timeline';
import { computeVerdict, signalBanner, signalEvent, VerdictResult } from './verdict';
import type { Replay, ReplayEvent, TerrainColumn } from './types';

/** Easy: tagged wallet activity is visible. Hard: tags/identities stay hidden until the reveal. */
export type Difficulty = 'easy' | 'hard';

/**
 * idle -> playing -> finished (replay ran out)
 *                \-> exited (player sold: the replay is frozen)
 *                      \-> watching (player chose to watch on: the same clock resumes from the
 *                            exact sell timestamp) -> finished
 * finished -> revealing (the Historical Reveal replays the whole timeline with everything visible)
 *          -> revealed
 */
export type Phase = 'idle' | 'playing' | 'exited' | 'watching' | 'finished' | 'revealing' | 'revealed';

export interface FeedItem {
  key: string;
  event: ReplayEvent;
}

export interface GameSnapshot {
  /** Which replay this run is playing: fixed for the engine's whole life. */
  replayId: string;
  phase: Phase;
  clock: ClockState;
  /** Playback multiplier currently applied to the historical timeline. */
  speed: number;
  tickCount: number;
  /** All trade state: balance, holdings, entry/exit timestamps and prices, realised P/L. */
  player: PlayerState;
  holding: boolean;
  /** Paper-SOL value of the holding at the current replay price (0 when flat). */
  holdingValueSol: number;
  /** Cash + holding value: the number the HUD shows as the balance. */
  totalSol: number;
  /** Unrealised P/L % while holding, null otherwise. */
  unrealizedPnlPct: number | null;
  canBuy: boolean;
  canSell: boolean;
  /** True while the replay is frozen after a sell and the player may choose to watch on. */
  canWatch: boolean;
  /** The run verdict, available once the run has ended and the player traded. */
  verdict: VerdictResult | null;
  /** True on the verdict screen: the player may start the Historical Reveal. */
  canReveal: boolean;
  /** End-of-reveal summary (exit / first smart-wallet exit / collapse), once the reveal is done. */
  reveal: RevealSummary | null;
  /** Newest first. */
  feed: FeedItem[];
  rugActive: boolean;
  difficulty: Difficulty;
  /** False if this run's playback speed was ever changed from the intended speed (a development-only control). Such a run is never recorded for competition. */
  fairRun: boolean;
  /** Whether tags/identities may be shown right now (always in easy; after exit/end in hard). */
  tagsVisible: boolean;
}

const ENDED: Phase[] = ['finished', 'revealing', 'revealed'];

/** How often the single driver pumps the clock. Not a game timer: it only feeds real time in. */
const PUMP_MS = 40;
/** The scene is told the continuous clock every N pumps. */
const CLOCK_SYNC_EVERY = 2;

/**
 * Owns the game state around ONE ReplayClock. Everything the game shows (price, terrain
 * reveal, events, player position) and every trade is derived from the clock; the only timer is
 * the pump that feeds real elapsed time into it. Knows nothing about React or the WebView.
 */
export class ReplayEngine {
  private readonly terrain: TerrainColumn[];
  private readonly rugIndex: number;
  private readonly clock: ReplayClock;
  private cursor: TimelineCursor;
  private baseSpeed: number;
  private listeners = new Set<() => void>();
  private pumpHandle: ReturnType<typeof setInterval> | null = null;
  private lastPumpAt = 0;
  private pumpCount = 0;
  private player: PlayerState = newPlayer();
  private feed: FeedItem[] = [];
  private rugActive = false;
  private phase: Phase = 'idle';
  private difficulty: Difficulty = 'easy';
  /** True if the playback speed was ever not the replay's intended speed during this run. */
  private speedAltered = false;
  private snapshot: GameSnapshot;

  constructor(
    private readonly replay: Replay,
    private readonly send: (msg: HostMessage) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.terrain = buildTerrain(replay.ticks);
    this.rugIndex = rugTickIndex(replay);
    this.baseSpeed = replay.playbackSpeed;
    this.clock = new ReplayClock(replay, this.baseSpeed);
    this.cursor = new TimelineCursor(replay);
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Scene is loaded and listening: (re)start the replay from the first timestamp. */
  start() {
    this.stopPump();
    this.player = newPlayer();
    this.feed = [];
    this.rugActive = false;
    this.phase = 'playing';
    this.speedAltered = this.baseSpeed !== this.replay.playbackSpeed;
    this.clock.reset();
    this.clock.speed = this.baseSpeed;
    this.cursor = new TimelineCursor(this.replay);

    this.send({ type: 'RESET' });
    this.send({ type: 'START_REPLAY', terrain: this.terrain });
    this.consume();
    this.sendClock();
    this.publish();
    this.lastPumpAt = this.now();
    this.pumpHandle = setInterval(() => this.pump(), PUMP_MS);
  }

  reset() {
    this.start();
  }

  /** Global playback multiplier (1 = historical timing). Never changes the sequence. */
  setSpeed(speed: number) {
    this.baseSpeed = speed;
    if (this.phase !== 'idle' && speed !== this.replay.playbackSpeed) this.speedAltered = true;
    if (this.phase === 'playing' || this.phase === 'watching' || this.phase === 'revealing') this.clock.speed = speed;
    this.publish();
  }

  /** Chosen BEFORE the run starts; once a run is under way the difficulty is locked. */
  setDifficulty(difficulty: Difficulty) {
    if (this.phase !== 'idle') return;
    this.difficulty = difficulty;
    this.publish();
  }

  /**
   * Spend all paper SOL at the replay price in force right now. The trade is stamped with the
   * replay clock's exact timestamp (after settling the clock to the present moment) and the price
   * of the tick at that timestamp. There is no other source of time or price.
   */
  buy() {
    if (this.phase !== 'playing' || !canBuy(this.player)) return;
    this.pump(); // settle the clock (and emit anything it passes) so the trade lands exactly "now"
    if (this.phase !== 'playing') return;
    const at = this.moment();
    this.player = applyBuy(this.player, at, this.replay.paperSolUsd);
    this.send({ type: 'BUY', index: at.tickIndex });
    this.publish();
  }

  /**
   * Sell everything at the current replay price, then FREEZE: the clock stops, the pump stops, and
   * no further ticks or wallet events are emitted. Also allowed once the replay has run out (at the
   * final price) so a holding is never stuck.
   */
  sell() {
    if ((this.phase !== 'playing' && this.phase !== 'finished') || !canSell(this.player)) return;
    if (this.phase === 'playing') this.pump();
    const at = this.moment();
    this.player = applySell(this.player, at, this.replay.paperSolUsd);
    this.phase = 'exited';
    this.stopPump();
    this.send({ type: 'SELL', index: at.tickIndex, pnlPct: this.player.realizedPnlPct ?? undefined });
    this.sendClock();
    this.publish();
  }

  /**
   * After a sell the replay is frozen. This resumes it from the exact sell timestamp, on the same
   * clock, at the same playback speed: ticks, wallet events and the collapse continue exactly as
   * the timeline dictates. The player's trade is already closed and cannot change: BUY/SELL stay
   * disabled, so the recorded exit price, timestamp, P/L and balance are final.
   */
  watchWhatHappened() {
    if (this.phase !== 'exited') return;
    this.phase = 'watching';
    this.clock.speed = this.baseSpeed;
    this.lastPumpAt = this.now();
    this.pumpHandle = setInterval(() => this.pump(), PUMP_MS);
    this.publish();
  }

  /**
   * The Historical Reveal. Replays the whole timeline again on the same clock and at the same
   * playback speed, with every tag visible and the player's entry, exit and the collapse marked at
   * their real timestamps. Explanatory only: the player's closed trade and balance are untouched
   * (BUY/SELL stay disabled), no wallet events are created, and the verdict is unaffected.
   */
  startReveal() {
    if (this.phase !== 'finished') return;
    this.stopPump();
    this.feed = [];
    this.rugActive = false;
    this.phase = 'revealing';
    this.clock.reset();
    this.clock.speed = this.baseSpeed;
    this.cursor = new TimelineCursor(this.replay, revealMarkers(this.replay, this.player));

    this.send({ type: 'RESET' });
    this.send({ type: 'START_REPLAY', terrain: this.terrain });
    this.consume();
    this.sendClock();
    this.publish();
    this.lastPumpAt = this.now();
    this.pumpHandle = setInterval(() => this.pump(), PUMP_MS);
  }

  dispose() {
    this.stopPump();
    this.listeners.clear();
  }

  /** Test/debug: feed real milliseconds into the clock without waiting on the pump. */
  advanceForTest(realMs: number) {
    this.step(realMs);
  }

  /** The replay moment right now: exact clock timestamp + the price held at it. */
  private moment(): TradeMoment {
    const s = this.clock.state;
    return { timestamp: s.timestamp, tickIndex: s.index, price: this.replay.ticks[s.index].price };
  }

  private stopPump() {
    if (this.pumpHandle) clearInterval(this.pumpHandle);
    this.pumpHandle = null;
  }

  private pump() {
    const t = this.now();
    const dt = t - this.lastPumpAt;
    this.lastPumpAt = t;
    this.step(dt);
  }

  private step(dtMs: number) {
    if (this.phase !== 'playing' && this.phase !== 'watching' && this.phase !== 'revealing') return; // exited / finished / idle: the clock does not move
    this.clock.advance(dtMs);
    this.consume();
    if (this.clock.state.finished) {
      this.finish();
      return;
    }
    this.pumpCount += 1;
    if (this.pumpCount % CLOCK_SYNC_EVERY === 0) this.sendClock();
    this.publish();
  }

  /** Emit everything the clock has passed, in timeline order. */
  private consume() {
    for (const item of this.cursor.drain(this.clock.timestamp)) {
      if (item.kind === 'tick') {
        this.send({ type: 'PRICE_TICK', index: item.index });
        if (item.index === this.rugIndex) {
          this.rugActive = true;
          this.send({ type: 'SHOW_RUG' });
        }
      } else if (item.kind === 'marker') {
        // Reveal only: the player's entry/exit and the collapse, replayed at their real timestamps
        const m = this.cursor.markerAt(item.index);
        if (m.kind === 'BUY') this.send({ type: 'BUY', index: m.tickIndex });
        else if (m.kind === 'SELL') this.send({ type: 'SELL', index: m.tickIndex, pnlPct: this.player.realizedPnlPct ?? undefined });
        else this.send({ type: 'MARK', kind: m.kind });
      } else {
        const event = this.replay.events[item.index];
        this.feed = [{ key: event.id, event }, ...this.feed];
        const revealing = this.phase === 'revealing';
        const isSignal = revealing && event.id === signalEvent(this.replay)?.id;
        // Hard mode: the scene never receives the label before the reveal. In the reveal it does.
        this.send({
          type: 'WALLET_EVENT',
          id: event.id,
          tag: this.difficulty === 'easy' || revealing ? (event.tag ?? null) : null,
          action: event.action,
          amount: event.amount,
          amountUnit: event.amountUnit,
          ...(revealing
            ? {
                signal: isSignal,
                ...(isSignal ? { signalLabel: signalBanner(this.replay.signal) } : {}),
                priority: eventPriority(event, isSignal),
              }
            : {}),
        });
      }
    }
  }

  private sendClock() {
    const s = this.clock.state;
    this.send({
      type: 'REPLAY_CLOCK',
      index: s.index,
      frac: s.frac,
      timestamp: s.timestamp,
      price: s.price,
      progress: s.progress,
      speed: this.clock.speed,
    });
  }

  private finish() {
    // The replay ran out. A holding stays a holding (no automatic sale); the player can still sell
    // at the final price or play again.
    this.phase = this.phase === 'revealing' ? 'revealed' : 'finished';
    this.stopPump();
    this.sendClock();
    this.publish();
  }

  private buildSnapshot(): GameSnapshot {
    const clock = this.clock.state;
    const p = this.player;
    const sol = this.replay.paperSolUsd;
    const holding = p.tokens > 0;
    const value = currentValueSol(p, clock.price, sol);
    return {
      replayId: this.replay.id,
      phase: this.phase,
      clock,
      speed: this.clock.speed,
      tickCount: this.replay.ticks.length,
      player: p,
      holding,
      holdingValueSol: value,
      totalSol: totalSol(p, clock.price, sol),
      unrealizedPnlPct: holding ? (value / p.solSpent - 1) * 100 : null,
      canBuy: this.phase === 'playing' && canBuy(p),
      canSell: (this.phase === 'playing' || this.phase === 'finished') && canSell(p),
      canWatch: this.phase === 'exited',
      verdict: ENDED.includes(this.phase) ? computeVerdict(this.replay, p) : null,
      canReveal: this.phase === 'finished',
      reveal: this.phase === 'revealed' ? buildRevealSummary(this.replay, p) : null,
      feed: this.feed,
      rugActive: this.rugActive,
      difficulty: this.difficulty,
      fairRun: !this.speedAltered,
      tagsVisible:
        this.difficulty === 'easy' ||
        this.phase === 'exited' ||
        this.phase === 'watching' ||
        this.phase === 'finished' ||
        this.phase === 'revealing' ||
        this.phase === 'revealed',
    };
  }

  private publish() {
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach((l) => l());
  }
}
