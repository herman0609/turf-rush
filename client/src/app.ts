// 客户端总控制器：路由 → 连接 → 消息 → 视图。
// 原则：界面只是服务端状态的投影；本地只保存身份（sessionStorage）和"我已看过的结算"这类纯展示状态。

import { PROTOCOL_VERSION, SEAT_GRACE_MS, type Dir } from '@turf/shared/constants';
import type { RoomView, S2C } from '@turf/shared/protocol';
import { normalizeRoomCode } from '@turf/shared/util';
import { installAudioUnlock, sfx } from './audio';
import { DebugPanel, type DebugRow } from './debug';
import { clear, copyText, setNetBar, toast } from './dom';
import { NetView } from './motion';
import { Connection, wsUrl } from './net';
import * as session from './session';
import { Stage } from './stage';
import { ClientSync } from './sync';
import { connectingView, homeView, joinView, lobbyView, messageView } from './views';

type View = 'home' | 'join' | 'connecting' | 'lobby' | 'stage' | 'message';

/** 意外断线后的重连间隔：0.5s → 1s → 2s → 4s → 4s …，总时长不超过座位保留时间 */
const RETRY_DELAYS = [500, 1000, 2000, 4000];

const KEYMAP: Record<string, Dir> = {
  ArrowUp: 'U',
  KeyW: 'U',
  ArrowDown: 'D',
  KeyS: 'D',
  ArrowLeft: 'L',
  KeyA: 'L',
  ArrowRight: 'R',
  KeyD: 'R',
};

