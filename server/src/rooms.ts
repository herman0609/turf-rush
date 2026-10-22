import { randomInt } from 'node:crypto';
import { EMPTY_ROOM_TTL_MS } from '@turf/shared/constants';
import { generateRoomCode } from '@turf/shared/util';
import type { Logger } from './log';
import { Room } from './room';

export interface ManagerOptions {
  now: () => number;
  matchTicks: number;
  maxRooms: number;
  log: Logger;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;
  /** 最近一段时间主循环的最大延迟（ms），暴露在 /healthz 用于观察 0.1 CPU 下的抖动 */
  tickLagMs = 0;
  private lagWindowStart = 0;
  private lagMax = 0;

  constructor(private readonly opts: ManagerOptions) {}

  create(): Room | null {
    if (this.rooms.size >= this.opts.maxRooms) return null;
    let code: string;
    do code = generateRoomCode(randomInt);
    while (this.rooms.has(code));
    const room = new Room({ code, matchTicks: this.opts.matchTicks, log: this.opts.log, now: this.opts.now() });
    this.rooms.set(code, room);
    this.opts.log('room_create', { room: code, total: this.rooms.size });
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  connectionCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.connectionCount();
    return n;
  }

  update(): void {
    const now = this.opts.now();
    for (const [code, room] of this.rooms) {
      room.update(now);
      if (room.isEmpty() && room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
        room.closeAll(1000, 'room_expired');
        this.rooms.delete(code);
        this.opts.log('room_expire', { room: code, total: this.rooms.size });
      }
    }
  }

  /** 距离下一次需要 update 的毫秒数：有对局时精确对齐 tick，空闲时 50ms 一次检查宽限期 */
  private nextDelay(): number {
    const now = this.opts.now();
    let due = now + 50;
    for (const r of this.rooms.values()) due = Math.min(due, r.nextDue());
    return Math.max(1, Math.ceil(due - now));
  }

  start(): void {
    let expected = this.opts.now();
    const loop = () => {
      const now = this.opts.now();
      this.recordLag(now, now - expected);
      this.update();
      const delay = this.nextDelay();
      expected = this.opts.now() + delay;
      this.timer = setTimeout(loop, delay);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private recordLag(now: number, lag: number): void {
    if (now - this.lagWindowStart > 10_000) {
      this.tickLagMs = Math.round(this.lagMax);
      this.lagMax = 0;
      this.lagWindowStart = now;
    }
    this.lagMax = Math.max(this.lagMax, lag);
  }
}
