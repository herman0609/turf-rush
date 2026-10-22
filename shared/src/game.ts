// 规则引擎：纯函数、确定性、只用整数。
// 服务端用它推进权威模拟，客户端（M4）用它做本地预测，测试直接调用它。
// 约束：不读时间、不用随机数；玩家按 slot 顺序处理，结果与输入到达顺序无关。

import {
  DASH_COOLDOWN_TICKS,
  DASH_TICKS,
  DX,
  DY,
  GRID_H,
  GRID_W,
  MAX_PLAYERS,
  MOVE_UNITS,
  SPAWNS,
  SPEED_DASH,
  SPEED_NORMAL,
  TURN_QUEUE_MAX,
  type Dir,
} from './constants';

export interface Cmd {
  dir?: Dir;
  dash?: boolean;
}

export interface PlayerState {
  id: string;
  slot: number;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  /** 距离下一次前进累计的单位数，0 ≤ progress < MOVE_UNITS */
  progress: number;
  /** 等待在下一次前进时生效的转向 */
  queue: Dir[];
  dashLeft: number;
  cdLeft: number;
  /** 离线或已离开：原地停住、不响应输入 */
  frozen: boolean;
}

export interface GameState {
  w: number;
  h: number;
  tick: number;
  endTick: number;
  /** 每格的 owner slot，空格为 -1 */
  cells: number[];
  players: PlayerState[];
  /** 下标为 slot 的占格数 */
  scores: number[];
}

export interface TickInput {
  cmds?: readonly Cmd[];
  frozen?: boolean;
}

export interface StepResult {
  state: GameState;
  /** 本 tick 变化的格子，扁平数组 [idx, owner, idx, owner, ...]，按发生顺序 */
  changes: number[];
}

export interface CreateGameOptions {
  players: readonly { id: string; slot: number }[];
  endTick: number;
  w?: number;
  h?: number;
}

export function createGame(opts: CreateGameOptions): GameState {
  const w = opts.w ?? GRID_W;
  const h = opts.h ?? GRID_H;
  if (opts.players.length > MAX_PLAYERS) throw new Error('too many players');
  const cells = new Array<number>(w * h).fill(-1);
  const scores = new Array<number>(MAX_PLAYERS).fill(0);
  const sorted = [...opts.players].sort((a, b) => a.slot - b.slot);
  const players: PlayerState[] = sorted.map((p, i) => {
    const sp = SPAWNS[i]!;
    // 出生点按地图尺寸换算，便于测试用小地图
    const x = sp.x >= GRID_W / 2 ? w - (GRID_W - sp.x) : sp.x;
    const y = sp.y >= GRID_H / 2 ? h - (GRID_H - sp.y) : sp.y;
    cells[y * w + x] = p.slot;
    scores[p.slot]! += 1;
    return {
      id: p.id,
      slot: p.slot,
      x,
      y,
      dir: sp.dir,
      moving: true,
      // 让第 1 个 tick 就迈出第一步
      progress: MOVE_UNITS - SPEED_NORMAL,
      queue: [],
      dashLeft: 0,
      cdLeft: 0,
      frozen: false,
    };
  });
  return { w, h, tick: 0, endTick: opts.endTick, cells, players, scores };
}

