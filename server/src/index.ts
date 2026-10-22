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

let port: number;
try {
  port = await app.listen();
} catch (err) {
  // 给验收者看的提示：中英双语（中文版 Windows 的命令行默认不是 UTF-8，中文可能显示为乱码）
  const code = (err as NodeJS.ErrnoException).code;
  const want = process.env.PORT ?? '8080';
  if (code === 'EADDRINUSE') {
    console.error(
      `\n端口 ${want} 已被占用。请换一个端口启动，例如：\n` +
        `  macOS / Linux：PORT=8081 ./start.sh   （源码目录下：PORT=8081 npm start）\n` +
        `  Windows：set PORT=8081 后再运行 start.bat\n` +
        `Port ${want} is already in use. Start on another port, e.g. PORT=8081 ./start.sh (Windows: set PORT=8081, then start.bat)\n`,
    );
  } else if (code === 'EACCES') {
    console.error(`\n没有权限监听端口 ${want}，请改用 1024 以上的端口，例如 PORT=8081。\nPermission denied for port ${want}; use a port above 1024, e.g. PORT=8081.\n`);
  } else {
    console.error('启动失败 / failed to start:', err);
  }
  process.exit(1);
}
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
