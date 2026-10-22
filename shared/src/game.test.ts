import { describe, expect, it } from 'vitest';
import {
  DASH_COOLDOWN_TICKS,
  DASH_TICKS,
  GRID_H,
  GRID_W,
  MOVE_UNITS,
  SPEED_NORMAL,
} from './constants';
import {
  checksum,
  createGame,
  isOver,
  rankPlayers,
  recount,
  step,
  type GameState,
  type TickInput,
} from './game';

const two = () =>
  createGame({
    players: [
      { id: 'a', slot: 0 },
      { id: 'b', slot: 1 },
    ],
    endTick: 1200,
  });

function run(state: GameState, ticks: number, inputsAt: Record<number, Record<string, TickInput>> = {}) {
  let s = state;
  for (let i = 0; i < ticks; i++) s = step(s, inputsAt[s.tick + 1] ?? {}).state;
  return s;
}

const ticksPerCell = MOVE_UNITS / SPEED_NORMAL;

describe('createGame', () => {
  it('2 人局使用对角出生点并涂上出生格', () => {
    const g = two();
    expect(g.players.map((p) => [p.x, p.y, p.dir])).toEqual([
      [1, 1, 'R'],
      [GRID_W - 2, GRID_H - 2, 'L'],
    ]);
    expect(g.scores.slice(0, 2)).toEqual([1, 1]);
    expect(g.cells[1 * GRID_W + 1]).toBe(0);
  });

  it('按 slot 排序，与传入顺序无关', () => {
    const g = createGame({ players: [{ id: 'b', slot: 2 }, { id: 'a', slot: 0 }], endTick: 10 });
    expect(g.players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('step：移动', () => {
  it('第 1 个 tick 迈出第一步，之后常速每 3 tick 一格', () => {
    let s = step(two(), {}).state;
    expect(s.players[0]!.x).toBe(2);
    s = run(s, ticksPerCell - 1);
    expect(s.players[0]!.x).toBe(2);
    s = run(s, 1);
    expect(s.players[0]!.x).toBe(3);
  });

  it('不修改输入的旧状态（纯函数）', () => {
    const g = two();
    const before = JSON.stringify(g);
    step(g, { a: { cmds: [{ dir: 'D' }, { dash: true }] } });
    expect(JSON.stringify(g)).toBe(before);
  });

  it('转向在下一次前进时生效', () => {
    let s = step(two(), {}).state; // a 到 (2,1)
    s = step(s, { a: { cmds: [{ dir: 'D' }] } }).state;
    expect([s.players[0]!.x, s.players[0]!.y]).toEqual([2, 1]);
    s = run(s, ticksPerCell - 1);
    expect([s.players[0]!.x, s.players[0]!.y, s.players[0]!.dir]).toEqual([2, 2, 'D']);
  });

  it('转向缓冲最多 2 个，并对连续同向去重', () => {
    const s = step(two(), { a: { cmds: [{ dir: 'R' }, { dir: 'D' }, { dir: 'D' }, { dir: 'L' }, { dir: 'U' }] } }).state;
    // 第 1 个 tick 迈步时已消费掉第一个转向 D
    expect(s.players[0]!.dir).toBe('D');
    expect(s.players[0]!.queue).toEqual(['L']);
  });

  it('撞墙停住，给出可走方向后立即继续', () => {
    // a 从 (1,1) 朝上：1 格后到 y=0，再走就撞墙
    let s = createGame({ players: [{ id: 'a', slot: 0 }], endTick: 100 });
    s = step(s, { a: { cmds: [{ dir: 'U' }] } }).state; // 第 1 步向上 → (1,0)
    expect([s.players[0]!.x, s.players[0]!.y]).toEqual([1, 0]);
    s = run(s, ticksPerCell * 2);
    expect(s.players[0]!.moving).toBe(false);
    expect([s.players[0]!.x, s.players[0]!.y]).toEqual([1, 0]);
    // 朝墙外的方向无效
    s = step(s, { a: { cmds: [{ dir: 'U' }] } }).state;
    expect(s.players[0]!.moving).toBe(false);
    // 可走方向：本 tick 立即迈步
    s = step(s, { a: { cmds: [{ dir: 'L' }] } }).state;
    expect([s.players[0]!.x, s.players[0]!.y, s.players[0]!.moving]).toEqual([0, 0, true]);
  });

  it('允许 180° 掉头', () => {
    let s = step(two(), {}).state; // (2,1) 朝右
    s = step(s, { a: { cmds: [{ dir: 'L' }] } }).state;
    s = run(s, ticksPerCell - 1);
    expect([s.players[0]!.x, s.players[0]!.dir]).toEqual([1, 'L']);
  });

  it('frozen 的玩家原地不动、忽略输入', () => {
    let s = two();
    s = step(s, { a: { frozen: true, cmds: [{ dir: 'D' }] } }).state;
    s = run(s, 10);
    expect([s.players[0]!.x, s.players[0]!.y]).toEqual([1, 1]);
    s = step(s, { a: { frozen: false } }).state;
    s = run(s, ticksPerCell);
    expect(s.players[0]!.x).toBeGreaterThan(1);
  });
});

describe('step：冲刺', () => {
  it('冲刺期间每 tick 一格，持续 DASH_TICKS', () => {
    let s = step(two(), {}).state; // x=2
    s = step(s, { a: { cmds: [{ dash: true }] } }).state;
    const x0 = s.players[0]!.x;
    s = run(s, DASH_TICKS - 1);
    expect(s.players[0]!.x - x0).toBe(DASH_TICKS - 1);
    expect(s.players[0]!.dashLeft).toBe(0);
  });

  it('冷却期间再次冲刺无效，冷却结束后可用', () => {
    // 宽地图，避免冷却期间跑到墙边停住
    let s = createGame({ players: [{ id: 'a', slot: 0 }], endTick: 1000, w: 300, h: 5 });
    s = step(s, { a: { cmds: [{ dash: true }] } }).state;
    expect(s.players[0]!.cdLeft).toBe(DASH_COOLDOWN_TICKS - 1);
    s = run(s, DASH_TICKS);
    s = step(s, { a: { cmds: [{ dash: true }] } }).state;
    expect(s.players[0]!.dashLeft).toBe(0);
    s = run(s, DASH_COOLDOWN_TICKS);
    s = step(s, { a: { cmds: [{ dash: true }] } }).state;
    expect(s.players[0]!.dashLeft).toBe(DASH_TICKS - 1);
  });

  it('停住时不能冲刺（避免白白进入冷却）', () => {
    let s = createGame({ players: [{ id: 'a', slot: 0 }], endTick: 100 });
    s = step(s, { a: { cmds: [{ dir: 'U' }] } }).state;
    s = run(s, ticksPerCell * 2);
    expect(s.players[0]!.moving).toBe(false);
    s = step(s, { a: { cmds: [{ dash: true }] } }).state;
    expect(s.players[0]!.cdLeft).toBe(0);
  });
});

describe('step：染色与分数', () => {
  it('覆盖他人格子时双方分数同步变化，changes 只含变化的格子', () => {
    const g = createGame({ players: [{ id: 'a', slot: 0 }, { id: 'b', slot: 1 }], endTick: 100, w: 6, h: 3 });
    // 手工把 a 前方的格子涂成 b 的
    g.cells[1 * 6 + 2] = 1;
    g.scores[1] = 2;
    const { state, changes } = step(g, {});
    expect(changes).toContain(1 * 6 + 2);
    expect(state.cells[1 * 6 + 2]).toBe(0);
    expect(state.scores[0]).toBe(2);
    // b 原有 2 格：被 a 覆盖 1 格（-1），自己向左走到 (3,1)（+1）
    expect(state.scores[1]).toBe(2);
    expect(state.scores).toEqual(recount(state.cells));
  });

  it('长时间随机对局中，增量分数始终等于重新计数', () => {
    let s = createGame({
      players: [
        { id: 'a', slot: 0 },
        { id: 'b', slot: 1 },
        { id: 'c', slot: 2 },
        { id: 'd', slot: 3 },
      ],
      endTick: 1200,
    });
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const dirs = ['U', 'D', 'L', 'R'] as const;
    while (!isOver(s)) {
      const inputs: Record<string, TickInput> = {};
      for (const id of ['a', 'b', 'c', 'd']) {
        if (rand() < 0.1) inputs[id] = { cmds: [{ dir: dirs[Math.floor(rand() * 4)]! }] };
        if (rand() < 0.02) inputs[id] = { cmds: [{ dash: true }] };
      }
      s = step(s, inputs).state;
      expect(s.scores).toEqual(recount(s.cells));
    }
    expect(s.tick).toBe(1200);
  });
});

describe('确定性', () => {
  it('相同输入序列得到逐字节相同的状态与校验和', () => {
    const script: Record<number, Record<string, TickInput>> = {
      3: { a: { cmds: [{ dir: 'D' }] }, b: { cmds: [{ dash: true }] } },
      10: { a: { cmds: [{ dash: true }] } },
      25: { b: { cmds: [{ dir: 'U' }, { dir: 'R' }] } },
      40: { a: { cmds: [{ dir: 'L' }] } },
    };
    const s1 = run(two(), 200, script);
    const s2 = run(two(), 200, script);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
    expect(checksum(s1.cells, s1.players)).toBe(checksum(s2.cells, s2.players));
  });

  it('校验和对单格变化敏感', () => {
    const g = two();
    const a = checksum(g.cells, g.players);
    const cells = g.cells.slice();
    cells[100] = 1;
    expect(checksum(cells, g.players)).not.toBe(a);
  });
});

describe('rankPlayers', () => {
  const meta = [
    { id: 'a', slot: 0, name: 'A', left: false },
    { id: 'b', slot: 1, name: 'B', left: false },
    { id: 'c', slot: 2, name: 'C', left: false },
  ];

  it('最高分者获胜', () => {
    const r = rankPlayers([10, 30, 20, 0], meta);
    expect(r.ranking.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(r.winners).toEqual(['b']);
  });

  it('并列最高分为平局', () => {
    expect(rankPlayers([30, 30, 20, 0], meta).winners).toEqual(['a', 'b']);
  });

  it('已离开的玩家不参与胜负，但仍在榜上', () => {
    const r = rankPlayers([10, 30, 20, 0], meta.map((m) => (m.id === 'b' ? { ...m, left: true } : m)));
    expect(r.ranking[0]!.id).toBe('b');
    expect(r.winners).toEqual(['c']);
  });
});
