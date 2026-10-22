// 集成测试：真实启动 HTTP + WebSocket，覆盖连接层的安全与异常处理。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@turf/shared/constants';
import type { S2C } from '@turf/shared/protocol';
import { createApp, type App } from './app';
import { silentLogger } from './log';

let app: App;
let base: string;
let wsUrl: string;

beforeAll(async () => {
  app = createApp({ port: 0, host: '127.0.0.1', staticDir: null, log: silentLogger, maxConnsPerIp: 6 });
  const port = await app.listen();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await app.shutdown();
});

interface Client {
  ws: WebSocket;
  msgs: S2C[];
  closed: Promise<{ code: number; reason: string }>;
  wait<T extends S2C['t']>(t: T, pred?: (m: Extract<S2C, { t: T }>) => boolean, ms?: number): Promise<Extract<S2C, { t: T }>>;
}

function open(headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers });
    const msgs: S2C[] = [];
    const listeners: (() => void)[] = [];
    ws.on('message', (d) => {
      msgs.push(JSON.parse(d.toString()) as S2C);
      listeners.forEach((l) => l());
    });
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason: reason.toString() })),
    );
    const client: Client = {
      ws,
      msgs,
      closed,
      wait: (t, pred = () => true, ms = 2000) =>
        new Promise((res, rej) => {
          const check = () => {
            const m = msgs.find((x) => x.t === t && pred(x as never));
            if (m) {
              clearTimeout(timer);
              res(m as never);
              return true;
            }
            return false;
          };
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
          if (!check()) listeners.push(() => void check());
        }),
    };
    ws.once('open', () => resolve(client));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

async function createRoom(): Promise<string> {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
  return ((await res.json()) as { code: string }).code;
}

describe('HTTP 接口', () => {
  it('建房、查房、无效房间码', async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    const ok = await (await fetch(`${base}/api/rooms/${code.toLowerCase()}`)).json();
    expect(ok).toMatchObject({ exists: true, phase: 'lobby', players: 0 });
    const missing = await (await fetch(`${base}/api/rooms/ZZZZZ`)).json();
    expect(missing).toEqual({ exists: false });
    const garbage = await (await fetch(`${base}/api/rooms/%3Cscript%3E`)).json();
    expect(garbage).toEqual({ exists: false });
  });

  it('方法不对返回 405，健康检查可用，带安全响应头', async () => {
    expect((await fetch(`${base}/api/rooms`)).status).toBe(405);
    const h = await fetch(`${base}/healthz`);
    expect(await h.json()).toMatchObject({ ok: true });
    expect(h.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(h.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('端口被占用时 listen() 以 EADDRINUSE 拒绝，而不是抛出未处理异常', async () => {
    const port = Number(new URL(base).port);
    const other = createApp({ port, host: '127.0.0.1', staticDir: null, log: silentLogger });
    await expect(other.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('WebSocket 安全', () => {
  it('拒绝跨站 Origin', async () => {
    await expect(open({ Origin: 'https://evil.example' })).rejects.toMatchObject({ status: 403 });
  });

  it('允许同源 Origin', async () => {
    const host = new URL(base).host;
    const c = await open({ Origin: `http://${host}` });
    c.ws.close();
  });

  it('未加入房间时只能发 join/ping', async () => {
    const c = await open();
    c.ws.send(JSON.stringify({ t: 'ready', ready: true }));
    expect((await c.wait('error')).code).toBe('NOT_ALLOWED');
    c.ws.send(JSON.stringify({ t: 'ping', c: 1 }));
    expect((await c.wait('pong')).c).toBe(1);
    c.ws.close();
  });

  it('协议版本不一致返回 OUTDATED', async () => {
    const code = await createRoom();
    const c = await open();
    c.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION + 1, code, name: 'x' }));
    expect((await c.wait('error')).code).toBe('OUTDATED');
    c.ws.close();
  });

  it('超过 1KB 的消息直接断开（1009）', async () => {
    const c = await open();
    c.ws.send(JSON.stringify({ t: 'ping', c: 1, pad: 'x'.repeat(2000) }));
    expect((await c.closed).code).toBe(1009);
  });

  it('非法 JSON / 未知字段返回 BAD_MSG；持续发送则被踢（4008）', async () => {
    const c = await open();
    c.ws.send('{oops');
    expect((await c.wait('error')).code).toBe('BAD_MSG');
    for (let i = 0; i < 25; i++) c.ws.send(JSON.stringify({ t: 'input', seq: 1, dir: 'U', x: 1 }));
    expect((await c.closed).code).toBe(4008);
  });

  it('超过频率限制的消息被丢弃并提示 RATE_LIMIT，连接保持', async () => {
    const c = await open();
    for (let i = 0; i < 60; i++) c.ws.send(JSON.stringify({ t: 'ping', c: i }));
    expect((await c.wait('error', (e) => e.code === 'RATE_LIMIT')).code).toBe('RATE_LIMIT');
    await new Promise((r) => setTimeout(r, 300));
    const pongs = c.msgs.filter((m) => m.t === 'pong').length;
    expect(pongs).toBeLessThan(60);
    expect(pongs).toBeGreaterThanOrEqual(39);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it('单 IP 并发连接数有上限', async () => {
    const clients: Client[] = [];
    let rejected: unknown = null;
    try {
      for (let i = 0; i < 8; i++) clients.push(await open());
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toMatchObject({ status: 429 });
    clients.forEach((c) => c.ws.close());
    await Promise.all(clients.map((c) => c.closed));
  });
});

describe('WebSocket 业务流程', () => {
  it('同一 token 的新连接会把旧连接踢下线（4001）', async () => {
    const code = await createRoom();
    const a = await open();
    a.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, code, name: '甲' }));
    const welcome = await a.wait('welcome');
    const a2 = await open();
    a2.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, code, name: '甲', token: welcome.token }));
    const w2 = await a2.wait('welcome');
    expect(w2.you).toBe(welcome.you);
    expect((await a.closed).code).toBe(4001);
    const snap = await a2.wait('snapshot');
    expect(snap.room.members.find((m) => m.id === welcome.you)!.online).toBe(true);
    a2.ws.close();
  });

  it('无效房间码返回 ROOM_NOT_FOUND', async () => {
    const c = await open();
    c.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, code: 'ZZZZZ', name: 'x' }));
    expect((await c.wait('error')).code).toBe('ROOM_NOT_FOUND');
    c.ws.close();
  });

  it('昵称中的 HTML 原样作为纯文本保存，控制字符被去掉', async () => {
    const code = await createRoom();
    const c = await open();
    c.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL_VERSION, code, name: '<b>x</b>\u0000\u200b' }));
    const snap = await c.wait('snapshot');
    expect(snap.room.members[0]!.name).toBe('<b>x</b>');
    c.ws.close();
  });
});
