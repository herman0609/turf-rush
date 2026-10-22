// WebSocket 封装 + 时钟同步。
// M4 会在这里加入 ?lag / ?jitter / ?chaos 弱网模拟。

import type { C2S, S2C } from '@turf/shared/protocol';

export const clientNow = () => performance.timeOrigin + performance.now();

export interface ConnectionHandlers {
  onOpen(): void;
  onMessage(msg: S2C): void;
  onClose(code: number, reason: string): void;
}

interface ClockSample {
  rtt: number;
  offset: number;
}

export class Connection {
  private ws: WebSocket;
  private pingTimer: number | undefined;
  private samples: ClockSample[] = [];
  /** 服务端时间 ≈ 本地时间 + offset */
  offset = 0;
  rtt = 0;
  /** 服务端报告的本连接被丢弃的输入数 */
  serverDropped = 0;
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
      if (msg.t === 'pong') this.onPong(msg);
      else this.handlers.onMessage(msg);
    });
    this.ws.addEventListener('close', (ev) => {
      this.closed = true;
      window.clearInterval(this.pingTimer);
      this.handlers.onClose(ev.code, ev.reason);
    });
  }

  send(msg: C2S): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
    this.serverDropped = msg.dropped;
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
