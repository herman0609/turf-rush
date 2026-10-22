// WebSocket 封装 + 时钟同步 + 弱网模拟。
//
// 弱网模拟（URL 参数，只影响本标签页，用于演示）：
//   ?lag=200     附加往返延迟 200ms（上下行各 100ms）
//   ?jitter=50   每条消息额外随机延迟 0~50ms（仍保持顺序：WebSocket 跑在 TCP 上，真实网络不会乱序）
//   ?chaos=1     故意制造重复与乱序：约 5% 的下行 tick 重复投递、5% 与下一条交换顺序；约 5% 的上行输入重复发送。
//                用来演示客户端丢弃过期 tick、服务端丢弃重复 seq。
// ping/pong 同样经过模拟延迟，所以测得的 RTT 和时钟偏差包含模拟部分。

import type { C2S, S2C } from '@turf/shared/protocol';

export const clientNow = () => performance.timeOrigin + performance.now();

export interface NetSim {
  lag: number;
  jitter: number;
  chaos: boolean;
}

function readSim(): NetSim {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) ? Math.min(2000, Math.max(0, v)) : 0;
  };
  return { lag: num('lag'), jitter: num('jitter'), chaos: q.get('chaos') === '1' };
}

export const NET_SIM: NetSim = readSim();
export const NET_SIM_ON = NET_SIM.lag > 0 || NET_SIM.jitter > 0 || NET_SIM.chaos;

/**
 * 保序延迟线：所有消息进同一个 FIFO 队列，只挂一个计时器按队首的释放时间出队。
 * 不能给每条消息各开一个 setTimeout——浏览器把延迟截断成整数毫秒、后台标签还会合并唤醒，
 * 释放时间相同的两条消息可能颠倒顺序（这正是早期版本在 jitter 下出现"断档"的原因）。
 */
class DelayLine {
  private q: { at: number; fn: () => void }[] = [];
  private last = 0;
  private timer = 0;
  constructor(
    private readonly base: number,
    private readonly jitter: number,
  ) {}
  push(fn: () => void): void {
    if (this.base === 0 && this.jitter === 0 && this.q.length === 0) return fn();
    const now = performance.now();
    this.last = Math.max(this.last, now + this.base + Math.random() * this.jitter);
    this.q.push({ at: this.last, fn });
    if (this.q.length === 1) this.arm();
  }
  private arm(): void {
    window.clearTimeout(this.timer);
    const head = this.q[0];
    if (head) this.timer = window.setTimeout(() => this.pump(), Math.max(0, head.at - performance.now()));
  }
  private pump(): void {
    // 计时器可能因取整早到不足 1ms，放宽 1ms
    const now = performance.now() + 1;
    while (this.q.length && this.q[0]!.at <= now) {
      const { fn } = this.q.shift()!;
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
    this.arm();
  }
}

export interface ConnectionHandlers {
  onOpen(): void;
  onMessage(msg: S2C): void;
  onClose(code: number, reason: string): void;
}

interface ClockSample {
  rtt: number;
  offset: number;
}

export interface ChaosStats {
  dupIn: number;
  swapIn: number;
  dupOut: number;
}

export class Connection {
  private ws: WebSocket;
  private pingTimer: number | undefined;
  private samples: ClockSample[] = [];
  private up = new DelayLine(NET_SIM.lag / 2, NET_SIM.jitter);
  private down = new DelayLine(NET_SIM.lag / 2, NET_SIM.jitter);
  private held: S2C | null = null;
  /** 服务端时间 ≈ 本地时间 + offset */
  offset = 0;
  rtt = 0;
  /** RTT 的平均绝对偏差，用作抖动估计 */
  jitter = 0;
  /** 服务端报告的本连接被丢弃的输入数 */
  serverDropped = 0;
  chaos: ChaosStats = { dupIn: 0, swapIn: 0, dupOut: 0 };
  closed = false;

  constructor(
    url: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      // 开局连发几次 ping，尽快得到可用的时钟偏差
      for (let i = 0; i < 3; i++) window.setTimeout(() => this.ping(), i * 150);
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
      this.handlers.onOpen();
    });
    this.ws.addEventListener('message', (ev) => {
      let msg: S2C;
      try {
        msg = JSON.parse(String(ev.data)) as S2C;
      } catch {
        return;
      }
      this.down.push(() => this.receive(msg));
    });
    this.ws.addEventListener('close', (ev) => {
      // 关闭事件也排在模拟延迟之后，保证在它之前到达的消息先被处理
      this.down.push(() => {
        this.closed = true;
        window.clearInterval(this.pingTimer);
        this.handlers.onClose(ev.code, ev.reason);
      });
    });
  }

  /** 是否已经完成至少一次时钟同步 */
  get synced(): boolean {
    return this.samples.length > 0;
  }

  private receive(msg: S2C): void {
    if (this.closed) return;
    if (msg.t === 'pong') return this.onPong(msg);
    if (NET_SIM.chaos && msg.t === 'tick') {
      // 交换顺序：先扣下这一条，等下一条到了再一起放出去（新的在前）
      if (this.held) {
        const h = this.held;
        this.held = null;
        this.handlers.onMessage(msg);
        this.handlers.onMessage(h);
        return;
      }
      const r = Math.random();
      if (r < 0.05) {
        this.chaos.swapIn++;
        this.held = msg;
        return;
      }
      this.handlers.onMessage(msg);
      if (r < 0.1) {
        this.chaos.dupIn++;
        this.handlers.onMessage(msg);
      }
      return;
    }
    if (this.held) {
      const h = this.held;
      this.held = null;
      this.handlers.onMessage(h);
    }
    this.handlers.onMessage(msg);
  }

  send(msg: C2S): void {
    const data = JSON.stringify(msg);
    const dup = NET_SIM.chaos && msg.t === 'input' && Math.random() < 0.05;
    if (dup) this.chaos.dupOut++;
    this.up.push(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(data);
      if (dup) this.ws.send(data);
    });
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    this.ws.close(1000, 'bye');
  }

  serverNow(): number {
    return clientNow() + this.offset;
  }

  private ping(): void {
    this.send({ t: 'ping', c: clientNow() });
  }

  private onPong(msg: Extract<S2C, { t: 'pong' }>): void {
    const now = clientNow();
    const rtt = now - msg.c;
    this.samples.push({ rtt, offset: msg.s - (msg.c + rtt / 2) });
    if (this.samples.length > 8) this.samples.shift();
    // 取 RTT 最小的样本估算偏差：排队延迟最少，最接近真实单程时间
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = this.samples.reduce((s, x) => s + x.rtt, 0) / this.samples.length;
    this.jitter = this.samples.reduce((s, x) => s + Math.abs(x.rtt - this.rtt), 0) / this.samples.length;
    this.serverDropped = msg.dropped;
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
