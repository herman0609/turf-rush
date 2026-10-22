// 回归测试：启动服务（或连接 SIM_URL 指定的线上服务），两个机器人完整走一遍
// 建房 → 加入 → 准备 → 开始 → 对局（含作弊/重复输入）→ 结算 → 再来一局 → 第二局结算。
// 断言：两端看到的结果一致；客户端用增量重建的棋盘与服务端终局校验和一致；tick 无缺口；作弊消息被拒绝。
//
// 用法：npm run sim
//       SIM_URL=https://xxx.onrender.com npm run sim   （线上冒烟，对局按线上配置的 60 秒）

import WebSocket from 'ws';
import { PROTOCOL_VERSION, type Dir } from '@turf/shared/constants';
import type { C2S, ResultView, S2C } from '@turf/shared/protocol';
import { ClientSync } from '../client/src/sync';
import { createApp, type App } from '../server/src/app';
import { silentLogger } from '../server/src/log';

const REMOTE = process.env.SIM_URL?.replace(/\/$/, '');
// 本地自带服务时对局缩短为 5 秒；连线上服务时对局时长由服务端决定（默认 60 秒），超时按它来算
const MATCH_SECONDS = Number(process.env.SIM_SECONDS ?? (REMOTE ? 60 : 5));
const ROUNDS = Number(process.env.SIM_ROUNDS ?? 2);

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class AssertionError extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

