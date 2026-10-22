// 运动显示与本地预测（纯逻辑，无 DOM，可单测）。
//
// 时间轴（单位：tick，S = 估计的服务端当前 tick，A = 最新收到的权威 tick）：
//   其他玩家  渲染在 R ≈ S − 单程延迟 − 缓冲 ≈ A − 1        —— 插值：只用已经收到的数据，画面平滑
//   自己      渲染在 P ≈ S + 单程延迟 + 余量               —— 预测：输入预约在 P 之后的 tick 生效，
//                                                            服务端恰好在那个 tick 应用，所以重演结果与服务端一致
// 自己的位置 = 用 shared 的 step() 从权威状态 A 出发，重演尚未确认的输入，一直推到 P。
// 预测与权威不一致（输入迟到、被丢弃、时钟估计跳变）时计一次"纠正"，画面用一个衰减偏移平滑过去。

import { MAX_INPUTS_PER_TICK, MOVE_UNITS, SPEED_NORMAL, TICK_MS, type Dir } from '@turf/shared/constants';
import { step, type Cmd, type GameState } from '@turf/shared/game';
import type { PState, RoomView } from '@turf/shared/protocol';
import type { ClientGame } from './sync';

/** 进入某一格的时刻。显示时从"上一段在这一刻的位置"滑到这一格，用时 dur 个 tick */
export interface Arrival {
  t: number;
  x: number;
  y: number;
  dur: number;
}

export interface Vec {
  x: number;
  y: number;
}

const HISTORY = 24;
/** 常速每走一格需要的 tick 数（3） */
export const STEP_TICKS = MOVE_UNITS / SPEED_NORMAL;
/** 其他玩家的插值缓冲（tick），在单程延迟之外再多等这么久，吸收抖动 */
export const INTERP_TICKS = 1;
/** 预测最多领先权威状态多少 tick；延迟再大也不继续往前猜 */
export const MAX_PREDICT_TICKS = 14;
/** 预约余量：输入要比目标 tick 提前这么久到达服务端 */
const LEAD_MARGIN_MS = 15;
const CORRECTION_TAU_MS = 90;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function durBetween(t: number, prevT: number): number {
  return clamp(t - prevT, 1, STEP_TICKS);
}

/** 由到达序列计算 tick 时刻的显示位置。每段的起点取上一段在该时刻的位置，所以变速、转向都连续 */
export function positionAt(hist: readonly Arrival[], tick: number): Vec | null {
  if (hist.length === 0) return null;
  const first = hist[0]!;
  let sx = first.x;
  let sy = first.y;
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i]!;
    if (a.t > tick) break;
    const prev = hist[i - 1]!;
    const next = hist[i + 1];
    // 这一段的起点 = 上一段滑到此刻的位置
    if (i > 1) {
      const k = clamp((a.t - prev.t) / prev.dur, 0, 1);
      sx = sx + (prev.x - sx) * k;
      sy = sy + (prev.y - sy) * k;
    } else {
      sx = prev.x;
      sy = prev.y;
    }
    if (!next || next.t > tick) {
      const k = clamp((tick - a.t) / a.dur, 0, 1);
      return { x: sx + (a.x - sx) * k, y: sy + (a.y - sy) * k };
    }
  }
  // tick 早于第二个到达点：停在第一个点
  if (hist.length === 1 || hist[1]!.t > tick) return { x: first.x, y: first.y };
  const last = hist[hist.length - 1]!;
  return { x: last.x, y: last.y };
}

/** 从权威 tick 流里提取每名玩家的到达序列 */
export class MotionTracker {
  private hist = new Map<string, Arrival[]>();

  reset(players: readonly PState[], tick: number): void {
    this.hist.clear();
    for (const p of players) this.hist.set(p.id, [{ t: tick, x: p.x, y: p.y, dur: 1 }]);
  }

