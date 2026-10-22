// Room：单个房间的状态机与生命周期。
// 设计要点：
// - 没有内部定时器。所有与时间有关的逻辑（倒计时结束、tick 推进、宽限期、单人检测）
//   都在 update(now) 里按时间戳判定，由 RoomManager 的循环驱动。测试时直接传入假时间。
// - 所有状态变更都是同步的，单线程内不存在交错，避免定时器与事件之间的竞态。
// - 客户端只能发输入；位置、分数、胜负全部在这里计算。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CHECKSUM_EVERY,
  COUNTDOWN_MS,
  MAX_CATCHUP_TICKS,
  MAX_INPUTS_PER_TICK,
  MAX_INPUT_QUEUE,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  SEAT_GRACE_MS,
  SOLO_GRACE_MS,
  TICK_MS,
} from '@turf/shared/constants';
import { checksum, createGame, rankPlayers, step, type GameState, type TickInput } from '@turf/shared/game';
import type {
  C2S,
  EndReason,
  ErrorCode,
  GameView,
  JoinMsg,
  MemberView,
  Phase,
  PState,
  ResultView,
  Role,
  RoomStatus,
  RoomView,
  S2C,
} from '@turf/shared/protocol';
import { CloseCode } from '@turf/shared/protocol';
import { dedupeName, sanitizeName, startBlocker } from '@turf/shared/util';
import type { Logger } from './log';

/** 一条客户端连接在 Room 看来的样子。真实实现见 conn.ts，测试里用假的。 */
export interface Link {
  send(data: string): void;
  close(code: number, reason: string): void;
  /** 发送缓冲是否积压（慢客户端） */
  congested(): boolean;
  stats: { dropped: number };
}

interface QueuedCmd {
  seq: number;
  dir?: 'U' | 'D' | 'L' | 'R';
  dash?: boolean;
}

export interface Member {
  id: string;
  name: string;
  token: string;
  role: Role;
  slot: number | null;
  ready: boolean;
  online: boolean;
  offlineUntil: number | null;
  left: boolean;
  order: number;
  link: Link | null;
  /** 本连接已接受的最大 seq（按连接计数，换连接归零） */
  lastSeq: number;
  /** 最后一条已被模拟消费的 seq */
  ack: number;
  queue: QueuedCmd[];
  needsSnapshot: boolean;
  lastResyncAt: number;
}

export interface RoomOptions {
  code: string;
  matchTicks: number;
  log: Logger;
  now: number;
}

const randomId = (prefix: string, bytes: number) => prefix + randomBytes(bytes).toString('base64url');