function inBounds(state: { w: number; h: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.w && y < state.h;
}

function applyCmd(state: GameState, p: PlayerState, c: Cmd): void {
  if (c.dir) {
    if (!p.moving) {
      // 停在墙边：只有能走出去的方向才生效，并且本 tick 立即迈步
      if (inBounds(state, p.x + DX[c.dir], p.y + DY[c.dir])) {
        p.dir = c.dir;
        p.moving = true;
        p.queue = [];
        p.progress = MOVE_UNITS - SPEED_NORMAL;
      }
    } else {
      const last = p.queue.length > 0 ? p.queue[p.queue.length - 1]! : p.dir;
      if (c.dir !== last && p.queue.length < TURN_QUEUE_MAX) p.queue.push(c.dir);
    }
  }
  if (c.dash && p.moving && p.dashLeft === 0 && p.cdLeft === 0) {
    p.dashLeft = DASH_TICKS;
    p.cdLeft = DASH_COOLDOWN_TICKS;
  }
}

export function step(prev: GameState, inputs: Readonly<Record<string, TickInput>>): StepResult {
  const cells = prev.cells.slice();
  const scores = prev.scores.slice();
  const players = prev.players.map((p) => ({ ...p, queue: p.queue.slice() }));
  const state: GameState = { ...prev, tick: prev.tick + 1, cells, scores, players };
  const changes: number[] = [];

  for (const p of players) {
    const inp = inputs[p.id];
    if (inp?.frozen !== undefined) p.frozen = inp.frozen;
    if (p.frozen) {
      p.dashLeft = 0;
      p.queue = [];
      if (p.cdLeft > 0) p.cdLeft -= 1;
      continue;
    }
    for (const c of inp?.cmds ?? []) applyCmd(state, p, c);

    if (p.moving) {
      p.progress += p.dashLeft > 0 ? SPEED_DASH : SPEED_NORMAL;
      if (p.progress >= MOVE_UNITS) {
        p.progress -= MOVE_UNITS;
        const turn = p.queue.shift();
        if (turn) p.dir = turn;
        const nx = p.x + DX[p.dir];
        const ny = p.y + DY[p.dir];
        if (inBounds(state, nx, ny)) {
          p.x = nx;
          p.y = ny;
          const idx = ny * state.w + nx;
          const old = cells[idx]!;
          if (old !== p.slot) {
            if (old >= 0) scores[old]! -= 1;
            cells[idx] = p.slot;
            scores[p.slot]! += 1;
            changes.push(idx, p.slot);
          }
        } else {
          // 撞墙：停住，等待新的方向
          p.moving = false;
          p.progress = 0;
          p.queue = [];
        }
      }
    }
    if (p.dashLeft > 0) p.dashLeft -= 1;
    if (p.cdLeft > 0) p.cdLeft -= 1;
  }
  return { state, changes };
}

export function isOver(state: GameState): boolean {
  return state.tick >= state.endTick;
}

/** 从格子重新数一遍分数，用于测试增量分数的正确性 */
export function recount(cells: readonly number[]): number[] {
  const s = new Array<number>(MAX_PLAYERS).fill(0);
  for (const c of cells) if (c >= 0) s[c]! += 1;
  return s;
}

export interface RankMeta {
  id: string;
  slot: number;
  name: string;
  left: boolean;
}

export interface RankEntry extends RankMeta {
  score: number;
}

/**
 * 排名：分数从高到低，同分按 slot。已离开的玩家照常列出，但不参与胜负。
 * winners 为未离开玩家中的最高分者（可能多人 = 平局）。
 */
export function rankPlayers(
  scores: readonly number[],
  meta: readonly RankMeta[],
): { ranking: RankEntry[]; winners: string[] } {
  const ranking = meta
    .map((m) => ({ ...m, score: scores[m.slot] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.slot - b.slot);
  const eligible = ranking.filter((r) => !r.left);
  if (eligible.length === 0) return { ranking, winners: [] };
  const best = Math.max(...eligible.map((r) => r.score));
  return { ranking, winners: eligible.filter((r) => r.score === best).map((r) => r.id) };
}

const DIR_CODE: Record<Dir, number> = { U: 1, D: 2, L: 3, R: 4 };

/** FNV-1a 32 位，覆盖全部格子与玩家位置/朝向。两端用同一函数比对状态是否一致。 */
export function checksum(
  cells: readonly number[],
  players: readonly { x: number; y: number; dir: Dir }[],
): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const c of cells) mix(c + 1);
  for (const p of players) {
    mix(p.x);
    mix(p.y);
    mix(DIR_CODE[p.dir]);
  }
  return h >>> 0;
}
