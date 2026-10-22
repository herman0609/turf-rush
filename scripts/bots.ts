// 开发/演示工具：往一个已有房间里加入 N 个机器人，它们会自动准备、在对局中移动、结算后再来一局。
// 一个人验收时可以用它凑满 4 人局，也能用来观察多人同屏的画面。按 Ctrl+C 退出（机器人会主动离开）。
//
// 用法：npm run bots -- <房间码> [数量=1] [--url http://localhost:8080]
//       npm run bots -- AB2CD 3 --url https://turf-rush.onrender.com

import WebSocket from 'ws';
import { DX, DY, PROTOCOL_VERSION, type Dir } from '@turf/shared/constants';
import type { C2S, S2C } from '@turf/shared/protocol';
import { normalizeRoomCode, startBlocker } from '@turf/shared/util';
import { ClientSync } from '../client/src/sync';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const base = (urlIdx >= 0 ? args[urlIdx + 1] : undefined) ?? process.env.BOTS_URL ?? 'http://localhost:8080';
const positional = urlIdx >= 0 ? args.filter((_, i) => i !== urlIdx && i !== urlIdx + 1) : args;
const code: string = normalizeRoomCode(positional[0] ?? '') ?? '';
const count = Math.min(3, Math.max(1, Number(positional[1] ?? 1) || 1));
if (!code) {
  console.error('用法：npm run bots -- <房间码> [数量 1-3] [--url http://localhost:8080]');
  process.exit(1);
}
const wsUrl = `${base.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
const NAMES = ['机器人阿甲', '机器人阿乙', '机器人阿丙'];
const PERP: Record<Dir, Dir[]> = { U: ['L', 'R'], D: ['L', 'R'], L: ['U', 'D'], R: ['U', 'D'] };

class RoomBot {
  private ws!: WebSocket;
  private sync = new ClientSync();
  private you = '';
  private token: string | undefined;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private rematchAt = 0;
  private startAt = 0;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly seed: number,
  ) {}

  private rand = (() => {
    let s = this.seed;
    return () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
  })();

  connect(): void {
    this.ws = new WebSocket(wsUrl);
    this.ws.on('open', () => {
      this.seq = 0;
      this.send({ t: 'join', v: PROTOCOL_VERSION, code, name: this.name, token: this.token });
    });
    this.ws.on('message', (data) => this.onMessage(JSON.parse(data.toString()) as S2C));
    this.ws.on('close', (c, reason) => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.stopped) return;
      console.log(`[${this.name}] 连接关闭 ${c} ${reason.toString()}`);
      if (c === 4002 || c === 1012 || reason.toString() === 'room_expired') process.exit(0);
      setTimeout(() => this.connect(), 1000); // 意外断线：带 token 重连
    });
    this.ws.on('error', (e) => console.log(`[${this.name}] 错误 ${e.message}`));
  }

  stop(): void {
    this.stopped = true;
    if (this.ws.readyState === WebSocket.OPEN) this.send({ t: 'leave' });
    setTimeout(() => this.ws.close(), 100);
  }

  private send(msg: C2S): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.token = msg.token;
        console.log(`[${this.name}] 已加入房间 ${code}`);
        if (!this.timer) this.timer = setInterval(() => this.think(), 150);
        return;
      case 'snapshot':
        this.sync.applySnapshot(msg);
        return;
      case 'room':
        this.sync.applyRoom(msg);
        return;
      case 'tick': {
        const r = this.sync.applyTick(msg);
        if (r === 'gap' || r === 'mismatch') this.send({ t: 'resync' });
        return;
      }
      case 'error':
        console.log(`[${this.name}] 服务端拒绝：${msg.code} ${msg.msg}`);
        if (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'ROOM_FULL') process.exit(1);
        return;
      default:
        return;
    }
  }

  private think(): void {
    const room = this.sync.room;
    if (!room) return;
    const me = room.members.find((m) => m.id === this.you);
    if (!me) return;
    const now = Date.now();

    if (room.phase === 'lobby') {
      this.rematchAt = 0;
      if (me.role !== 'player') return;
      if (room.hostId === this.you) {
        // 机器人当了房主（真人都走了）：人齐就开
        const live = room.members.filter((m) => !m.left);
        if (startBlocker(live, room.hostId) === null) {
          if (!this.startAt) this.startAt = now + 2000;
          else if (now >= this.startAt) {
            this.startAt = 0;
            this.send({ t: 'start' });
          }
        } else this.startAt = 0;
      } else if (!me.ready) this.send({ t: 'ready', ready: true });
      return;
    }
    if (room.phase === 'result') {
      if (!this.rematchAt) this.rematchAt = now + 3000 + this.rand() * 2000;
      else if (now >= this.rematchAt) {
        this.rematchAt = -1;
        this.send({ t: 'rematch' });
      }
      return;
    }
    if (room.phase !== 'playing') return;

    const game = this.sync.game;
    const p = game?.players.find((x) => x.id === this.you);
    if (!game || !p) return;
    const blocked = (d: Dir, steps: number) => {
      const x = p.x + DX[d] * steps;
      const y = p.y + DY[d] * steps;
      return x < 0 || y < 0 || x >= game.w || y >= game.h;
    };
    // 快撞墙了、已经停住，或者随机想转：往一个不撞墙的垂直方向转
    if (blocked(p.dir, 1) || !p.moving || this.rand() < 0.07) {
      const options = PERP[p.dir].filter((d) => !blocked(d, 1));
      const d = options[Math.floor(this.rand() * options.length)];
      if (d) this.send({ t: 'input', seq: ++this.seq, dir: d });
    } else if (p.cdLeft === 0 && !blocked(p.dir, 4) && this.rand() < 0.05) {
      this.send({ t: 'input', seq: ++this.seq, dash: true });
    }
  }
}

const bots = Array.from({ length: count }, (_, i) => new RoomBot(NAMES[i]!, 1234 + i * 7919));
console.log(`把 ${count} 个机器人加入房间 ${code}（${wsUrl}），Ctrl+C 退出`);
bots.forEach((b, i) => setTimeout(() => b.connect(), i * 300));
const quit = () => {
  bots.forEach((b) => b.stop());
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