  onTick(players: readonly PState[], tick: number): void {
    for (const p of players) {
      const h = this.hist.get(p.id);
      if (!h || h.length === 0) {
        this.hist.set(p.id, [{ t: tick, x: p.x, y: p.y, dur: 1 }]);
        continue;
      }
      const last = h[h.length - 1]!;
      if (last.x === p.x && last.y === p.y) continue;
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) > 1 || tick <= last.t) {
        // 跳格（快照纠正）：不做长距离滑动，直接从新位置开始
        h.length = 0;
        h.push({ t: tick, x: p.x, y: p.y, dur: 1 });
        continue;
      }
      h.push({ t: tick, x: p.x, y: p.y, dur: durBetween(tick, last.t) });
      if (h.length > HISTORY) h.shift();
    }
  }

  history(id: string): readonly Arrival[] {
    return this.hist.get(id) ?? [];
  }
}

export interface PendingInput {
  seq: number;
  tick: number;
  dir?: Dir;
  dash?: true;
}

export interface PredictedStep {
  t: number;
  me: PState;
  /** 这个 tick 自己新染的格子下标 */
  paints: number[];
}

export interface Prediction {
  /** 预测推进到的 tick */
  tick: number;
  me: PState;
  /** base.tick 之后自己新进入的格子 */
  arrivals: Arrival[];
  steps: PredictedStep[];
}

function stateKey(p: Pick<PState, 'x' | 'y' | 'dir' | 'moving' | 'progress' | 'queue' | 'dashLeft'>): string {
  return `${p.x},${p.y},${p.dir},${p.moving ? 1 : 0},${p.progress},${p.queue.join('')},${p.dashLeft}`;
}

/** 管理自己尚未被服务端确认的输入，并负责重演 */
export class Predictor {
  pending: PendingInput[] = [];
  corrections = 0;
  private lastTarget = 0;
  /** 每个 tick 最近一次的预测结果，用来和权威状态比对 */
  private guesses = new Map<number, string>();

  clear(): void {
    this.pending = [];
    this.lastTarget = 0;
    this.guesses.clear();
  }

  /** 选一个目标 tick，并保证同一连接内单调不减（服务端也按单调处理） */
  target(want: number): number {
    const t = Math.max(1, want, this.lastTarget);
    this.lastTarget = t;
    return t;
  }

  add(inp: PendingInput): void {
    this.pending.push(inp);
  }

  /** 收到权威 tick：剔除已确认的输入；若之前对这个 tick 的预测与权威不同，返回 true（发生纠正） */
  onAuthoritative(me: PState, tick: number): boolean {
    if (this.pending.length) this.pending = this.pending.filter((p) => p.seq > me.ack);
    const guess = this.guesses.get(tick);
    let corrected = false;
    if (guess !== undefined && guess !== stateKey(me)) {
      this.corrections++;
      corrected = true;
    }
    for (const t of this.guesses.keys()) if (t <= tick) this.guesses.delete(t);
    return corrected;
  }

  /**
   * 从权威状态 base 出发，只模拟自己（移动不受他人影响），推进到 toTick。
   * 尚未确认、目标 tick 已过的输入（迟到了）放在第一个可模拟的 tick 应用——这正是服务端会做的事。
   */
  run(base: ClientGame, me: PState, toTick: number, lastArrivalT: number): Prediction {
    const end = Math.min(toTick, base.endTick);
    const arrivals: Arrival[] = [];
    const steps: PredictedStep[] = [];
    let state: GameState = {
      w: base.w,
      h: base.h,
      tick: base.tick,
      endTick: base.endTick,
      cells: base.cells,
      players: [{ ...me, queue: me.queue.slice() }],
      scores: base.scores,
    };
    let i = 0;
    let lastT = lastArrivalT;
    for (let t = base.tick + 1; t <= end; t++) {
      const cmds: Cmd[] = [];
      while (i < this.pending.length && cmds.length < MAX_INPUTS_PER_TICK && this.pending[i]!.tick <= t) {
        const p = this.pending[i++]!;
        cmds.push({ dir: p.dir, dash: p.dash });
      }
      const before = state.players[0]!;
      const r = step(state, { [me.id]: { cmds } });
      state = r.state;
      const after = state.players[0]!;
      if (after.x !== before.x || after.y !== before.y) {
        arrivals.push({ t, x: after.x, y: after.y, dur: durBetween(t, lastT) });
        lastT = t;
      }
      const paints: number[] = [];
      for (let k = 0; k + 1 < r.changes.length; k += 2) paints.push(r.changes[k]!);
      steps.push({ t, me: { ...me, ...after, ack: me.ack }, paints });
      this.guesses.set(t, stateKey(after));
    }
    const last = steps[steps.length - 1];
    return { tick: last ? last.t : base.tick, me: last ? last.me : me, arrivals, steps };
  }
}