export class App {
  private view: View = 'home';
  private conn: Connection | null = null;
  private sync = new ClientSync();
  private code: string | null = null;
  private name = '';
  private you: string | null = null;
  private retry: { attempt: number; since: number; timer: number } | null = null;
  /** 掉线提示延迟 1.5 秒：刷新页面这种秒回的情况不打扰其他人 */
  private offlineToasts = new Map<string, number>();
  private justWelcomed = false;
  private seq = 0;
  private stage: Stage | null = null;
  private raf = 0;
  private lobbyTimer = 0;
  private resyncAt = 0;
  /** 已经亲眼看到"结算"的局号（中途进入大厅的人不弹旧结算） */
  private resultSeenRound = -1;
  /** 用户已关闭结算层的局号 */
  private dismissedRound = -1;
  /** 插值 + 预测：把权威状态变成每帧要画的样子 */
  private net = new NetView();
  private debug: DebugPanel | null = null;
  private fps = 0;
  private fpsFrames = 0;
  private fpsAt = 0;

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    window.addEventListener('popstate', () => this.route());
    window.addEventListener('keydown', (e) => this.onKey(e));
    installAudioUnlock();
    this.debug = new DebugPanel();
    window.setInterval(() => this.updateDebug(), 250);
    window.addEventListener('resize', () => {
      if (this.stage && this.sync.game) this.stage.layout(this.sync.game, true);
    });
    // 网络恢复时不必等退避计时，立即重连
    window.addEventListener('online', () => {
      if (this.retry) {
        window.clearTimeout(this.retry.timer);
        this.openSocket();
      }
    });
    this.route();
  }

  // ------------------------------------------------------------------ 路由

  private navigate(path: string): void {
    // 保留查询参数（?lag / ?debug 等），刷新后仍是同样的调试环境；邀请链接不带这些参数
    if (location.pathname !== path) history.pushState(null, '', path + location.search);
    this.route();
  }

  private route(): void {
    const m = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
    if (!m) {
      this.disconnect();
      this.code = null;
      document.title = '60 秒抢地盘';
      this.showHome();
      return;
    }
    const raw = decodeURIComponent(m[1]!);
    const code = normalizeRoomCode(raw);
    if (!code) {
      this.disconnect();
      this.showNotFound(raw);
      return;
    }
    if (this.code === code && this.conn && !this.conn.closed) return;
    this.disconnect();
    this.code = code;
    document.title = `房间 ${code} · 60 秒抢地盘`;
    if (session.getIdentity(code) || session.consumeCreated(code)) this.connect(code, session.getNickname());
    else void this.showJoin(code);
  }

  private mount(el: HTMLElement, view: View): void {
    window.clearTimeout(this.lobbyTimer);
    clear(this.root);
    this.root.append(el);
    this.view = view;
  }

  // ------------------------------------------------------------------ 页面

  private showHome(): void {
    this.mount(
      homeView({
        name: session.getNickname(),
        onCreate: (name) => this.createAndGo(name),
        onJoin: (name, code) => {
          session.saveNickname(name);
          session.markCreated(code); // 首页已经确认过昵称，进房后不再二次确认
          this.navigate(`/r/${code}`);
        },
      }),
      'home',
    );
  }

  private async createAndGo(name: string): Promise<void> {
    try {
      session.saveNickname(name);
      const code = await session.createRoom();
      session.markCreated(code);
      this.navigate(`/r/${code}`);
    } catch (err) {
      toast((err as Error).message || '创建失败，请重试', 'warn');
    }
  }

  private async showJoin(code: string): Promise<void> {
    this.mount(connectingView('正在查找房间…'), 'connecting');
    try {
      const status = await session.getRoomStatus(code);
      if (this.code !== code) return;
      if (!status.exists) return this.showNotFound(code);
      this.mount(
        joinView({
          code,
          name: session.getNickname(),
          status,
          onJoin: (name) => {
            session.saveNickname(name);
            this.connect(code, name);
          },
          onHome: () => this.navigate('/'),
        }),
        'join',
      );
    } catch (err) {
      this.showMessage('网络好像出了点问题', (err as Error).message, [
        { label: '重试', primary: true, onClick: () => void this.showJoin(code) },
        { label: '返回首页', onClick: () => this.navigate('/') },
      ]);
    }
  }

  private showNotFound(code: string): void {
    if (this.code) session.clearIdentity(this.code);
    this.code = null;
    this.showMessage(
      '房间不存在或已失效',
      `房间码「${code}」可能输错了，或者房间因长时间无人已被清理（服务重启也会让房间失效）。`,
      [
        { label: '创建新房间', primary: true, onClick: () => void this.createAndGo(session.getNickname()) },
        { label: '返回首页', onClick: () => this.navigate('/') },
      ],
    );
  }

  private showMessage(title: string, text: string, actions: Parameters<typeof messageView>[0]['actions']): void {
    this.mount(messageView({ title, text, actions }), 'message');
  }

  // ------------------------------------------------------------------ 连接

  /** 进入房间：重置本地状态并建立连接（有 token 时自动作为重连） */
  private connect(code: string, name: string): void {
    this.disconnect();
    this.code = code;
    this.name = name;
    this.sync = new ClientSync();
    // 每个被应用的 tick（包括乱序重排后补上的）都要喂给插值历史和特效，不能只看"最后一条"
    this.sync.onApplied = (g, round) => {
      this.net.onTick(g, this.you);
      this.stage?.onTick(g, round, performance.now());
    };
    this.net = new NetView();
    this.you = null;
    this.stage = null;
    this.mount(connectingView('正在进入房间…'), 'connecting');
    this.openSocket();
  }

  /** 建立一条新的 WebSocket。重连时复用当前画面，收到快照后整体刷新。 */
  private openSocket(): void {
    const code = this.code;
    if (!code) return;
    const name = this.name;
    this.conn?.close();
    const conn = new Connection(wsUrl(), {
      onOpen: () => {
        const id = session.getIdentity(code);
        conn.send({ t: 'join', v: PROTOCOL_VERSION, code, name, token: id?.token });
      },
      onMessage: (msg) => {
        if (conn === this.conn) this.onMessage(conn, code, name, msg);
      },
      onClose: (wsCode, reason) => {
        if (conn === this.conn) this.onClose(code, wsCode, reason);
      },
    });
    this.conn = conn;
  }

  private disconnect(): void {
    const c = this.conn;
    this.conn = null;
    c?.close();
    this.stopRetry();
    this.offlineToasts.forEach((t) => window.clearTimeout(t));
    this.offlineToasts.clear();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private stopRetry(): void {
    if (this.retry) window.clearTimeout(this.retry.timer);
    this.retry = null;
    setNetBar(null);
  }

  private scheduleReconnect(code: string): void {
    const now = performance.now();
    this.retry ??= { attempt: 0, since: now, timer: 0 };
    const r = this.retry;
    if (now - r.since > SEAT_GRACE_MS) {
      this.stopRetry();
      this.showMessage('重连失败', '30 秒内没能连上服务器，座位已经释放。网络恢复后可以重新加入。', [
        { label: '重新加入', primary: true, onClick: () => this.connect(code, session.getNickname()) },
        { label: '返回首页', onClick: () => this.navigate('/') },
      ]);
      return;
    }
    const delay = RETRY_DELAYS[Math.min(r.attempt, RETRY_DELAYS.length - 1)]!;
    r.attempt++;
    setNetBar(`连接中断，正在重连…（第 ${r.attempt} 次）`);
    r.timer = window.setTimeout(() => this.openSocket(), delay);
  }

  private onMessage(conn: Connection, code: string, name: string, msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.seq = 0; // seq 按连接计数，服务端同样在新连接上归零
        this.net.resetInputs(); // 旧连接上没确认的输入随旧连接作废
        session.setIdentity(code, { playerId: msg.you, token: msg.token });
        if (this.retry) {
          this.stopRetry();
          toast('已重新连接', 'ok', 1500);
        }
        this.justWelcomed = true;
        return;
      case 'snapshot': {
        const prev = this.sync.room;
        this.sync.applySnapshot(msg);
        if (this.sync.game) this.net.onSnapshot(this.sync.game);
        this.resyncAt = 0;
        if (this.justWelcomed) {
          this.justWelcomed = false;
          this.greet(msg.room);
        } else if (prev) this.announce(prev, msg.room);
        this.render();
        if (this.stage && this.sync.game) this.stage.onSnapshot(this.sync.game, this.sync.round, performance.now());
        return;
      }
      case 'room': {
        const prev = this.sync.room;
        if (this.sync.applyRoom(msg)) {
          if (prev) this.announce(prev, msg.room);
          this.render();
        }
        return;
      }
      case 'tick': {
        // 应用（以及乱序补齐）时由 sync.onApplied 驱动插值与特效；这里只处理需要快照的情况
        const r = this.sync.applyTick(msg);
        if (r === 'gap' || r === 'mismatch') this.requestResync(conn);
        return;
      }
      case 'error':
        this.onServerError(conn, code, name, msg);
        return;
      case 'pong':
        return;
    }
  }

  private requestResync(conn: Connection): void {
    const now = performance.now();
    if (now - this.resyncAt < 1500) return;
    this.resyncAt = now;
    conn.send({ t: 'resync' });
  }

  private onServerError(conn: Connection, code: string, name: string, msg: Extract<S2C, { t: 'error' }>): void {
    switch (msg.code) {
      case 'ROOM_NOT_FOUND':
        this.disconnect();
        this.showNotFound(code);
        return;
      case 'TOKEN_INVALID':
        // 座位已过期（例如掉线超过 30 秒）：作为新玩家重新加入
        session.clearIdentity(code);
        toast('之前的座位已失效，已作为新玩家加入', 'warn');
        conn.send({ t: 'join', v: PROTOCOL_VERSION, code, name });
        return;
      case 'ROOM_FULL':
        this.disconnect();
        this.showMessage('房间已满', '玩家和观战席位都满了，可以稍后再试，或者自己开一个房间。', [
          { label: '创建新房间', primary: true, onClick: () => void this.createAndGo(session.getNickname()) },
          { label: '返回首页', onClick: () => this.navigate('/') },
        ]);
        return;
      case 'OUTDATED':
        this.disconnect();
        this.showMessage('游戏已更新', '服务器上的版本比你的页面新，刷新一下就好。', [
          { label: '刷新页面', primary: true, onClick: () => location.reload() },
        ]);
        return;
      default:
        toast(msg.msg, 'warn');
    }
  }

  private onClose(code: string, wsCode: number, reason: string): void {
    this.conn = null;
    if (wsCode === 4001) {
      this.stopRetry();
      this.showMessage('你在另一个页面打开了这个房间', '同一个座位同时只能在一个页面里玩（复制标签页会带上同一个身份）。', [
        { label: '在这里继续', primary: true, onClick: () => this.connect(code, session.getNickname()) },
        {
          label: '以新玩家加入',
          onClick: () => {
            session.clearIdentity(code);
            this.connect(code, session.getNickname());
          },
        },
        { label: '返回首页', onClick: () => this.navigate('/') },
      ]);
      return;
    }
    if (wsCode === 4002) return; // 主动离开
    if (wsCode === 1012 || reason === 'room_expired') {
      this.stopRetry();
      session.clearIdentity(code);
      this.showMessage(
        wsCode === 1012 ? '服务器刚刚重启' : '房间已失效',
        '房间只保存在服务器内存里，重启或长时间无人后就会失效。重新开一个房间吧。',
        [
          { label: '创建新房间', primary: true, onClick: () => void this.createAndGo(session.getNickname()) },
          { label: '返回首页', onClick: () => this.navigate('/') },
        ],
      );
      return;
    }
    // 意外断线：已经在房间里，就带着 token 自动重连；否则（例如首次就连不上）让用户手动重试
    if (wsCode !== 4008 && this.sync.room && session.getIdentity(code)) {
      this.scheduleReconnect(code);
      return;
    }
    this.stopRetry();
    this.showMessage('连接已断开', wsCode === 4008 ? `连接因异常被服务器断开（${reason}）。` : '没能连上服务器，请检查网络后重试。', [
      { label: '重新连接', primary: true, onClick: () => this.connect(code, session.getNickname()) },
      { label: '返回首页', onClick: () => this.navigate('/') },
    ]);
  }

  // ------------------------------------------------------------------ 视图投影

  /** 刚进入（或重连进入）房间时的说明 */
  private greet(room: RoomView): void {
    const me = room.members.find((m) => m.id === this.you);
    if (me?.role !== 'spectator') return;
    if (room.phase === 'countdown' || room.phase === 'playing') toast('对局进行中，你正在观战，下一局自动加入', 'info', 4000);
    else toast('房间已满 4 人，你正在观战，有空位时自动加入', 'info', 4000);
  }

  /** 对比前后两个房间状态，提示成员变化 */
  private announce(prev: RoomView, next: RoomView): void {
    if (prev.code !== next.code) return;
    const before = new Map(prev.members.map((m) => [m.id, m]));
    const after = new Set(next.members.map((m) => m.id));
    for (const m of next.members) {
      const p = before.get(m.id);
      if (m.id === this.you) {
        if (p?.role === 'spectator' && m.role === 'player') toast('有空位了，你已加入下一局', 'ok');
        continue;
      }
      if (!p) {
        toast(m.role === 'spectator' ? `${m.name} 进来观战了` : `${m.name} 加入了房间`);
        sfx.join();
      }
      else if (!p.left && m.left) toast(m.online || p.online ? `${m.name} 离开了房间` : `${m.name} 未能重连，已离开本局`, 'warn');
      else if (p.online && !m.online && !m.left) {
        const name = m.name;
        this.offlineToasts.set(
          m.id,
          window.setTimeout(() => {
            this.offlineToasts.delete(m.id);
            toast(`${name} 掉线了，等待重连…`, 'warn');
          }, 1500),
        );
      } else if (!p.online && m.online) {
        const pending = this.offlineToasts.get(m.id);
        if (pending !== undefined) {
          window.clearTimeout(pending);
          this.offlineToasts.delete(m.id);
        } else toast(`${m.name} 回来了`, 'ok');
      }
    }
    for (const p of prev.members) {
      if (after.has(p.id) || p.left || p.id === this.you) continue;
      toast(p.online ? `${p.name} 离开了房间` : `${p.name} 未能重连，已移出房间`, 'warn');
    }
    if (prev.hostId !== next.hostId && next.hostId) {
      const host = next.members.find((m) => m.id === next.hostId);
      toast(next.hostId === this.you ? '你现在是房主' : `${host?.name ?? '?'} 成为了房主`, 'info');
    }
  }

  private me() {
    return this.sync.room?.members.find((m) => m.id === this.you);
  }

  private render(): void {
    const room = this.sync.room;
    if (!room) return;
    const res = room.lastResult;
    if (room.phase === 'result' && res) this.resultSeenRound = res.round;

    if (room.phase === 'countdown' || room.phase === 'playing') {
      this.showStage(room);
      this.stage?.hideResult();
    } else if (res && this.sync.game && (room.phase === 'result' || (this.resultSeenRound === res.round && this.dismissedRound !== res.round))) {
      this.showStage(room);
      this.stage?.showResult(room, this.you);
    } else {
      this.showLobby(room);
    }
  }

  private showStage(room: RoomView): void {
    if (!this.sync.game) {
      if (this.conn) this.requestResync(this.conn);
      return;
    }
    if (!this.stage) {
      this.stage = new Stage({
        onRematch: () => this.onRematch(),
        onLeave: () => this.leave(),
        onDir: (dir) => this.sendDir(dir),
        onDash: () => this.sendDash(),
      });
    }
    if (this.stage.round !== this.sync.round) this.stage.newRound(this.sync.round);
    if (this.view !== 'stage') {
      this.mount(this.stage.el, 'stage');
      this.stage.layout(this.sync.game, true);
    }
    void room;
    this.loop();
  }

  private loop(): void {
    if (this.raf) return;
    const frame = (t: number) => {
      const room = this.sync.room;
      const game = this.sync.game;
      if (this.view !== 'stage' || !this.stage || !room || !game) {
        this.raf = 0;
        return;
      }
      const conn = this.conn;
      const serverNow = conn?.serverNow() ?? Date.now();
      const clock = { synced: !!conn?.synced, serverNow, rtt: conn?.rtt ?? 0, jitter: conn?.jitter ?? 0 };
      const view = this.net.frame(game, room, this.you, clock, t);
      this.stage.frame({ room, game, view, you: this.you, serverNow, now: t });
      this.fpsFrames++;
      if (t - this.fpsAt >= 1000) {
        this.fps = Math.round((this.fpsFrames * 1000) / (t - this.fpsAt));
        this.fpsFrames = 0;
        this.fpsAt = t;
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private showLobby(room: RoomView): void {
    const code = room.code;
    const inviteUrl = `${location.origin}/r/${code}`;
    const share =
      typeof navigator.share === 'function'
        ? () => void navigator.share({ title: '60 秒抢地盘', text: `来和我抢地盘！房间码 ${code}`, url: inviteUrl }).catch(() => {})
        : null;
    this.mount(
      lobbyView({
        room,
        you: this.you,
        inviteUrl,
        serverNow: this.conn?.serverNow() ?? Date.now(),
        onReady: (ready) => {
          sfx.ui();
          this.conn?.send({ t: 'ready', ready });
        },
        onStart: () => {
          sfx.ui();
          this.conn?.send({ t: 'start' });
        },
        onLeave: () => this.leave(),
        onCopy: async () => {
          const ok = await copyText(inviteUrl);
          toast(ok ? '邀请链接已复制，发给朋友吧' : '复制失败，请手动复制', ok ? 'ok' : 'warn');
        },
        onShare: share,
      }),
      'lobby',
    );
    // 有人掉线时每秒刷新一次"重连中 25s"倒计时
    if (room.members.some((m) => !m.online && !m.left)) {
      this.lobbyTimer = window.setTimeout(() => {
        if (this.view === 'lobby' && this.sync.room) this.showLobby(this.sync.room);
      }, 1000);
    }
  }

  private onRematch(): void {
    const room = this.sync.room;
    if (!room?.lastResult) return;
    this.dismissedRound = room.lastResult.round;
    if (room.phase === 'result') {
      this.conn?.send({ t: 'rematch' });
      return; // 等服务端回到大厅后再切换页面
    }
    const me = this.me();
    // 房主也发一次"准备"：不影响开始条件，但能让还停在结算页的人看到"已在大厅"
    if (room.phase === 'lobby' && me?.role === 'player' && !me.ready) {
      this.conn?.send({ t: 'ready', ready: true });
    }
    this.render();
  }

  private leave(): void {
    const code = this.code;
    const c = this.conn;
    this.conn = null;
    c?.send({ t: 'leave' });
    window.setTimeout(() => c?.close(), 200);
    if (code) session.clearIdentity(code);
    this.code = null;
    this.navigate('/');
  }

  // ------------------------------------------------------------------ 输入

  private onKey(e: KeyboardEvent): void {
    // M：任意页面切换静音（输入框里打字时除外）
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.code === 'KeyM' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      sfx.toggle();
      toast(sfx.muted ? '已静音' : '音效已打开', 'info', 1200);
      return;
    }
    // `：切换调试面板
    if (e.code === 'Backquote' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.debug?.toggle();
      this.updateDebug();
      return;
    }
    if (this.view !== 'stage') return;
    const dir = KEYMAP[e.code];
    const dash = e.code === 'Space';
    if (!dir && !dash) return;
    if (!this.inputTarget()) return;
    e.preventDefault();
    if (e.repeat) return;
    if (dir) this.sendDir(dir);
    else this.sendDash();
  }

  /** 能否发送输入：对局（或倒计时）中、且自己是参赛者。返回自己当前（预测）状态 */
  private inputTarget() {
    const room = this.sync.room;
    if (this.view !== 'stage' || !room || (room.phase !== 'countdown' && room.phase !== 'playing')) return null;
    const auth = this.sync.game?.players.find((p) => p.id === this.you);
    if (!auth) return null;
    return { room, mine: this.net.predictedMe ?? auth };
  }

  /**
   * 发送一条输入：带单调递增的 seq 和"希望生效的 tick"（预测时间轴上的下一个 tick）。
   * 同一条输入同时放进本地预测的待确认队列，画面立即响应；服务端在那个 tick 应用后再确认。
   */
  private send(cmd: { dir?: Dir; dash?: true }): void {
    if (!this.conn) return;
    const tick = this.net.inputTick();
    const seq = ++this.seq;
    this.conn.send({ t: 'input', seq, tick, ...cmd });
    this.net.predictor.add({ seq, tick: tick ?? this.sync.tick + 1, ...cmd });
  }

  private sendDir(dir: Dir): void {
    const t = this.inputTarget();
    if (!t) return;
    this.send({ dir });
    if (dir !== t.mine.dir || !t.mine.moving) sfx.turn();
  }

  private sendDash(): void {
    const t = this.inputTarget();
    if (!t) return;
    this.send({ dash: true });
    // 冷却已好、且正在对局中：立即给声音反馈（预测也会立即画出冲刺），最终以服务端为准
    if (t.room.phase === 'playing' && t.mine.cdLeft === 0 && t.mine.dashLeft === 0) this.stage?.noteLocalDash(performance.now());
  }

  // ------------------------------------------------------------------ 调试面板

  private updateDebug(): void {
    const d = this.debug;
    if (!d?.visible) return;
    const c = this.conn;
    const st = this.sync.stats;
    const ns = this.net.stats;
    const live = this.sync.room?.phase === 'playing' || this.sync.room?.phase === 'countdown';
    const rows: DebugRow[] = [
      ['连接', c && !c.closed ? (c.synced ? '已连接 · 时钟已同步' : '已连接 · 同步时钟中') : '未连接', !c || c.closed],
      ['ping (RTT)', c ? `${Math.round(c.rtt)} ms ±${Math.round(c.jitter)}` : '-', !!c && c.rtt > 250],
      ['时钟偏差', c ? `${Math.round(c.offset)} ms` : '-'],
      ['房间', this.sync.room ? `${this.sync.room.code} · ${this.sync.room.phase} · R${this.sync.round}` : '-'],
      ['权威 tick', this.sync.game ? `${ns.authTick} / ${this.sync.game.endTick}` : '-'],
      ['估计服务端 tick', live ? ns.serverTick.toFixed(1) : '-'],
      ['他人插值', live ? `落后 ${ns.interpBehind.toFixed(1)} tick` : '-'],
      ['自己预测', live ? `领先 ${ns.predictAhead.toFixed(1)} tick` : '-'],
      ['待确认输入', live ? String(ns.pending) : '-'],
      ['预测纠正', String(ns.corrections), ns.corrections > 0],
      ['丢弃：过期/重复 tick', String(st.staleTicks), st.staleTicks > 0],
      ['乱序重排', String(st.reordered)],
      ['丢弃：过期房间状态', String(st.staleRooms)],
      ['丢弃：服务端拒收输入', String(c?.serverDropped ?? 0), (c?.serverDropped ?? 0) > 0],
      ['断档 / 校验不一致', `${st.gaps} / ${st.mismatches}`, st.gaps + st.mismatches > 0],
      ['全量快照', String(st.snapshots)],
      ['已应用增量', String(st.ticks)],
    ];
    if (c && (c.chaos.dupIn || c.chaos.swapIn || c.chaos.dupOut)) {
      rows.push(['chaos 注入', `↓重复 ${c.chaos.dupIn} ↓乱序 ${c.chaos.swapIn} ↑重复 ${c.chaos.dupOut}`]);
    }
    rows.push(['帧率', this.view === 'stage' ? `${this.fps} fps` : '-']);
    d.update(rows);
  }
}
