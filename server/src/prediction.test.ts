// 端到端：真实的服务端 Room + 双向模拟延迟 + 客户端 ClientSync/NetView。
// 验证"输入预约目标 tick + 本地重演"在 200ms RTT 下与服务端完全一致（零纠正），且画面不跳变。

import { beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type Dir } from '@turf/shared/constants';
import type { C2S, S2C } from '@turf/shared/protocol';
import { NetView, type Vec } from '../../client/src/motion';
import { ClientSync } from '../../client/src/sync';
import { silentLogger } from './log';
import { Room, type Link, type Member } from './room';

let now = 1_000_000;

/** 按到达时间排队的单向管道（保序） */
class Pipe<T> {
  private q: { at: number; v: T }[] = [];
  constructor(private readonly delay: () => number) {}
  push(v: T): void {
    const last = this.q.length ? this.q[this.q.length - 1]!.at : 0;
    this.q.push({ at: Math.max(last, now + this.delay()), v });
  }
  drain(fn: (v: T) => void): void {
    while (this.q.length && this.q[0]!.at <= now) fn(this.q.shift()!.v);
  }
}

class DelayedLink implements Link {
  stats = { dropped: 0 };
  constructor(private readonly down: Pipe<S2C>) {}
  send(data: string) {
    this.down.push(JSON.parse(data) as S2C);
  }
  close() {}
  congested() {
    return false;
  }
}

interface Client {
  sync: ClientSync;
  net: NetView;
  m: Member;
  you: string;
  up: Pipe<C2S>;
  down: Pipe<S2C>;
  seq: number;
  oneWay: number;
}

function makeClient(room: Room, name: string, oneWay: number): Client {
  const down = new Pipe<S2C>(() => oneWay);
  const up = new Pipe<C2S>(() => oneWay);
  const link = new DelayedLink(down);
  const m = room.join(link, { t: 'join', v: PROTOCOL_VERSION, code: room.code, name }, now)!;
  return { sync: new ClientSync(), net: new NetView(), m, you: m.id, up, down, seq: 0, oneWay };
}

function pump(room: Room, c: Client): void {
  c.up.drain((msg) => room.handle(c.m, msg, now));
  c.down.drain((msg) => {
    if (msg.t === 'snapshot') {
      c.sync.applySnapshot(msg);
      if (c.sync.game) c.net.onSnapshot(c.sync.game);
    } else if (msg.t === 'room') c.sync.applyRoom(msg);
    else if (msg.t === 'tick') {
      const r = c.sync.applyTick(msg);
      expect(r).toBe('ok');
      c.net.onTick(c.sync.game!, c.you);
    }
  });
}

function frame(c: Client): Vec | null {
  const { room, game } = c.sync;
  if (!room || !game) return null;
  const clock = { synced: true, serverNow: now, rtt: c.oneWay * 2, jitter: 0 };
  return c.net.frame(game, room, c.you, clock, now).pos.get(c.you) ?? null;
}

function press(c: Client, cmd: { dir?: Dir; dash?: true }, lateBy = 0): void {
  const tick = c.net.inputTick();
  const t = tick === undefined ? undefined : tick - lateBy;
  const seq = ++c.seq;
  c.up.push({ t: 'input', seq, tick: t, ...cmd });
  c.net.predictor.add({ seq, tick: t ?? c.sync.tick + 1, ...cmd });
}

function playMatch(oneWay: number, seconds: number, lateBy = 0) {
  const room = new Room({ code: 'ABCDE', matchTicks: 400, log: silentLogger, now });
  const a = makeClient(room, 'A', oneWay);
  const b = makeClient(room, 'B', 30);
  room.handle(b.m, { t: 'ready', ready: true }, now);
  room.handle(a.m, { t: 'start' }, now);

  let s = 12345;
  const rand = () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const dirs: Dir[] = ['U', 'D', 'L', 'R'];
  let maxStep = 0;
  let prev: Vec | null = null;
  let presses = 0;
  const end = now + seconds * 1000;
  // 10ms 一帧：服务端主循环、双向管道、客户端渲染帧都按同一个假时钟推进
  while (now < end) {
    now += 10;
    room.update(now);
    pump(room, a);
    pump(room, b);
    const pos = frame(a);
    frame(b);
    if (room.phase === 'playing') {
      if (pos && prev) maxStep = Math.max(maxStep, Math.abs(pos.x - prev.x) + Math.abs(pos.y - prev.y));
      if (rand() < 0.04) {
        presses++;
        press(a, rand() < 0.1 ? { dash: true } : { dir: dirs[Math.floor(rand() * 4)]! }, lateBy);
      }
    }
    prev = pos;
  }
  return { a, presses, maxStep, room };
}

beforeEach(() => {
  now = 1_000_000;
});

describe('预测 + 预约目标 tick（真实 Room + 模拟延迟）', () => {
  it('RTT 200ms：自己的预测与服务端逐 tick 一致，零纠正', () => {
    const { a, presses, maxStep } = playMatch(100, 12);
    expect(presses).toBeGreaterThan(30);
    expect(a.net.predictor.corrections).toBe(0);
    expect(a.net.stats.predictAhead).toBeGreaterThan(3); // 自己确实画在"未来"
    // 10ms 一帧，冲刺最快 1 格/tick：单帧位移不应超过 ~0.35 格
    expect(maxStep).toBeLessThan(0.4);
  });

  it('RTT 600ms 也零纠正（预约上限 10 tick 之内）', () => {
    const { a } = playMatch(300, 10);
    expect(a.net.predictor.corrections).toBe(0);
  });

  it('输入迟到（故意把目标 tick 提前 8 个）：服务端钳到 next，客户端检测到纠正', () => {
    const { a } = playMatch(100, 8, 8);
    expect(a.net.predictor.corrections).toBeGreaterThan(0);
    // 服务端没有因为"过去的 tick"拒绝输入，只是推迟应用
    expect(a.m.ack).toBeGreaterThan(0);
  });
});
