// 协议定义。客户端 → 服务端的消息用 zod strict schema 校验（拒绝未知字段）；
// 服务端 → 客户端的消息只定义类型（服务端是可信方）。

import { z } from 'zod';
import type { Dir } from './constants';

// ---------------- 客户端 → 服务端 ----------------

const DirSchema = z.enum(['U', 'D', 'L', 'R']);

const JoinSchema = z.strictObject({
  t: z.literal('join'),
  v: z.number().int(),
  code: z.string().max(16),
  name: z.string().max(64),
  token: z.string().min(1).max(64).optional(),
});

const ReadySchema = z.strictObject({ t: z.literal('ready'), ready: z.boolean() });
const StartSchema = z.strictObject({ t: z.literal('start') });
const InputSchema = z.strictObject({
  t: z.literal('input'),
  seq: z.number().int().min(1).max(2 ** 31 - 1),
  /** 希望在哪个 tick 生效（客户端预测用）。服务端钳制到 [next, next+10]；缺省表示下一个 tick */
  tick: z.number().int().min(0).max(1_000_000).optional(),
  dir: DirSchema.optional(),
  dash: z.literal(true).optional(),
});
const RematchSchema = z.strictObject({ t: z.literal('rematch') });
const LeaveSchema = z.strictObject({ t: z.literal('leave') });
const PingSchema = z.strictObject({ t: z.literal('ping'), c: z.number().finite() });
const ResyncSchema = z.strictObject({ t: z.literal('resync') });

export const ClientMessageSchema = z.discriminatedUnion('t', [
  JoinSchema,
  ReadySchema,
  StartSchema,
  InputSchema,
  RematchSchema,
  LeaveSchema,
  PingSchema,
  ResyncSchema,
]);

export type C2S = z.infer<typeof ClientMessageSchema>;
export type JoinMsg = z.infer<typeof JoinSchema>;
export type InputMsg = z.infer<typeof InputSchema>;

export type ParseResult = { ok: true; msg: C2S } | { ok: false; error: string };

/** 解析并校验一条客户端消息（已 JSON.parse 的值）。 */
export function parseClientMessage(raw: unknown): ParseResult {
  const r = ClientMessageSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
  const msg = r.data;
  if (msg.t === 'input' && msg.dir === undefined && msg.dash === undefined) {
    return { ok: false, error: 'input needs dir or dash' };
  }
  return { ok: true, msg };
}

// ---------------- 服务端 → 客户端 ----------------

export type Phase = 'lobby' | 'countdown' | 'playing' | 'result';
export type Role = 'player' | 'spectator';
export type EndReason = 'time' | 'opponents_offline' | 'opponents_left';

export interface MemberView {
  id: string;
  name: string;
  role: Role;
  slot: number | null;
  ready: boolean;
  online: boolean;
  /** 离线时：座位保留到这个服务端时间点 */
  offlineUntil: number | null;
  /** 对局中离开（或宽限超时），本局不参与胜负 */
  left: boolean;
}

export interface ResultView {
  round: number;
  reason: EndReason;
  ranking: { id: string; name: string; slot: number; score: number; left: boolean }[];
  winners: string[];
  /** 终局全图校验和 */
  sum: number;
}

export interface RoomView {
  code: string;
  rev: number;
  phase: Phase;
  round: number;
  hostId: string | null;
  startsAt: number | null;
  endsAt: number | null;
  /** 对局中在线玩家不足 2 人时：到这个服务端时间点仍未恢复就结束本局 */
  soloEndsAt: number | null;
  members: MemberView[];
  lastResult: ResultView | null;
}

export interface PState {
  id: string;
  slot: number;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  /** 距离下一次前进累计的单位数（客户端预测需要它才能精确重演） */
  progress: number;
  /** 已排队、将在下一次前进时生效的转向 */
  queue: Dir[];
  dashLeft: number;
  cdLeft: number;
  frozen: boolean;
  /** 服务端最后处理的本连接输入 seq */
  ack: number;
}

export interface GameView {
  w: number;
  h: number;
  tick: number;
  endTick: number;
  cells: number[];
  players: PState[];
  scores: number[];
}

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'BAD_MSG'
  | 'RATE_LIMIT'
  | 'NOT_ALLOWED'
  | 'TOKEN_INVALID'
  | 'OUTDATED'
  | 'SERVER_FULL';

export type S2C =
  | { t: 'welcome'; you: string; token: string; role: Role }
  | { t: 'snapshot'; round: number; tick: number; room: RoomView; game: GameView | null }
  | { t: 'room'; room: RoomView }
  | {
      t: 'tick';
      round: number;
      tick: number;
      players: PState[];
      cells: number[];
      scores: number[];
      sum?: number;
    }
  | { t: 'pong'; c: number; s: number; dropped: number }
  | { t: 'error'; code: ErrorCode; msg: string };

/** WebSocket 关闭码 */
export const CloseCode = {
  Replaced: 4001,
  Left: 4002,
  Policy: 4008,
  ServerRestart: 1012,
} as const;

/** HTTP GET /api/rooms/:code 的返回 */
export interface RoomStatus {
  exists: boolean;
  phase?: Phase;
  players?: number;
  spectators?: number;
  full?: boolean;
}
