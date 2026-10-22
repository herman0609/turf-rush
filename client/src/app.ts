// 客户端总控制器：路由 → 连接 → 消息 → 视图。
// 原则：界面只是服务端状态的投影；本地只保存身份（sessionStorage）和"我已看过的结算"这类纯展示状态。

import { PROTOCOL_VERSION, type Dir } from '@turf/shared/constants';
import type { RoomView, S2C } from '@turf/shared/protocol';
import { normalizeRoomCode } from '@turf/shared/util';
import { clear, copyText, toast } from './dom';
import { Connection, wsUrl } from './net';
import * as session from './session';
import { Stage } from './stage';
import { ClientSync } from './sync';
import { connectingView, homeView, joinView, lobbyView, messageView } from './views';

type View = 'home' | 'join' | 'connecting' | 'lobby' | 'stage' | 'message';

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
  private you: string | null = null;
  private seq = 0;
  private stage: Stage | null = null;
  private raf = 0;
  private lobbyTimer = 0;
  private resyncAt = 0;
  /** 已经亲眼看到"结算"的局号（中途进入大厅的人不弹旧结算） */
  private resultSeenRound = -1;
  /** 用户已关闭结算层的局号 */
  private dismissedRound = -1;

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    window.addEventListener('popstate', () => this.route());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => {
      if (this.stage && this.sync.game) this.stage.layout(this.sync.game, true);
    });
    this.route();
  }

  // ------------------------------------------------------------------ 路由

  private navigate(path: string): void {
    if (location.pathname !== path) history.pushState(null, '', path);
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

  private connect(code: string, name: string): void {
    this.disconnect();
    this.code = code;
    this.sync = new ClientSync();
    this.you = null;
    this.stage = null;
    this.mount(connectingView('正在进入房间…'), 'connecting');
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
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private onMessage(conn: Connection, code: string, name: string, msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.seq = 0; // seq 按连接计数，服务端同样在新连接上归零
        session.setIdentity(code, { playerId: msg.you, token: msg.token });
        return;
      case 'snapshot':
        this.sync.applySnapshot(msg);
        this.resyncAt = 0;
        this.render();
        if (this.stage && this.sync.game) this.stage.onTick(this.sync.game.players, performance.now());
        return;
      case 'room':
        if (this.sync.applyRoom(msg)) this.render();
        return;
      case 'tick': {
        const r = this.sync.applyTick(msg);
        if (r === 'gap' || r === 'mismatch') this.requestResync(conn);
        if ((r === 'ok' || r === 'mismatch') && this.stage) this.stage.onTick(msg.players, performance.now());
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
      this.showMessage('你在另一个页面打开了这个房间', '同一个座位只能在一个页面里玩。', [
        { label: '在这里继续', primary: true, onClick: () => this.connect(code, session.getNickname()) },
        { label: '返回首页', onClick: () => this.navigate('/') },
      ]);
      return;
    }
    if (wsCode === 4002) return; // 主动离开
    if (wsCode === 1012 || reason === 'room_expired') {
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
    this.showMessage('连接已断开', wsCode === 4008 ? `连接因异常被服务器断开（${reason}）。` : '网络连接中断了。', [
      { label: '重新连接', primary: true, onClick: () => this.connect(code, session.getNickname()) },
      { label: '返回首页', onClick: () => this.navigate('/') },
    ]);
  }

  // ------------------------------------------------------------------ 视图投影

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
      this.stage = new Stage({ onRematch: () => this.onRematch(), onLeave: () => this.leave() });
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
      this.stage.frame({ room, game, you: this.you, serverNow: this.conn?.serverNow() ?? Date.now(), now: t });
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
        onReady: (ready) => this.conn?.send({ t: 'ready', ready }),
        onStart: () => this.conn?.send({ t: 'start' }),
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
    if (this.view !== 'stage') return;
    const room = this.sync.room;
    if (!room || (room.phase !== 'countdown' && room.phase !== 'playing')) return;
    const dir = KEYMAP[e.code];
    const dash = e.code === 'Space';
    if (!dir && !dash) return;
    e.preventDefault();
    if (e.repeat) return;
    if (!this.sync.game?.players.some((p) => p.id === this.you)) return;
    if (dir) this.conn?.send({ t: 'input', seq: ++this.seq, dir });
    else this.conn?.send({ t: 'input', seq: ++this.seq, dash: true });
  }
}