class Bot {
  ws!: WebSocket;
  sync = new ClientSync();
  you = '';
  token = '';
  seq = 0;
  errors: Extract<S2C, { t: 'error' }>[] = [];
  closed: { code: number; reason: string } | null = null;
  dropped = 0;
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];

  constructor(
    readonly name: string,
    private readonly wsUrl: string,
  ) {}

  connect(code: string, token?: string): Promise<void> {
    this.ws = new WebSocket(this.wsUrl);
    this.closed = null;
    this.ws.on('message', (data) => this.onMessage(JSON.parse(data.toString()) as S2C));
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.notify();
    });
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        this.send({ t: 'join', v: PROTOCOL_VERSION, code, name: this.name, token });
        resolve();
      });
      this.ws.once('error', reject);
    });
  }

  private onMessage(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.token = msg.token;
        this.seq = 0;
        break;
      case 'snapshot':
        this.sync.applySnapshot(msg);
        break;
      case 'room':
        this.sync.applyRoom(msg);
        break;
      case 'tick': {
        const r = this.sync.applyTick(msg);
        if (r === 'gap' || r === 'mismatch') this.send({ t: 'resync' });
        break;
      }
      case 'pong':
        this.dropped = msg.dropped;
        break;
      case 'error':
        this.errors.push(msg);
        break;
    }
    this.notify();
  }

  private notify(): void {
    this.waiters = this.waiters.filter((w) => {
      if (!w.pred()) return true;
      w.resolve();
      return false;
    });
  }

  waitFor(what: string, pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AssertionError(`${this.name}: 等待「${what}」超时`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  send(msg: C2S | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  input(cmd: { dir?: Dir; dash?: true }): void {
    this.send({ t: 'input', seq: ++this.seq, ...cmd });
  }

  get phase() {
    return this.sync.room?.phase;
  }

  get result(): ResultView | null {
    return this.sync.room?.lastResult ?? null;
  }

  member(id = this.you) {
    return this.sync.room?.members.find((m) => m.id === id);
  }

  close(): void {
    this.ws.close();
  }
}

/** 在对局中随机转向/冲刺，模拟真人 */
function drive(bot: Bot, seed: number): () => void {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const dirs: Dir[] = ['U', 'D', 'L', 'R'];
  const timer = setInterval(() => {
    if (bot.phase !== 'playing' || bot.ws.readyState !== WebSocket.OPEN) return;
    if (rand() < 0.08) bot.input({ dash: true });
    else bot.input({ dir: dirs[Math.floor(rand() * 4)]! });
  }, 180);
  return () => clearInterval(timer);
}

interface RoundOpts {
  code: string;
  /** 第 1 局：作弊/重复输入检查 */
  cheat?: boolean;
  /** 第 2 局：乙断线后用 token 重连；丙中途加入观战 */
  lifecycle?: Bot;
}

async function playRound(a: Bot, b: Bot, round: number, opts: RoundOpts): Promise<ResultView> {
  const { cheat = false, lifecycle: c } = opts;
  await Promise.all([a, b].map((x) => x.waitFor(`第 ${round} 局倒计时`, () => x.phase === 'countdown' && x.sync.round === round)));
  log(`第 ${round} 局：3-2-1 倒计时`);
  await Promise.all([a, b].map((x) => x.waitFor('开始', () => x.phase === 'playing', 6000)));
  log(`第 ${round} 局：开始，双方随机操作`);
  const stops = [drive(a, 7 + round), drive(b, 99 + round)];

  if (cheat) {
    await sleep(600);
    const errorsBefore = b.errors.length;
    // 1) 试图上报位置/分数：schema 拒绝
    b.send({ t: 'input', seq: 999_999, dir: 'U', x: 0, y: 0, score: 640 });
    b.send({ t: 'score', value: 640 });
    // 2) 非法 JSON
    b.sendRaw('{not json');
    // 3) 重复与过期的 seq：直接丢弃
    const s = ++b.seq;
    b.send({ t: 'input', seq: s, dir: 'L' });
    b.send({ t: 'input', seq: s, dir: 'L' });
    b.send({ t: 'input', seq: s - 1, dir: 'R' });
    b.send({ t: 'ping', c: Date.now() });
    await b.waitFor('作弊消息被拒绝', () => b.errors.length >= errorsBefore + 3);
    await b.waitFor('重复输入被计数', () => b.dropped >= 2, 3000);
    assert(b.errors.slice(errorsBefore).every((e) => e.code === 'BAD_MSG'), '非法消息应返回 BAD_MSG');
    log(`作弊检查：${b.errors.length - errorsBefore} 条非法消息被拒绝，${b.dropped} 条重复/过期输入被丢弃，连接仍然保持`);
  }

  if (c) {
    // 中途加入：以观战身份进入，能看到当前对局
    await sleep(300);
    await c.connect(opts.code);
    await c.waitFor('丙进入观战', () => c.phase === 'playing' && !!c.member());
    assert(c.member()!.role === 'spectator', '对局中加入的人应是观战者');
    assert(c.sync.game !== null && c.sync.game.players.every((p) => p.id !== c.you), '观战者能看到对局但不在场上');
    log('丙在对局中加入：以观战身份进入，收到当前对局的全量快照');

    // 掉线：直接断开 TCP，不发 leave
    const bid = b.you;
    b.ws.terminate();
    await a.waitFor('甲看到乙掉线', () => a.member(bid)?.online === false && a.member(bid)?.offlineUntil !== null);
    const left = Math.round((a.member(bid)!.offlineUntil! - Date.now()) / 1000);
    await a.waitFor('乙的角色被冻结', () => a.sync.game?.players.find((p) => p.id === bid)?.frozen === true, 2000);
    log(`乙掉线：甲看到「机器人乙 掉线，重连中 ${left}s」，乙的角色原地冻结`);

    // 重连：同一个 token 建立新连接，恢复同一个座位
    await sleep(1200);
    await b.connect(opts.code, b.token);
    await b.waitFor('乙重连成功', () => b.you === bid && b.phase === 'playing' && b.member()?.online === true);
    await a.waitFor('甲看到乙回来', () => a.member(bid)?.online === true);
    await a.waitFor('乙的角色解冻', () => a.sync.game?.players.find((p) => p.id === bid)?.frozen === false, 2000);
    log('乙用 token 重连：恢复原座位（同一 playerId），收到全量快照，继续操作');
  }

  const timeout = (MATCH_SECONDS + 15) * 1000;
  const everyone = c ? [a, b, c] : [a, b];
  await Promise.all(everyone.map((x) => x.waitFor(`第 ${round} 局结算`, () => x.phase === 'result' && x.result?.round === round, timeout)));
  stops.forEach((s) => s());

  const ra = a.result!;
  const rb = b.result!;
  assert(JSON.stringify(ra) === JSON.stringify(rb), '两端的结算结果必须完全一致');
  assert(ra.reason === 'time', `第 ${round} 局应因时间结束，实际是 ${ra.reason}`);
  for (const x of everyone) {
    assert(JSON.stringify(x.result) === JSON.stringify(ra), `${x.name}：结算结果与其他人不一致`);
    assert(x.sync.localChecksum() === ra.sum, `${x.name}：增量重建的棋盘与服务端终局校验和不一致`);
    assert(x.sync.stats.mismatches === 0, `${x.name}：出现 ${x.sync.stats.mismatches} 次校验和不一致`);
  }
  const total = ra.ranking.reduce((s, r) => s + r.score, 0);
  const winners = ra.winners.map((id) => ra.ranking.find((r) => r.id === id)!.name);
  log(
    `第 ${round} 局结算：${ra.ranking.map((r) => `${r.name} ${r.score} 格`).join(' vs ')}，` +
      (winners.length > 1 ? `平局（${winners.join('、')}）` : `${winners[0]} 获胜`),
  );
  log(
    `一致性：${everyone.length} 端结算相同，本地重建校验和 = 服务端 ${ra.sum.toString(16)}，共涂 ${total} 格，` +
      `tick 缺口 ${everyone.map((x) => `${x.name.slice(-1)}=${x.sync.stats.gaps}`).join(' ')}`,
  );
  return ra;
}

async function main(): Promise<void> {
  let app: App | null = null;
  let base = REMOTE;
  if (!base) {
    app = createApp({ port: 0, host: '127.0.0.1', staticDir: null, matchSeconds: MATCH_SECONDS, log: silentLogger });
    const port = await app.listen();
    base = `http://127.0.0.1:${port}`;
    log(`本地服务已启动 ${base}（对局 ${MATCH_SECONDS} 秒）`);
  } else {
    log(`连接线上服务 ${base}`);
  }
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';

  const a = new Bot('机器人甲', wsUrl);
  const b = new Bot('机器人乙', wsUrl);
  const c = new Bot('机器人丙', wsUrl);
  try {
    const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
    assert(res.status === 201, `建房失败：HTTP ${res.status}`);
    const { code } = (await res.json()) as { code: string };
    log(`建房成功，房间码 ${code}`);

    // 无效房间码
    const bad = new Bot('路人', wsUrl);
    await bad.connect('ZZZZZ');
    await bad.waitFor('无效房间码提示', () => bad.errors.some((e) => e.code === 'ROOM_NOT_FOUND'));
    bad.close();
    log('无效房间码：收到 ROOM_NOT_FOUND');

    await a.connect(code);
    await a.waitFor('甲进入大厅', () => a.phase === 'lobby' && !!a.you);
    await b.connect(code);
    await b.waitFor('乙进入大厅', () => b.phase === 'lobby' && !!b.you);
    await a.waitFor('甲看到乙', () => (a.sync.room?.members.length ?? 0) === 2);
    assert(a.sync.room!.hostId === a.you, '先进房的甲应是房主');
    log(`甲（房主）与乙进入大厅，双方都看到 2 名玩家`);

    // 未准备就开始：被拒绝
    a.send({ t: 'start' });
    await a.waitFor('未准备时拒绝开始', () => a.errors.some((e) => e.code === 'NOT_ALLOWED'));
    log(`未准备就开始：被拒绝（${a.errors.at(-1)!.msg}）`);

    b.send({ t: 'ready', ready: true });
    await a.waitFor('甲看到乙已准备', () => a.member(b.you)?.ready === true);
    a.send({ t: 'start' });

    for (let round = 1; round <= ROUNDS; round++) {
      await playRound(a, b, round, { code, cheat: round === 1, lifecycle: round === 2 ? c : undefined });
      if (round < ROUNDS) {
        b.send({ t: 'rematch' });
        b.send({ t: 'rematch' }); // 重复点击无害
        await Promise.all([a, b].map((x) => x.waitFor('回到大厅', () => x.phase === 'lobby')));
        assert(b.member()?.ready === true, '点击再来一局的人应自动准备');
        assert(a.sync.room!.code === code, '再来一局应留在同一房间');
        log('乙点击「再来一局」：同一房间回到大厅并自动准备，甲开始下一局');
        a.send({ t: 'start' });
      }
    }

    if (ROUNDS >= 2) {
      // 观战者在下一局补位成为玩家
      b.send({ t: 'rematch' });
      await c.waitFor('丙补位成为玩家', () => c.phase === 'lobby' && c.member()?.role === 'player');
      assert(c.member()!.slot !== null, '补位后应分配颜色座位');
      log('回到大厅：观战的丙自动补位成为玩家（3/4）');
    }

    // 主动离开：房主移交
    a.send({ t: 'leave' });
    await b.waitFor('房主移交给乙', () => b.sync.room?.hostId === b.you);
    await b.waitFor('甲已移出房间', () => !b.sync.room?.members.some((m) => m.id === a.you));
    log('甲主动离开：立即移出房间，房主移交给乙');
    log('✅ 回归测试通过');
  } finally {
    a.close();
    b.close();
    if (c.ws) c.close();
    await app?.shutdown();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n❌ 回归测试失败：${err instanceof Error ? err.message : String(err)}`);
    if (!(err instanceof AssertionError)) console.error(err);
    process.exit(1);
  },
);
