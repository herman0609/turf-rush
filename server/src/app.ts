// 应用工厂：同一个 http.Server 上提供静态页面、/api、/healthz 与 /ws。
// 入口 index.ts 和回归脚本 sim-match.ts 都通过它启动服务。

import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sirv from 'sirv';
import { WebSocketServer } from 'ws';
import { DEFAULT_MATCH_SECONDS, MAX_MSG_BYTES, TICK_MS } from '@turf/shared/constants';
import { CloseCode, type RoomStatus } from '@turf/shared/protocol';
import { normalizeRoomCode } from '@turf/shared/util';
import { handleConnection } from './conn';
import { WindowLimiter } from './limits';
import { jsonLogger, type Logger } from './log';
import { RoomManager } from './rooms';

export interface AppOptions {
  port?: number;
  host?: string;
  staticDir?: string | null;
  matchSeconds?: number;
  /** 部署在反向代理后面时为 true，从 X-Forwarded-For 取客户端 IP */
  trustProxy?: boolean;
  /** 额外允许的 WebSocket Origin（同源总是允许） */
  allowedOrigins?: string[];
  maxRooms?: number;
  maxConnsPerIp?: number;
  log?: Logger;
}

export interface App {
  server: http.Server;
  manager: RoomManager;
  listen(): Promise<number>;
  shutdown(): Promise<void>;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(opts: AppOptions = {}): App {
  const log = opts.log ?? jsonLogger;
  const now = () => performance.timeOrigin + performance.now();
  const matchSeconds = opts.matchSeconds ?? DEFAULT_MATCH_SECONDS;
  const manager = new RoomManager({
    now,
    matchTicks: Math.round((matchSeconds * 1000) / TICK_MS),
    maxRooms: opts.maxRooms ?? 200,
    log,
  });
  const createLimiter = new WindowLimiter(10, 60_000);
  const lookupLimiter = new WindowLimiter(30, 60_000);
  const joinLimiter = new WindowLimiter(30, 60_000);
  const maxConnsPerIp = opts.maxConnsPerIp ?? 8;
  const ipConns = new Map<string, number>();
  const allowed = new Set(opts.allowedOrigins ?? []);

  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? opts.staticDir : null;
  const serveStatic = staticDir
    ? sirv(staticDir, {
        // 生产环境启动时缓存文件元数据（每次部署都是新进程）；本地开发时每次请求重新读取，
        // 否则"服务不停、只重新构建"时 ETag 不变，浏览器会一直拿 304 用旧页面
        dev: process.env.NODE_ENV !== 'production',
        etag: true,
        setHeaders: (res, pathname) => {
          res.setHeader(
            'Cache-Control',
            pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      })
    : null;

  const clientIp = (req: http.IncomingMessage): string => {
    if (opts.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ip = clientIp(req);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (path === '/healthz') {
      return json(res, 200, {
        ok: true,
        rooms: manager.rooms.size,
        conns: manager.connectionCount(),
        tickLagMs: manager.tickLagMs,
      });
    }

    if (path === '/api/rooms') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
      if (!createLimiter.hit(ip, now())) return json(res, 429, { error: 'RATE_LIMIT' });
      const room = manager.create();
      if (!room) return json(res, 503, { error: 'SERVER_FULL' });
      return json(res, 201, { code: room.code });
    }

    const m = /^\/api\/rooms\/([^/]+)$/.exec(path);
    if (m) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      if (!lookupLimiter.hit(ip, now())) return json(res, 429, { error: 'RATE_LIMIT' });
      const code = normalizeRoomCode(decodeURIComponent(m[1]!));
      const room = code ? manager.get(code) : undefined;
      const body: RoomStatus = room ? room.status() : { exists: false };
      return json(res, 200, body);
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'not_found' });

    // SPA 路由：只有 / 和 /r/CODE 回退到 index.html，其余未知路径返回 404
    if (/^\/r\/[^/]+\/?$/.test(path)) req.url = '/index.html';

    if (serveStatic) {
      serveStatic(req, res, () => {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Client not built. Run `npm run build` first.');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reject = (status: number, why: string) => {
      log('ws_reject', { why, origin: req.headers.origin });
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return reject(404, 'path');

    // 防跨站 WebSocket 劫持：浏览器一定会带 Origin，只允许同源。没有 Origin 的是非浏览器客户端（如回归脚本）。
    const origin = req.headers.origin;
    if (origin) {
      let ok = allowed.has(origin);
      try {
        ok ||= new URL(origin).host === req.headers.host;
      } catch {
        ok = false;
      }
      if (!ok) return reject(403, 'origin');
    }

    const ip = clientIp(req);
    const count = ipConns.get(ip) ?? 0;
    if (count >= maxConnsPerIp) return reject(429, 'too_many_connections');

    wss.handleUpgrade(req, socket, head, (ws) => {
      ipConns.set(ip, count + 1);
      ws.on('close', () => {
        const c = (ipConns.get(ip) ?? 1) - 1;
        if (c <= 0) ipConns.delete(ip);
        else ipConns.set(ip, c);
      });
      handleConnection(ws, ip, { manager, now, log, joinLimiter });
    });
  });

  return {
    server,
    manager,
    // 监听失败（端口被占用、无权限）时 reject，交给调用方给出可读的提示，而不是抛出未处理的 'error' 事件
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen(opts.port ?? 8080, opts.host, () => {
          server.off('error', onError);
          manager.start();
          resolve((server.address() as AddressInfo).port);
        });
      }),
    shutdown: () =>
      new Promise((resolve) => {
        manager.stop();
        for (const room of manager.rooms.values()) room.closeAll(CloseCode.ServerRestart, 'server_restart');
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
