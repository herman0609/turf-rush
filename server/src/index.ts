import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { jsonLogger } from './log';

// 源码（server/src）和构建产物（server/dist）都在仓库下两层，指向 client/dist
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.STATIC_DIR ?? resolve(here, '../../client/dist');

const app = createApp({
  port: Number(process.env.PORT ?? 8080),
  staticDir,
  matchSeconds: Number(process.env.MATCH_SECONDS ?? 60),
  trustProxy: process.env.TRUST_PROXY === '1',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  log: jsonLogger,
});

const port = await app.listen();
jsonLogger('listen', { port, staticDir, url: `http://localhost:${port}` });

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  jsonLogger('shutdown', { signal });
  // 通知所有客户端"服务器重启，房间已失效"，然后退出
  await Promise.race([app.shutdown(), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
