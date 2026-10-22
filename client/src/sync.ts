// 客户端同步核心：只负责"把服务端下发的消息正确地拼成当前权威状态"。
// 不依赖 DOM，浏览器客户端和回归脚本里的机器人共用这一份代码。

import { checksum } from '@turf/shared/game';
import type { GameView, PState, RoomView, S2C } from '@turf/shared/protocol';

export type TickMsg = Extract<S2C, { t: 'tick' }>;
export type SnapshotMsg = Extract<S2C, { t: 'snapshot' }>;
export type RoomMsg = Extract<S2C, { t: 'room' }>;

export interface ClientGame {
  w: number;
  h: number;
  tick: number;
  endTick: number;
  cells: number[];
  players: PState[];
  scores: number[];
}

export type TickOutcome = 'ok' | 'stale' | 'gap' | 'mismatch' | 'buffered';

/**
 * 乱序重排窗口：比期望超前、但不超过这么多的 tick 先暂存，等缺的那条到了再按顺序应用。
 * WebSocket 跑在 TCP 上本身不会乱序；这层是为代理/中间层/?chaos 模拟兜底，窗口内补不齐才请求快照。
 */
export const REORDER_WINDOW = 4;

export interface SyncStats {
  snapshots: number;
  ticks: number;
  staleTicks: number;
  staleRooms: number;
  gaps: number;
  mismatches: number;
  /** 先到后用：从重排缓冲里按顺序补上的 tick 数 */
  reordered: number;
}

export class ClientSync {
  round = -1;
  tick = -1;
  rev = -1;
  room: RoomView | null = null;
  game: ClientGame | null = null;
  stats: SyncStats = { snapshots: 0, ticks: 0, staleTicks: 0, staleRooms: 0, gaps: 0, mismatches: 0, reordered: 0 };
  /** 每应用一个 tick（包括从重排缓冲补上的）调用一次 */
  onApplied: ((game: ClientGame, round: number) => void) | null = null;
  private early = new Map<number, TickMsg>();

  applySnapshot(m: SnapshotMsg): void {
    this.round = m.round;
    this.tick = m.tick;
    this.room = m.room;
    this.rev = m.room.rev;
    this.game = m.game ? cloneGame(m.game) : null;
    this.stats.snapshots++;
    // 快照之后的暂存 tick 仍然有效：丢掉旧的，接得上的继续应用
    for (const [t, msg] of this.early) if (msg.round !== m.round || t <= m.tick) this.early.delete(t);
    if (this.game) this.drain();
  }

  /** 返回 false 表示是旧版本，已丢弃 */
  applyRoom(m: RoomMsg): boolean {
    if (m.room.rev <= this.rev) {
      this.stats.staleRooms++;
      return false;
    }
    this.room = m.room;
    this.rev = m.room.rev;
    return true;
  }

  /**
   * 应用一条增量。按 (round, tick) 判断新旧：
   * - 旧的或重复的：丢弃（stale）
   * - 稍微超前（缺了中间几条）：暂存，等补齐后按顺序应用（buffered）
   * - 超前太多 / 跨局 / 暂存已满：不应用，调用方应请求全量快照（gap）
   * - 校验和不一致：已应用，但调用方应请求全量快照（mismatch）
   */
  applyTick(m: TickMsg): TickOutcome {
    if (m.round < this.round || (m.round === this.round && m.tick <= this.tick) || this.early.has(m.tick)) {
      this.stats.staleTicks++;
      return 'stale';
    }
    if (!this.game || m.round !== this.round) {
      this.stats.gaps++;
      return 'gap';
    }
    if (m.tick > this.tick + 1) {
      if (m.tick <= this.tick + 1 + REORDER_WINDOW && this.early.size < REORDER_WINDOW) {
        this.early.set(m.tick, m);
        return 'buffered';
      }
      this.early.clear();
      this.stats.gaps++;
      return 'gap';
    }
    let out = this.applyOne(m);
    if (this.drain()) out = 'mismatch';
    return out;
  }

  /** 把暂存区里接得上的 tick 依次应用；返回途中是否出现校验和不一致 */
  private drain(): boolean {
    let bad = false;
    for (let next = this.early.get(this.tick + 1); next; next = this.early.get(this.tick + 1)) {
      this.early.delete(next.tick);
      this.stats.reordered++;
      if (this.applyOne(next) === 'mismatch') bad = true;
    }
    return bad;
  }

  private applyOne(m: TickMsg): 'ok' | 'mismatch' {
    const g = this.game!;
    for (let i = 0; i + 1 < m.cells.length; i += 2) g.cells[m.cells[i]!] = m.cells[i + 1]!;
    g.players = m.players;
    g.scores = m.scores;
    g.tick = m.tick;
    this.tick = m.tick;
    this.stats.ticks++;
    const bad = m.sum !== undefined && checksum(g.cells, g.players) !== m.sum;
    if (bad) this.stats.mismatches++;
    this.onApplied?.(g, this.round);
    return bad ? 'mismatch' : 'ok';
  }

  /** 本地重建状态的校验和，用于与服务端终局校验和比对 */
  localChecksum(): number | null {
    return this.game ? checksum(this.game.cells, this.game.players) : null;
  }
}

function cloneGame(g: GameView): ClientGame {
  return {
    w: g.w,
    h: g.h,
    tick: g.tick,
    endTick: g.endTick,
    cells: g.cells.slice(),
    players: g.players.map((p) => ({ ...p })),
    scores: g.scores.slice(),
  };
}
