// 单条 WebSocket 连接：负责"这条消息能不能进房间"——大小、频率、格式、心跳。
// 房间内的业务规则全部交给 Room。

import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, RATE_BURST, RATE_PER_SEC } from '@turf/shared/constants';
import { CloseCode, parseClientMessage, type ErrorCode, type S2C } from '@turf/shared/protocol';
import { normalizeRoomCode } from '@turf/shared/util';
import { TokenBucket, type WindowLimiter } from './limits';
import type { Logger } from './log';
import type { Link, Member, Room } from './room';
import type { RoomManager } from './rooms';

export interface ConnContext {
  manager: RoomManager;
  now: () => number;
  log: Logger;
  joinLimiter: WindowLimiter;
}

const HEARTBEAT_MS = 5000;
const SEND_BUFFER_LIMIT = 256 * 1024;
const MAX_BAD_MESSAGES = 20;
const MAX_RATE_DROPS = 100;

export function handleConnection(ws: WebSocket, ip: string, ctx: ConnContext): void {
  const link: Link = {
    stats: { dropped: 0 },
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
    congested: () => ws.bufferedAmount > SEND_BUFFER_LIMIT,
  };

  let room: Room | null = null;
  let member: Member | null = null;
  const bucket = new TokenBucket(RATE_PER_SEC, RATE_BURST, ctx.now());
  let bad = 0;
  let rateDrops = 0;
  let rateWindow = ctx.now();

  const sendError = (code: ErrorCode, msg: string) => link.send(JSON.stringify({ t: 'error', code, msg } satisfies S2C));
  const kick = (why: string) => {
    ctx.log('kick', { ip, why, room: room?.code, id: member?.id });
    link.close(CloseCode.Policy, why);
  };

  // 心跳：每 5 秒 ping 一次，上一次 ping 没有回应就判定连接已死（约 5–10 秒内发现半开连接）
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* 连接已关闭 */
    }
  }, HEARTBEAT_MS);

  ws.on('message', (data, isBinary) => {
    const now = ctx.now();

    if (!bucket.take(now)) {
      link.stats.dropped++;
      if (now - rateWindow > 10_000) {
        rateWindow = now;
        rateDrops = 0;
      }
      if (++rateDrops > MAX_RATE_DROPS) kick('rate_limit');
      else if (rateDrops === 1) sendError('RATE_LIMIT', '发送太快了');
      return;
    }

    const onBad = (why: string) => {
      bad++;
      if (bad > MAX_BAD_MESSAGES) kick('bad_messages');
      else if (bad <= 3) sendError('BAD_MSG', why);
    };
    if (isBinary) return onBad('binary not supported');
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return onBad('invalid json');
    }
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return onBad(parsed.error);
    const msg = parsed.msg;

    if (msg.t === 'ping') {
      link.send(JSON.stringify({ t: 'pong', c: msg.c, s: now, dropped: link.stats.dropped } satisfies S2C));
      return;
    }

    if (!room || !member) {
      if (msg.t !== 'join') return sendError('NOT_ALLOWED', '请先加入房间');
      if (msg.v !== PROTOCOL_VERSION) return sendError('OUTDATED', '游戏已更新，请刷新页面');
      const code = normalizeRoomCode(msg.code);
      const target = code ? ctx.manager.get(code) : undefined;
      if (!target) {
        if (!ctx.joinLimiter.hit(ip, now)) return sendError('RATE_LIMIT', '尝试次数过多，请稍后再试');
        return sendError('ROOM_NOT_FOUND', '房间不存在或已失效');
      }
      const m = target.join(link, { ...msg, code: target.code }, now);
      if (m) {
        room = target;
        member = m;
      }
      return;
    }

    room.handle(member, msg, now);
    if (msg.t === 'leave') {
      room = null;
      member = null;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (room && member) room.disconnect(member, link, ctx.now());
    room = null;
    member = null;
  });

  ws.on('error', (err) => {
    ctx.log('ws_error', { ip, err: String(err) });
  });
}
