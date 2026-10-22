import { describe, expect, it } from 'vitest';
import { createGame, step, type GameState } from '@turf/shared/game';
import type { PState } from '@turf/shared/protocol';
import { MotionTracker, Predictor, positionAt, type Arrival } from './motion';
import type { ClientGame } from './sync';

const toP = (p: GameState['players'][number], ack = 0): PState => ({ ...p, queue: p.queue.slice(), ack });
const toClient = (g: GameState, ack = 0): ClientGame => ({
  w: g.w,
  h: g.h,
  tick: g.tick,
  endTick: g.endTick,
  cells: g.cells.slice(),
  players: g.players.map((p) => toP(p, ack)),
  scores: g.scores.slice(),
});

/** 按 0.05 tick 采样，返回相邻采样点的最大位移 */
function maxJump(hist: Arrival[], from: number, to: number): number {
  let prev = positionAt(hist, from)!;
  let max = 0;
  for (let t = from; t <= to; t += 0.05) {
    const p = positionAt(hist, t)!;
    max = Math.max(max, Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y));
    prev = p;
  }
  return max;
}

describe('positionAt：按 tick 时间的连续位置', () => {
  it('常速：每 3 tick 一格，匀速滑动', () => {
    const hist: Arrival[] = [
      { t: 0, x: 0, y: 0, dur: 1 },
      { t: 3, x: 1, y: 0, dur: 3 },
      { t: 6, x: 2, y: 0, dur: 3 },
    ];
    expect(positionAt(hist, 0)).toEqual({ x: 0, y: 0 });
    expect(positionAt(hist, 4.5)!.x).toBeCloseTo(0.5);
    expect(positionAt(hist, 7.5)!.x).toBeCloseTo(1.5);
    expect(positionAt(hist, 100)).toEqual({ x: 2, y: 0 });
  });

  it('冲刺开始（间隔 3 → 1）与转向时都不跳变', () => {
    const hist: Arrival[] = [
      { t: 0, x: 0, y: 0, dur: 1 },
      { t: 3, x: 1, y: 0, dur: 3 },
      { t: 4, x: 2, y: 0, dur: 1 }, // 冲刺：上一段只滑了 1/3 就进入下一格
      { t: 5, x: 3, y: 0, dur: 1 },
      { t: 6, x: 3, y: 1, dur: 1 }, // 转向
      { t: 9, x: 3, y: 2, dur: 3 },
    ];
    // 0.05 tick 内最多移动 ~0.09 格（冲刺开始时从 1/3 处追到下一格）
    expect(maxJump(hist, 0, 12)).toBeLessThan(0.12);
    expect(positionAt(hist, 12)).toEqual({ x: 3, y: 2 });
  });
});

describe('MotionTracker', () => {
  it('记录到达时刻，滑动时长取两次到达的间隔（1~3）；跳格时重置', () => {
    const mt = new MotionTracker();
    const p = (x: number, y: number) => ({ id: 'a', x, y }) as PState;
    mt.reset([p(0, 0)], 0);
    mt.onTick([p(0, 0)], 1);
    mt.onTick([p(1, 0)], 3);
    mt.onTick([p(2, 0)], 4);
    mt.onTick([p(3, 0)], 20);
    expect(mt.history('a').map((a) => [a.t, a.dur])).toEqual([
      [0, 1],
      [3, 3],
      [4, 1],
      [20, 3],
    ]);
    mt.onTick([p(10, 10)], 21);
    expect(mt.history('a')).toEqual([{ t: 21, x: 10, y: 10, dur: 1 }]);
  });
});

describe('Predictor：用 shared step 重演自己', () => {
  function serverRun(g0: GameState, until: number, inputs: Map<number, { dir?: 'U' | 'D' | 'L' | 'R'; dash?: boolean }[]>) {
    const states = new Map<number, GameState>([[g0.tick, g0]]);
    let g = g0;
    while (g.tick < until) {
      const t = g.tick + 1;
      g = step(g, { a: { cmds: inputs.get(t) ?? [] } }).state;
      states.set(t, g);
    }
    return states;
  }

  it('输入按目标 tick 应用时，预测与服务端逐 tick 一致，不产生纠正', () => {
    const g0 = createGame({ players: [{ id: 'a', slot: 0 }], endTick: 200, w: 20, h: 12 });
    type C = { dir?: 'U' | 'D' | 'L' | 'R'; dash?: boolean };
    const inputs = new Map<number, C[]>([
      [5, [{ dir: 'D' }]],
      [9, [{ dash: true }]],
      [14, [{ dir: 'R' }, { dir: 'U' }]],
    ]);
    const server = serverRun(g0, 40, inputs);
    const pred = new Predictor();
    let seq = 0;
    for (const [t, cmds] of inputs) for (const c of cmds) pred.add({ seq: ++seq, tick: t, ...c, dash: c.dash ? true : undefined });

    // 客户端只知道 tick 3 的权威状态，一口气预测到 30
    const base = toClient(server.get(3)!);
    const r = pred.run(base, base.players[0]!, 30, 0);
    for (const st of r.steps) {
      const sp = server.get(st.t)!.players[0]!;
      expect([st.me.x, st.me.y, st.me.dir, st.me.dashLeft, st.me.progress]).toEqual([sp.x, sp.y, sp.dir, sp.dashLeft, sp.progress]);
    }
    // 预测出的染色 = 服务端在这些 tick 里新染的格子
    const sCells = server.get(30)!.cells;
    for (const st of r.steps) for (const idx of st.paints) expect(sCells[idx]).toBe(0);

    // 权威状态陆续到达：全部命中，确认后的输入被剔除
    for (let t = 4; t <= 30; t++) {
      const acked = [...inputs.keys()].filter((k) => k <= t).reduce((n, k) => n + inputs.get(k)!.length, 0);
      expect(pred.onAuthoritative(toP(server.get(t)!.players[0]!, acked), t)).toBe(false);
    }
    expect(pred.corrections).toBe(0);
    expect(pred.pending).toHaveLength(0);
  });

  it('服务端晚一个 tick 才应用（输入迟到）时计一次纠正', () => {
    const g0 = createGame({ players: [{ id: 'a', slot: 0 }], endTick: 200, w: 20, h: 12 });
    const pred = new Predictor();
    pred.add({ seq: 1, tick: 4, dir: 'D' });
    const base = toClient(g0);
    pred.run(base, base.players[0]!, 10, 0);
    // 服务端实际在 tick 6 才应用（第 4、5 tick 还在直行）
    const server = serverRun(g0, 10, new Map([[6, [{ dir: 'D' as const }]]]));
    let corrected = false;
    for (let t = 1; t <= 10; t++) corrected = pred.onAuthoritative(toP(server.get(t)!.players[0]!, t >= 6 ? 1 : 0), t) || corrected;
    expect(corrected).toBe(true);
    expect(pred.corrections).toBeGreaterThan(0);
  });

  it('目标 tick 单调不减', () => {
    const pred = new Predictor();
    expect(pred.target(10)).toBe(10);
    expect(pred.target(8)).toBe(10);
    expect(pred.target(12)).toBe(12);
    pred.clear();
    expect(pred.target(0)).toBe(1);
  });
});
