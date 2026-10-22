import { beforeEach, describe, expect, it } from 'vitest';
import { CHECKSUM_EVERY, COUNTDOWN_MS, SEAT_GRACE_MS, SOLO_GRACE_MS, TICK_MS } from '@turf/shared/constants';
import { checksum } from '@turf/shared/game';
import { CloseCode, PROTOCOL_VERSION, type S2C } from '@turf/shared';
import { silentLogger } from './log';
import { Room, type Link, type Member } from './room';

class FakeLink implements Link {
  sent: S2C[] = [];
  closed: { code: number; reason: string } | null = null;
  stats = { dropped: 0 };
  send(data: string) {
    this.sent.push(JSON.parse(data) as S2C);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  congested() {
    return false;
  }
  of<T extends S2C['t']>(t: T): Extract<S2C, { t: T }>[] {
    return this.sent.filter((m): m is Extract<S2C, { t: T }> => m.t === t);
  }
  last<T extends S2C['t']>(t: T): Extract<S2C, { t: T }> | undefined {
    const all = this.of(t);
    return all[all.length - 1];
  }
}

const MATCH_TICKS = 400; // 20 秒，需长于单人检测宽限期
let now = 1_000_000;
let room: Room;

function join(name: string, token?: string) {
  const link = new FakeLink();
  const m = room.join(link, { t: 'join', v: PROTOCOL_VERSION, code: room.code, name, token }, now);
  return { link, m: m as Member };
}

/** 两人进房、B 准备、A 开始，返回双方 */
function startTwo() {
  const a = join('A');
  const b = join('B');
  room.handle(b.m, { t: 'ready', ready: true }, now);
  room.handle(a.m, { t: 'start' }, now);
  return { a, b };
}

/** 模拟主循环：按 tick 粒度推进时间（主循环本来就是每个 tick 调用一次 update） */
function advance(ms: number) {
  const end = now + ms;
  while (now < end) {
    now = Math.min(end, now + TICK_MS);
    room.update(now);
  }
}

beforeEach(() => {
  now = 1_000_000;
  room = new Room({ code: 'ABCDE', matchTicks: MATCH_TICKS, log: silentLogger, now });
});

describe('加入与大厅', () => {
  it('第一个加入者成为房主，按顺序分配座位，收到 welcome + snapshot', () => {
    const a = join('A');
    const b = join('B');
    expect(room.hostId).toBe(a.m.id);
    expect([a.m.slot, b.m.slot]).toEqual([0, 1]);
    expect(a.link.of('welcome')[0]!.token).toBeTruthy();
    expect(b.link.of('snapshot')[0]!.room.members).toHaveLength(2);
    // A 收到了 B 加入后的房间更新，且版本号与 B 的快照一致
    expect(a.link.last('room')!.room.rev).toBe(b.link.of('snapshot')[0]!.room.rev);
  });

  it('昵称会被清洗与去重', () => {
    join('小明');
    const b = join('  小明\u200b ');
    expect(b.m.name).toBe('小明2');
  });

  it('房主以外的人不能开始；有人未准备时不能开始', () => {
    const a = join('A');
    const b = join('B');
    room.handle(b.m, { t: 'start' }, now);
    expect(b.link.last('error')!.code).toBe('NOT_ALLOWED');
    room.handle(a.m, { t: 'start' }, now);
    expect(a.link.last('error')!.msg).toBe('等待 B 准备');
    expect(room.phase).toBe('lobby');
  });

  it('满 4 人后再加入的人成为观战者', () => {
    for (const n of ['A', 'B', 'C', 'D']) join(n);
    const e = join('E');
    expect(e.m.role).toBe('spectator');
    expect(e.m.slot).toBeNull();
    expect(room.status().full).toBe(true);
  });
});

describe('完整一局', () => {
  it('倒计时 → 对局 → 按时结束 → 再来一局', () => {
    const { a, b } = startTwo();
    expect(room.phase).toBe('countdown');
    const snap = a.link.last('snapshot')!;
    expect(snap.round).toBe(1);
    expect(snap.game!.players).toHaveLength(2);
    expect(snap.room.startsAt).toBe(now + COUNTDOWN_MS);

    advance(COUNTDOWN_MS - 1);
    expect(room.phase).toBe('countdown');
    advance(1);
    expect(room.phase).toBe('playing');

    // 时间推进 10 个 tick
    advance(10 * TICK_MS);
    expect(room.game!.tick).toBe(10);
    const ticks = b.link.of('tick');
    expect(ticks.map((t) => t.tick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // 推进到结束
    advance(MATCH_TICKS * TICK_MS);
    expect(room.phase).toBe('result');
    const res = a.link.last('room')!.room.lastResult!;
    expect(res.reason).toBe('time');
    expect(res.ranking).toHaveLength(2);
    expect(res.sum).toBe(checksum(room.game!.cells, room.game!.players));
    // 校验和每 CHECKSUM_EVERY tick 附带一次
    const withSum = b.link.of('tick').filter((t) => t.sum !== undefined).map((t) => t.tick);
    expect(withSum[0]).toBe(CHECKSUM_EVERY);

    // 再来一局：回到大厅，点击者自动准备；B 准备后 A 开始第二局
    room.handle(b.m, { t: 'rematch' }, now);
    expect(room.phase).toBe('lobby');
    expect(b.m.ready).toBe(true);
    room.handle(a.m, { t: 'start' }, now);
    expect(room.phase).toBe('countdown');
    expect(room.round).toBe(2);
    expect(a.link.last('snapshot')!.tick).toBe(0);
  });

  it('服务器卡顿时最多追赶 MAX_CATCHUP_TICKS，并整体后移时间轴', () => {
    startTwo();
    advance(COUNTDOWN_MS);
    const endsAt = room.endsAt!;
    now += 20 * TICK_MS; // 主循环被阻塞，一次性落后 20 tick
    room.update(now);
    expect(room.game!.tick).toBeLessThan(20);
    expect(room.endsAt!).toBeGreaterThan(endsAt);
  });
});

describe('输入校验', () => {
  it('重复、过期的 seq 被丢弃并计数；合法输入被消费并 ack', () => {
    const { a } = startTwo();
    advance(COUNTDOWN_MS);
    room.handle(a.m, { t: 'input', seq: 5, dir: 'D' }, now);
    room.handle(a.m, { t: 'input', seq: 5, dir: 'D' }, now); // 重复
    room.handle(a.m, { t: 'input', seq: 3, dir: 'L' }, now); // 过期
    expect(a.link.stats.dropped).toBe(2);
    advance(TICK_MS);
    expect(a.link.last('tick')!.players.find((p) => p.id === a.m.id)!.ack).toBe(5);
  });

  it('大厅阶段和观战者的输入被丢弃', () => {
    const a = join('A');
    room.handle(a.m, { t: 'input', seq: 1, dir: 'D' }, now);
    expect(a.link.stats.dropped).toBe(1);
  });

  it('客户端无法影响其他玩家', () => {
    const { a, b } = startTwo();
    advance(COUNTDOWN_MS);
    const before = room.game!.players.find((p) => p.id === b.m.id)!.dir;
    room.handle(a.m, { t: 'input', seq: 1, dir: 'U' }, now);
    advance(TICK_MS * 3);
    expect(room.game!.players.find((p) => p.id === b.m.id)!.dir).toBe(before);
  });
});

describe('中途加入与观战', () => {
  it('对局中加入为观战者，回到大厅后补位成为玩家', () => {
    const { b } = startTwo();
    advance(COUNTDOWN_MS + TICK_MS);
    const c = join('C');
    expect(c.m.role).toBe('spectator');
    expect(c.link.of('snapshot')[0]!.game).not.toBeNull();
    advance(MATCH_TICKS * TICK_MS);
    room.handle(b.m, { t: 'rematch' }, now);
    expect(c.m.role).toBe('player');
    expect(c.m.slot).toBe(2);
  });
});

describe('断线、重连、离开', () => {
  it('同一 token 重连：踢掉旧连接，恢复座位并收到全量快照；旧连接迟到的 close 被忽略', () => {
    const { a } = startTwo();
    advance(COUNTDOWN_MS + 5 * TICK_MS);
    const token = a.link.of('welcome')[0]!.token;
    const again = join('ignored', token);
    expect(again.m.id).toBe(a.m.id);
    expect(a.link.closed?.code).toBe(CloseCode.Replaced);
    expect(again.link.of('snapshot')[0]!.tick).toBe(5);
    room.disconnect(a.m, a.link, now); // 旧连接的 close 事件
    expect(a.m.online).toBe(true);
  });

  it('无效 token 返回 TOKEN_INVALID', () => {
    join('A');
    const link = new FakeLink();
    expect(room.join(link, { t: 'join', v: 1, code: 'ABCDE', name: 'x', token: 'nope' }, now)).toBeNull();
    expect(link.last('error')!.code).toBe('TOKEN_INVALID');
  });

  it('掉线保留座位 30 秒，超时后移出并移交房主', () => {
    const a = join('A');
    const b = join('B');
    room.disconnect(a.m, a.link, now);
    expect(a.m.online).toBe(false);
    expect(b.link.last('room')!.room.members.find((m) => m.id === a.m.id)!.offlineUntil).toBe(now + SEAT_GRACE_MS);
    advance(SEAT_GRACE_MS - 1);
    expect(room.getMember(a.m.id)).toBeDefined();
    advance(1);
    expect(room.getMember(a.m.id)).toBeUndefined();
    expect(room.hostId).toBe(b.m.id);
  });

  it('对局中有人主动离开、只剩 1 人：立即结算，剩下的人获胜', () => {
    const { a, b } = startTwo();
    advance(COUNTDOWN_MS + 5 * TICK_MS);
    room.handle(a.m, { t: 'leave' }, now);
    expect(a.link.closed?.code).toBe(CloseCode.Left);
    expect(room.phase).toBe('result');
    expect(room.lastResult!.reason).toBe('opponents_left');
    expect(room.lastResult!.winners).toEqual([b.m.id]);
    expect(room.lastResult!.ranking.find((r) => r.id === a.m.id)!.left).toBe(true);
  });

  it('对局中只剩 1 名在线玩家超过 10 秒：结算', () => {
    const { a } = startTwo();
    advance(COUNTDOWN_MS + TICK_MS);
    room.disconnect(a.m, a.link, now);
    advance(SOLO_GRACE_MS - TICK_MS);
    expect(room.phase).toBe('playing');
    // 单人检测从断线后的下一次 update 开始计时，误差不超过 1 个 tick
    advance(2 * TICK_MS);
    expect(room.phase).toBe('result');
    expect(room.lastResult!.reason).toBe('opponents_offline');
  });

  it('倒计时中有人离开导致不足 2 人：回到大厅', () => {
    const { b } = startTwo();
    room.handle(b.m, { t: 'leave' }, now);
    expect(room.phase).toBe('lobby');
    expect(room.game).toBeNull();
  });

  it('所有人离开后房间标记为空', () => {
    const a = join('A');
    expect(room.isEmpty()).toBe(false);
    room.handle(a.m, { t: 'leave' }, now);
    expect(room.isEmpty()).toBe(true);
    expect(room.emptySince).toBe(now);
  });
});
