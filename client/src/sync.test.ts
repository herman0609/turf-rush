import { describe, expect, it } from 'vitest';
import { checksum } from '@turf/shared/game';
import type { RoomView } from '@turf/shared/protocol';
import { ClientSync, type SnapshotMsg, type TickMsg } from './sync';

const room = (rev: number): RoomView => ({
  code: 'ABCDE',
  rev,
  phase: 'playing',
  round: 1,
  hostId: null,
  startsAt: 0,
  endsAt: 0,
  soloEndsAt: null,
  members: [],
  lastResult: null,
});

const snap = (): SnapshotMsg => ({
  t: 'snapshot',
  round: 1,
  tick: 10,
  room: room(5),
  game: {
    w: 4,
    h: 1,
    tick: 10,
    endTick: 100,
    cells: [0, -1, -1, 1],
    players: [],
    scores: [1, 1, 0, 0],
  },
});

const tick = (t: number, cells: number[] = [], extra: Partial<TickMsg> = {}): TickMsg => ({
  t: 'tick',
  round: 1,
  tick: t,
  players: [],
  cells,
  scores: [0, 0, 0, 0],
  ...extra,
});

describe('ClientSync', () => {
  it('按顺序应用增量', () => {
    const s = new ClientSync();
    s.applySnapshot(snap());
    expect(s.applyTick(tick(11, [1, 0]))).toBe('ok');
    expect(s.game!.cells).toEqual([0, 0, -1, 1]);
    expect(s.tick).toBe(11);
  });

  it('丢弃旧的和重复的 tick', () => {
    const s = new ClientSync();
    s.applySnapshot(snap());
    expect(s.applyTick(tick(10, [1, 0]))).toBe('stale');
    s.applyTick(tick(11));
    expect(s.applyTick(tick(11, [2, 1]))).toBe('stale');
    expect(s.game!.cells[2]).toBe(-1);
    expect(s.stats.staleTicks).toBe(2);
  });

  it('乱序：稍微超前的 tick 先暂存，缺的那条到了再按顺序应用（每个 tick 都回调一次）', () => {
    const s = new ClientSync();
    const applied: number[] = [];
    s.onApplied = (g) => applied.push(g.tick);
    s.applySnapshot(snap());
    expect(s.applyTick(tick(13, [2, 1]))).toBe('buffered');
    expect(s.applyTick(tick(12, [1, 1]))).toBe('buffered');
    expect(s.game!.cells).toEqual([0, -1, -1, 1]); // 还没应用
    expect(s.applyTick(tick(12))).toBe('stale'); // 暂存区里的重复消息
    expect(s.applyTick(tick(11, [1, 0]))).toBe('ok');
    expect(applied).toEqual([11, 12, 13]);
    expect(s.tick).toBe(13);
    expect(s.game!.cells).toEqual([0, 1, 1, 1]); // 12 覆盖了 11 对格子 1 的修改
    expect(s.stats.reordered).toBe(2);
    expect(s.stats.gaps).toBe(0);
  });

  it('超出重排窗口：报告 gap 并清空暂存；快照之后正常衔接', () => {
    const s = new ClientSync();
    s.applySnapshot(snap());
    expect(s.applyTick(tick(30))).toBe('gap');
    for (const t of [12, 13, 14, 15]) expect(s.applyTick(tick(t))).toBe('buffered');
    expect(s.applyTick(tick(16))).toBe('gap'); // 期望 11，窗口只到 15
    // 快照到 tick 11 之后，新到的 12 起正常衔接
    s.applySnapshot({ ...snap(), tick: 11, game: { ...snap().game!, tick: 11 } });
    expect(s.applyTick(tick(13))).toBe('buffered');
    expect(s.applyTick(tick(12))).toBe('ok');
    expect(s.tick).toBe(13);
  });

  it('上一局的 tick 一律视为旧消息', () => {
    const s = new ClientSync();
    s.applySnapshot({ ...snap(), round: 2, tick: 0 });
    expect(s.applyTick({ ...tick(500), round: 1 })).toBe('stale');
    expect(s.applyTick({ ...tick(1), round: 2 })).toBe('ok');
  });

  it('校验和不一致时报告 mismatch', () => {
    const s = new ClientSync();
    s.applySnapshot(snap());
    const good = checksum([0, 0, -1, 1], []);
    expect(s.applyTick(tick(11, [1, 0], { sum: good }))).toBe('ok');
    expect(s.applyTick(tick(12, [], { sum: good + 1 }))).toBe('mismatch');
  });

  it('丢弃旧版本的房间消息', () => {
    const s = new ClientSync();
    s.applySnapshot(snap());
    expect(s.applyRoom({ t: 'room', room: room(5) })).toBe(false);
    expect(s.applyRoom({ t: 'room', room: room(6) })).toBe(true);
    expect(s.applyRoom({ t: 'room', room: room(4) })).toBe(false);
  });
});