export interface ClockInfo {
  /** 是否已有至少一次时钟同步 */
  synced: boolean;
  serverNow: number;
  rtt: number;
  /** RTT 抖动（平均绝对偏差） */
  jitter: number;
}

export interface NetFrame {
  /** 用于绘制的棋盘：权威格子 + 自己预测染色的格子；自己的玩家状态替换为预测状态 */
  game: ClientGame;
  pos: Map<string, Vec>;
  /** 本帧预测出的、自己新染的格子（可能重复出现，调用方自行去重） */
  paints: number[];
}

export interface NetStats {
  /** 估计的服务端当前 tick */
  serverTick: number;
  authTick: number;
  /** 其他玩家渲染在权威 tick 之前多少 tick */
  interpBehind: number;
  /** 自己的预测领先权威 tick 多少 tick */
  predictAhead: number;
  pending: number;
  corrections: number;
}

/** 每帧把权威状态变成"要画的样子"。浏览器客户端和单测共用。 */
export class NetView {
  readonly motion = new MotionTracker();
  readonly predictor = new Predictor();
  stats: NetStats = { serverTick: 0, authTick: 0, interpBehind: 0, predictAhead: 0, pending: 0, corrections: 0 };
  /** 最近一帧自己的预测 tick；按键时据此选择目标 tick */
  private lastPredictTick: number | null = null;
  private corrected = false;
  private offset: Vec = { x: 0, y: 0 };
  private lastOwn: Vec | null = null;
  private lastFrameAt = 0;
  private authTick = 0;
  /** 最近一帧预测出的自己（含 dir/冷却），供按键音效等判断 */
  predictedMe: PState | null = null;

  onSnapshot(game: ClientGame): void {
    this.motion.reset(game.players, game.tick);
    this.authTick = game.tick;
    this.corrected = true;
  }

  onTick(game: ClientGame, you: string | null): void {
    this.motion.onTick(game.players, game.tick);
    this.authTick = game.tick;
    const me = you ? game.players.find((p) => p.id === you) : undefined;
    if (me && this.predictor.onAuthoritative(me, game.tick)) this.corrected = true;
  }

  /** 新连接：seq 从 1 重新开始，旧的待确认输入全部作废 */
  resetInputs(): void {
    this.predictor.clear();
    this.lastPredictTick = null;
  }

  /** 为一条新输入选择目标 tick（尚未同步时钟时返回 undefined：由服务端放到下一个 tick） */
  inputTick(): number | undefined {
    if (this.lastPredictTick === null) return undefined;
    return this.predictor.target(Math.max(this.authTick + 1, Math.floor(this.lastPredictTick) + 1));
  }

