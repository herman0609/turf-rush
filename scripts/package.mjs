// 制作免安装发行包：release/turf-rush-app/
//   server/dist/index.js  服务端（含 ws、sirv、zod 等全部依赖的单文件）
//   client/dist/          前端静态资源（不含 sourcemap）
//   tools/bots.js         机器人：往房间里加人，一个人也能验收 4 人局
//   tools/sim.js          回归测试：两名机器人跑完整两局并断言各端一致
//   start.sh / start.command / start.bat、package.json、运行说明.txt
// 只需要 Node.js，不需要 npm install。用法：npm run package（会先构建）
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'turf-rush-app');
const need = [join(root, 'server/dist/index.js'), join(root, 'client/dist/index.html')];
for (const f of need) {
  if (!existsSync(f)) {
    console.error(`缺少构建产物 ${f}，请先运行 npm run build（npm run package 会自动构建）`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'server/dist'), { recursive: true });
cpSync(join(root, 'server/dist/index.js'), join(out, 'server/dist/index.js'));
cpSync(join(root, 'client/dist'), join(out, 'client/dist'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

// 机器人与回归脚本：与服务端同样打成单文件 ESM（ws 是 CJS，借助 createRequire）
const banner = { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" };
for (const [entry, file] of [
  ['scripts/bots.ts', 'tools/bots.js'],
  ['scripts/sim-match.ts', 'tools/sim.js'],
]) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, file),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['bufferutil', 'utf-8-validate'],
    banner,
    logLevel: 'warning',
  });
}

const write = (rel, text, exec = false) => {
  const p = join(out, rel);
  writeFileSync(p, text);
  if (exec) chmodSync(p, 0o755);
};

write(
  'package.json',
  JSON.stringify(
    {
      name: 'turf-rush-app',
      version: '1.0.0',
      private: true,
      description: '60 秒抢地盘：免安装运行包（服务端已打包成单文件，无需 npm install）',
      type: 'module',
      engines: { node: '>=18' },
      scripts: {
        start: 'node server/dist/index.js',
        bots: 'node tools/bots.js',
        sim: 'node tools/sim.js',
      },
    },
    null,
    2,
  ) + '\n',
);

const sh = `#!/bin/sh
# 60 秒抢地盘：本地启动（macOS / Linux）。需要 Node.js 18 或更高版本。
# 换端口：PORT=8081 ./start.sh      改每局时长：MATCH_SECONDS=30 ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 node，请先安装 Node.js 18 或更高版本（推荐 LTS）：https://nodejs.org"
  exit 1
fi
PORT="\${PORT:-8080}"
echo "启动中……就绪后用浏览器打开 http://localhost:$PORT"
echo "同一台电脑上开两个普通标签页就是两名玩家；同一局域网的其他设备可访问 http://<本机IP>:$PORT"
echo "按 Ctrl+C 停止"
PORT="$PORT" NODE_ENV=production exec node server/dist/index.js
`;
write('start.sh', sh, true);
write('start.command', sh, true);

const bat = [
  '@echo off',
  'rem Turf Rush: local start on Windows. Requires Node.js 18+',
  'rem Change port: run "set PORT=8081" in this window first, then start.bat',
  'cd /d "%~dp0"',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo Node.js not found. Please install Node.js 18 or newer (LTS recommended): https://nodejs.org',
  '  pause',
  '  exit /b 1',
  ')',
  'if "%PORT%"=="" set PORT=8080',
  'set NODE_ENV=production',
  'echo Starting... then open http://localhost:%PORT% in your browser (two tabs = two players). Press Ctrl+C to stop.',
  'node server\\dist\\index.js',
  'pause',
  '',
].join('\r\n');
write('start.bat', bat);

write(
  '运行说明.txt',
  `60 秒抢地盘 · 免安装运行包
==========================

需要：Node.js 18 或更高版本（https://nodejs.org，装 LTS 即可；已实测 18.20、20.20、22）。不需要 npm install，也不需要联网。
查看版本：在终端运行 node -v

启动
  macOS / Linux：在终端进入本目录，运行 ./start.sh
                 （提示 Permission denied 时改用 sh start.sh）
  macOS 也可以双击 start.command；如果提示"无法验证开发者"，右键 → 打开，或改用终端
  Windows：双击 start.bat
  任何系统：node server/dist/index.js

然后用浏览器打开 http://localhost:8080 。
  - 同一台电脑上开两个普通标签页 = 两名玩家（身份存在各标签页的 sessionStorage 里）
  - 同一局域网的手机或其他电脑：打开 http://<本机IP>:8080
    （macOS 查看 IP：系统设置 → 网络；Windows：ipconfig。首次运行时系统防火墙可能询问是否允许 node 接受连接，请选允许）

可选环境变量
  PORT=8081           换端口（端口被占用时，启动会提示）
  MATCH_SECONDS=30    每局时长，默认 60 秒
  Windows 写法：先在命令行执行 set PORT=8081，再运行 start.bat

一个人验收：用机器人凑人数（另开一个终端）
  node tools/bots.js 房间码 3                                    加 3 个机器人，凑满 4 人局
  node tools/bots.js 房间码 1 --url http://localhost:8081        服务不在 8080 时指定地址
  机器人会自动准备、移动、冲刺，结算后自动再来一局；按 Ctrl+C 退出（会主动离开房间）

回归测试：两个机器人跑完整两局，断言所有端结果一致
  node tools/sim.js                                               自带一个临时服务，约 20 秒
  SIM_URL=http://localhost:8080 node tools/sim.js                 对已经启动的服务测试（按默认 60 秒一局，约 2.5 分钟；
                                                                  启动时改过 MATCH_SECONDS 的话，用 SIM_SECONDS 设成相同的值）
  Windows：先 set SIM_URL=http://localhost:8080 ，再 node tools\\sim.js
  通过时最后一行是"✅ 回归测试通过"，失败时进程退出码非 0

弱网演示：在浏览器地址后加 ?lag=200&jitter=40&chaos=1 ，调试面板会自动打开（也可以随时按 \` 键）。

完整的功能说明与验收步骤见压缩包里的 验收说明.md、README.md 和 docs/功能说明.md。
`,
);

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push([p.slice(out.length + 1), statSync(p).size]);
  }
};
walk(out);
for (const [f, size] of files.sort()) console.log(`${(size / 1024).toFixed(0).padStart(6)} KB  ${f}`);
console.log(`\n发行包已生成：${out}`);