function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class Room {
  readonly code: string;
  phase: Phase = 'lobby';
  round = 0;
  rev = 0;
  hostId: string | null = null;
  game: GameState | null = null;
  startsAt: number | null = null;
  endsAt: number | null = null;
  lastResult: ResultView | null = null;
  /** 房间里没有任何（未离开的）成员的起始时间；null 表示有人 */
  emptySince: number | null;

  private readonly members = new Map<string, Member>();
  private readonly matchTicks: number;
  private readonly log: Logger;
  private order = 0;
  private soloSince: number | null = null;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.matchTicks = opts.matchTicks;
    this.log = opts.log;
    this.emptySince = opts.now;
  }

  // ------------------------------------------------------------------ 查询

  status(): RoomStatus {
    const players = this.liveMembers().filter((m) => m.role === 'player').length;
    const spectators = this.liveMembers().filter((m) => m.role === 'spectator').length;
    return { exists: true, phase: this.phase, players, spectators, full: players >= MAX_PLAYERS };
  }

  isEmpty(): boolean {
    return this.liveMembers().length === 0;
  }

  connectionCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.link) n++;
    return n;
  }

  /** 下一次需要被 update 的时间点（用于主循环精确调度 tick） */
  nextDue(): number {
    if (this.phase === 'countdown' && this.startsAt !== null) return this.startsAt;
    if (this.phase === 'playing' && this.startsAt !== null && this.game) {
      return this.startsAt + (this.game.tick + 1) * TICK_MS;
    }
    return Infinity;
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  // ------------------------------------------------------------------ 连接事件

  /** 新加入或凭 token 重连。成功返回成员，失败时已向 link 发送错误并返回 null。 */
  join(link: Link, msg: JoinMsg, now: number): Member | null {
    if (msg.token) return this.rejoin(link, msg.token);

    const canPlay = (this.phase === 'lobby' || this.phase === 'result') && this.freeSlot() !== null;
    let role: Role;
    if (canPlay) role = 'player';
    else if (this.liveMembers().filter((m) => m.role === 'spectator').length < MAX_SPECTATORS) role = 'spectator';
    else {
      this.sendError(link, 'ROOM_FULL', '房间已满');
      return null;
    }

    const taken = this.liveMembers().map((m) => m.name);
    const name = dedupeName(sanitizeName(msg.name) || '玩家', taken);
    const m: Member = {
      id: randomId('p_', 6),
      name,
      token: randomId('', 16),
      role,
      slot: role === 'player' ? this.freeSlot() : null,
      ready: false,
      online: true,
      offlineUntil: null,
      left: false,
      order: this.order++,
      link,
      lastSeq: 0,
      ack: 0,
      queue: [],
      needsSnapshot: false,
      lastResyncAt: 0,
    };
    this.members.set(m.id, m);
    this.emptySince = null;
    if (!this.hostId) this.hostId = m.id;
    this.log('join', { room: this.code, id: m.id, role, phase: this.phase });

    this.rev++;
    this.sendTo(m, { t: 'welcome', you: m.id, token: m.token, role: m.role });
    this.sendSnapshot(m);
    this.sendRoomToOthers(m);
    return m;
  }

  private rejoin(link: Link, token: string): Member | null {
    let found: Member | undefined;
    for (const m of this.members.values()) if (!m.left && tokenEquals(m.token, token)) found = m;
    if (!found) {
      this.sendError(link, 'TOKEN_INVALID', '座位已失效');
      return null;
    }
    const m = found;
    const old = m.link;
    m.link = link;
    m.online = true;
    m.offlineUntil = null;
    m.lastSeq = 0;
    m.ack = 0;
    m.queue = [];
    m.needsSnapshot = false;
    // 同一 token 建立了新连接：踢掉旧连接（例如复制了标签页）
    if (old && old !== link) old.close(CloseCode.Replaced, 'replaced');
    this.log('rejoin', { room: this.code, id: m.id, replaced: !!old, phase: this.phase });

    this.rev++;
    this.sendTo(m, { t: 'welcome', you: m.id, token: m.token, role: m.role });
    this.sendSnapshot(m);
    this.sendRoomToOthers(m);
    return m;
  }

  /** 连接断开（非主动离开）。只处理当前绑定的连接，旧连接的迟到 close 直接忽略。 */
  disconnect(m: Member, link: Link, now: number): void {
    if (m.link !== link) return;
    m.link = null;
    if (m.left || !this.members.has(m.id)) return;
    m.online = false;
    m.offlineUntil = now + SEAT_GRACE_MS;
    m.queue = [];
    this.log('offline', { room: this.code, id: m.id, phase: this.phase });
    this.broadcastRoom();
  }

  handle(m: Member, msg: C2S, now: number): void {
    if (!this.members.has(m.id) || m.left) return;
    switch (msg.t) {
      case 'ready': {
        if (this.phase !== 'lobby' || m.role !== 'player') return this.notAllowed(m, '现在不能准备');
        if (m.ready === msg.ready) return;
        m.ready = msg.ready;
        this.broadcastRoom();
        return;
      }
      case 'start': {
        if (this.phase !== 'lobby') return this.notAllowed(m, '现在不能开始');
        if (this.hostId !== m.id) return this.notAllowed(m, '只有房主可以开始');
        const why = startBlocker(this.liveMembers(), this.hostId);
        if (why) return this.notAllowed(m, why);
        this.startCountdown(now);
        return;
      }
      case 'input':
        this.onInput(m, msg);
        return;
      case 'rematch': {
        if (this.phase !== 'result') return; // 已经回到大厅：重复点击无害，直接忽略
        this.toLobby(m);
        return;
      }
      case 'leave': {
        const link = m.link;
        this.removeMember(m, 'leave', now);
        link?.close(CloseCode.Left, 'left');
        return;
      }
      case 'resync': {
        if (now - m.lastResyncAt < 1000) return;
        m.lastResyncAt = now;
        this.sendSnapshot(m);
        return;
      }
      case 'join':
        return this.notAllowed(m, '已经在房间里了');
      case 'ping':
        return; // 由连接层直接回复
    }
  }

  private onInput(m: Member, msg: Extract<C2S, { t: 'input' }>): void {
    const drop = () => {
      if (m.link) m.link.stats.dropped++;
    };
    const live = this.phase === 'countdown' || this.phase === 'playing';
    const inGame = !!this.game && this.game.players.some((p) => p.id === m.id);
    if (!live || !inGame || !m.online) return drop();
    if (msg.seq <= m.lastSeq) return drop(); // 重复或过期
    m.lastSeq = msg.seq;
    if (m.queue.length >= MAX_INPUT_QUEUE) return drop();
    m.queue.push({ seq: msg.seq, dir: msg.dir, dash: msg.dash });
  }

  // ------------------------------------------------------------------ 时间推进

  update(now: number): void {
    // 宽限期到期：移出房间
    const expired = [...this.members.values()].filter(
      (m) => !m.left && !m.online && m.offlineUntil !== null && now >= m.offlineUntil,
    );
    for (const m of expired) this.removeMember(m, 'timeout', now);

    if (this.phase === 'countdown' && this.startsAt !== null && now >= this.startsAt) {
      this.phase = 'playing';
      this.log('phase', { room: this.code, phase: 'playing', round: this.round });
      this.broadcastRoom();
    }

    if (this.phase === 'playing' && this.game && this.startsAt !== null) {
      const target = Math.min(this.game.endTick, Math.floor((now - this.startsAt) / TICK_MS));
      let n = 0;
      while (this.game.tick < target && n < MAX_CATCHUP_TICKS) {
        this.doTick();
        n++;
      }
      if (this.game.tick < target) {
        // 服务器卡顿太久：不再追赶，把时间轴整体后移，保证剩余时间仍然一致
        const behind = target - this.game.tick;
        this.startsAt += behind * TICK_MS;
        if (this.endsAt !== null) this.endsAt += behind * TICK_MS;
        this.log('tick_overrun', { room: this.code, behind });
        this.broadcastRoom();
      }
      if (this.game.tick >= this.game.endTick) {
        this.finish('time');
        return;
      }
      // 只剩 1 名在线玩家持续一段时间：提前结束
      const online = this.activeParticipants().filter((m) => m.online).length;
      if (online <= 1) {
        this.soloSince ??= now;
        if (now - this.soloSince >= SOLO_GRACE_MS) this.finish('opponents_offline');
      } else {
        this.soloSince = null;
      }
    }
  }

  private doTick(): void {
    const game = this.game!;
    const inputs: Record<string, TickInput> = {};
    for (const p of game.players) {
      const m = this.members.get(p.id);
      const active = !!m && m.online && !m.left;
      const cmds = m && active ? m.queue.splice(0, MAX_INPUTS_PER_TICK) : [];
      if (m && cmds.length > 0) m.ack = cmds[cmds.length - 1]!.seq;
      inputs[p.id] = { cmds, frozen: !active };
    }
    const { state, changes } = step(game, inputs);
    this.game = state;

    const msg: S2C = {
      t: 'tick',
      round: this.round,
      tick: state.tick,
      players: this.pstates(),
      cells: changes,
      scores: state.scores,
    };
    if (state.tick % CHECKSUM_EVERY === 0 || state.tick === state.endTick) {
      msg.sum = checksum(state.cells, state.players);
    }
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (!m.link) continue;
      if (m.link.congested()) {
        m.needsSnapshot = true;
        continue;
      }
      if (m.needsSnapshot) {
        m.needsSnapshot = false;
        this.sendSnapshot(m);
      } else {
        m.link.send(data);
      }
    }
  }

  // ------------------------------------------------------------------ 阶段切换

  private startCountdown(now: number): void {
    const players = this.liveMembers()
      .filter((m) => m.role === 'player' && m.slot !== null)
      .sort((a, b) => a.slot! - b.slot!);
    this.round++;
    this.game = createGame({
      players: players.map((m) => ({ id: m.id, slot: m.slot! })),
      endTick: this.matchTicks,
    });
    this.startsAt = now + COUNTDOWN_MS;
    this.endsAt = this.startsAt + this.matchTicks * TICK_MS;
    this.phase = 'countdown';
    this.soloSince = null;
    this.lastResult = null;
    for (const m of this.members.values()) {
      m.queue = [];
      m.ready = false;
    }
    this.log('phase', { room: this.code, phase: 'countdown', round: this.round, players: players.length });
    this.rev++;
    for (const m of this.members.values()) this.sendSnapshot(m);
  }

  private finish(reason: EndReason): void {
    const game = this.game!;
    const meta = game.players.map((p) => {
      const m = this.members.get(p.id);
      return { id: p.id, slot: p.slot, name: m?.name ?? '?', left: !m || m.left };
    });
    const { ranking, winners } = rankPlayers(game.scores, meta);
    this.lastResult = {
      round: this.round,
      reason,
      ranking,
      winners,
      sum: checksum(game.cells, game.players),
    };
    this.phase = 'result';
    this.soloSince = null;
    for (const m of this.members.values()) {
      m.queue = [];
      m.ready = false;
    }
    this.log('finish', { room: this.code, round: this.round, reason, winners, scores: ranking.map((r) => r.score) });
    this.broadcastRoom();
  }

  private cancelCountdown(): void {
    this.phase = 'lobby';
    this.game = null;
    this.startsAt = null;
    this.endsAt = null;
    this.purgeLeft();
    this.fillSeats();
    this.log('phase', { room: this.code, phase: 'lobby', reason: 'cancelled' });
  }

  private toLobby(by: Member): void {
    this.phase = 'lobby';
    this.game = null;
    this.startsAt = null;
    this.endsAt = null;
    this.purgeLeft();
    for (const m of this.members.values()) m.ready = false;
    this.fillSeats();
    if (by.role === 'player') by.ready = true;
    this.ensureHost();
    this.log('phase', { room: this.code, phase: 'lobby', by: by.id });
    this.broadcastRoom();
  }

  /** 移出成员。对局中的参赛者只标记为"已离开"（保留格子与榜单），其余直接删除。 */
  private removeMember(m: Member, reason: 'leave' | 'timeout', now: number): void {
    const live = this.phase === 'countdown' || this.phase === 'playing';
    const inGame = live && !!this.game && this.game.players.some((p) => p.id === m.id);
    m.link = null;
    m.online = false;
    m.offlineUntil = null;
    m.queue = [];
    if (inGame) m.left = true;
    else this.members.delete(m.id);
    this.log('remove', { room: this.code, id: m.id, reason, phase: this.phase });

    if (this.hostId === m.id) this.ensureHost();
    if (this.isEmpty()) this.emptySince = now;

    if (this.phase === 'countdown' && this.activeParticipants().length < 2) this.cancelCountdown();
    else if (this.phase === 'playing' && this.activeParticipants().length < 2) {
      this.finish('opponents_left'); // finish 内部会广播
      return;
    } else if (this.phase === 'lobby' || this.phase === 'result') this.fillSeats();

    this.broadcastRoom();
  }

  // ------------------------------------------------------------------ 辅助

  private liveMembers(): Member[] {
    return [...this.members.values()].filter((m) => !m.left).sort((a, b) => a.order - b.order);
  }

  /** 本局参赛且未离开的成员 */
  private activeParticipants(): Member[] {
    if (!this.game) return [];
    const out: Member[] = [];
    for (const p of this.game.players) {
      const m = this.members.get(p.id);
      if (m && !m.left) out.push(m);
    }
    return out;
  }

  private freeSlot(): number | null {
    const used = new Set<number>();
    for (const m of this.members.values()) if (m.slot !== null) used.add(m.slot);
    for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return null;
  }

  private purgeLeft(): void {
    for (const m of [...this.members.values()]) if (m.left) this.members.delete(m.id);
  }

  /** 大厅/结算阶段：观战者按加入顺序补上空出的座位 */
  private fillSeats(): void {
    for (const m of this.liveMembers()) {
      if (m.role !== 'spectator') continue;
      const slot = this.freeSlot();
      if (slot === null) return;
      m.role = 'player';
      m.slot = slot;
      m.ready = false;
      this.log('promote', { room: this.code, id: m.id, slot });
    }
  }

  /** 房主失效时移交：优先玩家、其次在线、再按加入顺序 */
  private ensureHost(): void {
    const cur = this.hostId ? this.members.get(this.hostId) : undefined;
    if (cur && !cur.left) return;
    const next = this.liveMembers().sort(
      (a, b) =>
        Number(b.role === 'player') - Number(a.role === 'player') ||
        Number(b.online) - Number(a.online) ||
        a.order - b.order,
    )[0];
    const prev = this.hostId;
    this.hostId = next?.id ?? null;
    if (prev !== this.hostId) this.log('host', { room: this.code, from: prev, to: this.hostId });
  }

  private pstates(): PState[] {
    return (this.game?.players ?? []).map((p) => ({
      id: p.id,
      slot: p.slot,
      x: p.x,
      y: p.y,
      dir: p.dir,
      moving: p.moving,
      dashLeft: p.dashLeft,
      cdLeft: p.cdLeft,
      frozen: p.frozen,
      ack: this.members.get(p.id)?.ack ?? 0,
    }));
  }

  view(): RoomView {
    const members: MemberView[] = [...this.members.values()]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        slot: m.slot,
        ready: m.ready,
        online: m.online,
        offlineUntil: m.offlineUntil,
        left: m.left,
      }));
    return {
      code: this.code,
      rev: this.rev,
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      members,
      lastResult: this.lastResult,
    };
  }

  private gameView(): GameView | null {
    const g = this.game;
    if (!g) return null;
    return { w: g.w, h: g.h, tick: g.tick, endTick: g.endTick, cells: g.cells, players: this.pstates(), scores: g.scores };
  }

  private sendSnapshot(m: Member): void {
    this.sendTo(m, {
      t: 'snapshot',
      round: this.round,
      tick: this.game?.tick ?? 0,
      room: this.view(),
      game: this.gameView(),
    });
  }

  /** 房间元数据变化：版本号 +1 并整体下发给所有人 */
  private broadcastRoom(): void {
    this.rev++;
    this.sendRoomToOthers(null);
  }

  /** 以当前版本号下发给除 except 外的所有人（except 刚收到同版本的快照） */
  private sendRoomToOthers(except: Member | null): void {
    const data = JSON.stringify({ t: 'room', room: this.view() } satisfies S2C);
    for (const m of this.members.values()) if (m.link && m !== except) m.link.send(data);
  }

  private sendTo(m: Member, msg: S2C): void {
    m.link?.send(JSON.stringify(msg));
  }

  private sendError(link: Link, code: ErrorCode, msg: string): void {
    link.send(JSON.stringify({ t: 'error', code, msg } satisfies S2C));
  }

  private notAllowed(m: Member, msg: string): void {
    if (m.link) this.sendError(m.link, 'NOT_ALLOWED', msg);
  }

  /** 服务关闭时：通知并断开所有连接 */
  closeAll(code: number, reason: string): void {
    for (const m of this.members.values()) {
      m.link?.close(code, reason);
      m.link = null;
    }
  }
}