  frame(game: ClientGame, room: RoomView, you: string | null, clock: ClockInfo, now: number): NetFrame {
    const dt = this.lastFrameAt ? Math.min(100, now - this.lastFrameAt) : 16;
    this.lastFrameAt = now;
    const A = game.tick;
    const live = room.phase === 'countdown' || room.phase === 'playing';

    // 估计服务端此刻的 tick（倒计时阶段为负数）
    let S = A;
    if (clock.synced && room.startsAt !== null && live) S = (clock.serverNow - room.startsAt) / TICK_MS;
    const oneWay = clock.rtt / 2 / TICK_MS;
    const jitterT = clock.jitter / TICK_MS;

    // 其他玩家：插值，最多画到 A+1（之后的数据还没到）
    const R = live ? clamp(S - oneWay - INTERP_TICKS - jitterT, A - MAX_PREDICT_TICKS, A + 1) : A + 1;
    const pos = new Map<string, Vec>();
    for (const p of game.players) {
      if (p.id === you) continue;
      pos.set(p.id, positionAt(this.motion.history(p.id), R) ?? { x: p.x, y: p.y });
    }

    let display = game;
    let paints: number[] = [];
    const me = you ? game.players.find((p) => p.id === you) : undefined;
    let P = A;
    if (me) {
      const hist = this.motion.history(me.id);
      let ownPos: Vec;
      if (live && clock.synced && !me.frozen) {
        P = clamp(S + oneWay + (LEAD_MARGIN_MS + clock.jitter) / TICK_MS, A, A + MAX_PREDICT_TICKS);
        const lastArrival = hist.length ? hist[hist.length - 1]!.t : A;
        // 多推一个 tick：P 落在两个 tick 之间时，下一格的滑动起点也需要知道
        const pred = this.predictor.run(game, me, Math.floor(P) + 1, lastArrival);
        const merged = pred.arrivals.length ? [...hist, ...pred.arrivals] : hist;
        ownPos = positionAt(merged, P) ?? { x: me.x, y: me.y };
        // 状态和染色只取到 floor(P)：画面还没走到的 tick 不提前生效
        const upTo = Math.floor(P);
        let predMe = me;
        for (const st of pred.steps) {
          if (st.t > upTo) break;
          predMe = st.me;
          for (const idx of st.paints) paints.push(idx);
        }
        let cells = game.cells;
        if (paints.length) {
          cells = game.cells.slice();
          for (const idx of paints) cells[idx] = me.slot;
        }
        display = { ...game, cells, players: game.players.map((p) => (p.id === me.id ? predMe : p)) };
        this.predictedMe = predMe;
        this.lastPredictTick = P;
      } else {
        ownPos = positionAt(hist, A + 1) ?? { x: me.x, y: me.y };
        this.predictedMe = me;
        this.lastPredictTick = live && clock.synced ? A : null;
      }
      // 纠正平滑：预测被推翻的那一帧，记下"旧画面位置 − 新位置"的偏移，随后指数衰减
      if (this.corrected && this.lastOwn) {
        const ox = this.lastOwn.x - ownPos.x;
        const oy = this.lastOwn.y - ownPos.y;
        this.offset = Math.abs(ox) + Math.abs(oy) > 3 ? { x: 0, y: 0 } : { x: this.offset.x + ox, y: this.offset.y + oy };
        // 叠加后若超过 3 格，说明是大跳变（快照/重连），直接到位
        if (Math.abs(this.offset.x) + Math.abs(this.offset.y) > 3) this.offset = { x: 0, y: 0 };
      }
      this.corrected = false;
      const decay = Math.exp(-dt / CORRECTION_TAU_MS);
      this.offset = { x: this.offset.x * decay, y: this.offset.y * decay };
      const shownPos = { x: ownPos.x + this.offset.x, y: ownPos.y + this.offset.y };
      this.lastOwn = shownPos;
      pos.set(me.id, shownPos);
    } else {
      this.predictedMe = null;
      this.lastPredictTick = null;
    }

    this.stats = {
      serverTick: S,
      authTick: A,
      interpBehind: Math.max(0, A - R),
      predictAhead: Math.max(0, P - A),
      pending: this.predictor.pending.length,
      corrections: this.predictor.corrections,
    };
    return { game: display, pos, paints };
  }
}
