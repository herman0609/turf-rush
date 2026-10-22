// 对局舞台：棋盘 + HUD + 倒计时 + 结算层。DOM 只在需要时更新，Canvas 每帧重画。
// 所有"游戏感"反馈（音效、粒子、反超提示、庆祝）都由服务端下发的状态变化驱动，本地不做任何判定。

import { GRID_H, GRID_W, PALETTE, TICK_MS } from '@turf/shared/constants';
import type { RoomView } from '@turf/shared/protocol';
import { muteButton, sfx } from './audio';
import { h } from './dom';
import { confetti, countUp, stopConfetti } from './fx';
import { BoardRenderer, type PlayerLabel } from './render';
import type { ClientGame } from './sync';
import { playerBadge } from './views';

export interface StageHandlers {
  onRematch: () => void;
  onLeave: () => void;
}

export interface Frame {
  room: RoomView;
  game: ClientGame;
  you: string | null;
  serverNow: number;
  now: number;
}

const REASON_TEXT = {
  time: '时间到',
  opponents_offline: '在线玩家不足 2 人超过 10 秒，本局提前结束，按当前格数结算',
  opponents_left: '有玩家离开，场上不足 2 人，本局提前结束，按当前格数结算',
} as const;

/** 领先者需要保持这么久才算"反超"，避免比分来回跳时刷屏 */
const LEAD_CONFIRM_MS = 500;
const CALLOUT_GAP_MS = 2000;
/** "时间到！"停留多久再弹出结算 */
const TIME_UP_HOLD_MS = 1100;

export class Stage {
  readonly el: HTMLElement;
  readonly renderer = new BoardRenderer();
  round = -1;
  private readonly boardWrap: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly chipsEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly dashEl: HTMLElement;
  private readonly countdownEl: HTMLElement;
  private readonly calloutEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private chipScores = new Map<string, HTMLElement>();
  private structKey = '';
  private notesKey = '';
  private timerText = '';
  private countdownText = '';
  private layoutKey = '';

  // ---- 特效用的影子状态（只用于比较，不参与游戏逻辑）
  private shadow: Int8Array | null = null;
  private shadowRound = -1;
  private you: string | null = null;
  private combo = 0;
  private lastPaintAt = 0;
  private prevDash = new Map<string, number>();
  private prevCd = new Map<string, number>();
  private lead = { candidate: null as string | null, since: 0, announced: null as string | null, lastCallout: 0 };
  private lastSecond = -1;
  private finalShown = false;
  private sawPlaying = -1;
  private resultShownRound = -1;
  private resultTimer = 0;
  private calloutTimer = 0;
  private localDashAt = -1e9;

  constructor(private readonly handlers: StageHandlers) {
    this.timerEl = h('div', { class: 'timer', 'aria-label': '剩余时间' }, '60');
    this.barEl = h('div', { class: 'scorebar', 'aria-hidden': 'true' });
    this.chipsEl = h('div', { class: 'chips' });
    this.bannerEl = h('div', { class: 'banner hidden' });
    this.dashEl = h('span', { class: 'dash-state' });
    this.countdownEl = h('div', { class: 'countdown hidden', 'aria-live': 'assertive' });
    this.calloutEl = h('div', { class: 'callout hidden', 'aria-live': 'polite' });
    this.resultEl = h('div', { class: 'result hidden', role: 'dialog', 'aria-modal': 'true' });
    this.boardWrap = h('div', { class: 'board-wrap' }, this.renderer.canvas, this.countdownEl, this.calloutEl);
    this.el = h(
      'main',
      { class: 'stage' },
      h(
        'div',
        { class: 'hud' },
        h('div', { class: 'hud-top' }, this.chipsEl, h('div', { class: 'hud-right' }, muteButton(), this.timerEl)),
        this.barEl,
      ),
      this.bannerEl,
      this.boardWrap,
      h('p', { class: 'controls' }, h('span', {}, '方向键 / WASD 转向 · 空格 冲刺 · M 静音'), this.dashEl),
      this.resultEl,
    );
  }

  newRound(round: number): void {
    this.round = round;
    this.renderer.reset();
    this.structKey = '';
    this.notesKey = '';
    this.shadow = null;
    this.combo = 0;
    this.prevDash.clear();
    this.prevCd.clear();
    this.lead = { candidate: null, since: 0, announced: null, lastCallout: 0 };
    this.lastSecond = -1;
    this.finalShown = false;
    this.el.classList.remove('final');
    this.hideCallout();
    this.hideResult();
  }

  layout(game: ClientGame, force = false): void {
    const maxW = Math.min(window.innerWidth - 24, 1200);
    const maxH = window.innerHeight - 170;
    const key = `${maxW}x${maxH}:${game.w}x${game.h}`;
    if (!force && key === this.layoutKey) return;
    this.layoutKey = key;
    this.renderer.resize(maxW, Math.max(200, maxH), game.w, game.h);
  }

  /** 收到全量快照（加入、重连、resync）：只同步影子状态，不播放特效 */
  onSnapshot(game: ClientGame, round: number, now: number): void {
    this.renderer.onPlayers(game.players, now);
    this.shadow = Int8Array.from(game.cells);
    this.shadowRound = round;
    for (const p of game.players) {
      this.prevDash.set(p.id, p.dashLeft);
      this.prevCd.set(p.id, p.cdLeft);
    }
  }

  /** 每个权威 tick：比较前后状态，驱动特效、音效和反超提示 */
  onTick(game: ClientGame, round: number, now: number): void {
    this.renderer.onPlayers(game.players, now);
    if (!this.shadow || this.shadowRound !== round || this.shadow.length !== game.cells.length) {
      this.onSnapshot(game, round, now);
      return;
    }
    const mine = game.players.find((p) => p.id === this.you);
    const mySlot = mine?.slot ?? -1;
    let painted = 0;
    let stole = 0;
    let lost = 0;
    for (let i = 0; i < game.cells.length; i++) {
      const o = game.cells[i]!;
      const prev = this.shadow[i]!;
      if (o === prev) continue;
      this.shadow[i] = o;
      if (o < 0) continue;
      this.renderer.markPainted(i, now);
      const stolen = prev >= 0;
      if (o === mySlot) {
        painted++;
        if (stolen) stole++;
        this.renderer.burst(i, o, stolen ? 7 : 3);
      } else {
        if (prev === mySlot && mySlot >= 0) lost++;
        this.renderer.burst(i, o, stolen ? 4 : 1);
      }
    }
    if (painted) {
      this.combo = now - this.lastPaintAt < 400 ? this.combo + 1 : 0;
      this.lastPaintAt = now;
      if (stole) sfx.steal();
      else sfx.paint(this.combo);
    }
    if (lost) sfx.stolen();

    for (const p of game.players) {
      const pd = this.prevDash.get(p.id) ?? 0;
      const pc = this.prevCd.get(p.id) ?? 0;
      if (p.id === this.you) {
        // 按键时已经本地播过冲刺音效的，服务端确认时不再重复
        if (pd === 0 && p.dashLeft > 0 && now - this.localDashAt > 600) sfx.dash();
        if (pc > 0 && p.cdLeft === 0) sfx.dashReady();
      }
      this.prevDash.set(p.id, p.dashLeft);
      this.prevCd.set(p.id, p.cdLeft);
    }

    if (game.tick > 0) this.trackLead(game, now);
  }

  /** 按下冲刺键且本地判断大概率可用时，立即播放音效（服务端确认前就有反馈） */
  noteLocalDash(now: number): void {
    this.localDashAt = now;
    sfx.dash();
  }

  /** 领先者变化：确认保持一段时间后才提示，避免比分胶着时刷屏 */
  private trackLead(game: ClientGame, now: number): void {
    let best = -1;
    let leader: string | null = null;
    for (const p of game.players) {
      if (this.labels.get(p.id)?.left) continue;
      const s = game.scores[p.slot] ?? 0;
      if (s > best) {
        best = s;
        leader = p.id;
      } else if (s === best) leader = null; // 并列不算领先
    }
    if (leader === null) return;
    if (leader !== this.lead.candidate) {
      this.lead.candidate = leader;
      this.lead.since = now;
      return;
    }
    if (now - this.lead.since < LEAD_CONFIRM_MS || leader === this.lead.announced) return;
    const prev = this.lead.announced;
    this.lead.announced = leader;
    if (prev === null) return; // 第一次有人领先不算反超
    if (now - this.lead.lastCallout < CALLOUT_GAP_MS) return;
    this.lead.lastCallout = now;
    const name = this.labels.get(leader)?.name ?? '?';
    const meIn = game.players.some((p) => p.id === this.you);
    if (leader === this.you) {
      this.callout('你反超了！', 'good');
      sfx.lead();
    } else if (prev === this.you) {
      this.callout(`被 ${name} 反超了！`, 'bad');
      sfx.overtaken();
    } else {
      this.callout(meIn ? `${name} 领先了` : `${name} 反超！`, 'info');
    }
  }

  private callout(text: string, kind: 'good' | 'bad' | 'info' | 'final'): void {
    window.clearTimeout(this.calloutTimer);
    this.calloutEl.textContent = text;
    this.calloutEl.className = `callout ${kind}`;
    void this.calloutEl.offsetWidth; // 重新触发动画
    this.calloutEl.classList.add('show');
    this.calloutTimer = window.setTimeout(() => this.hideCallout(), 1500);
  }

  private hideCallout(): void {
    window.clearTimeout(this.calloutTimer);
    this.calloutEl.className = 'callout hidden';
  }

  private labels = new Map<string, PlayerLabel>();

  frame(f: Frame): void {
    const { room, game, you, serverNow, now } = f;
    this.you = you;
    this.layout(game);

    const labels = new Map<string, PlayerLabel>();
    for (const m of room.members) {
      labels.set(m.id, { name: m.name, you: m.id === you, offline: !m.online && !m.left, left: m.left });
    }
    this.labels = labels;

    // 倒计时和开局前 1.5 秒标出"你在这里"
    let highlightYou = 0;
    if (room.phase === 'countdown') highlightYou = 1;
    else if (room.phase === 'playing' && room.startsAt !== null) highlightYou = Math.max(0, 1 - (serverNow - room.startsAt) / 1500);
    this.renderer.draw(game, labels, now, { highlightYou });

    // 计时
    let remain = Math.round(((game.endTick - game.tick) * TICK_MS) / 1000);
    if (room.phase === 'playing' && room.endsAt !== null) remain = Math.max(0, Math.ceil((room.endsAt - serverNow) / 1000));
    if (room.phase === 'result' || room.phase === 'lobby') remain = 0;
    const tt = String(remain);
    const final = room.phase === 'playing' && remain <= 10 && remain > 0;
    if (tt !== this.timerText) {
      this.timerText = tt;
      this.timerEl.textContent = tt;
      this.timerEl.classList.toggle('urgent', final);
      if (final) {
        // 每秒弹一下
        this.timerEl.classList.remove('beat');
        void this.timerEl.offsetWidth;
        this.timerEl.classList.add('beat');
      }
    }
    this.el.classList.toggle('final', final);
    if (room.phase === 'playing') {
      this.sawPlaying = this.round;
      if (final && remain !== this.lastSecond) {
        this.lastSecond = remain;
        sfx.tick(remain <= 3);
        if (remain === 10 && !this.finalShown) {
          this.finalShown = true;
          this.callout('最后 10 秒！', 'final');
        }
      }
    }

    // 倒计时覆盖层
    let ct = '';
    if (room.phase === 'countdown' && room.startsAt !== null) {
      ct = String(Math.min(3, Math.max(1, Math.ceil((room.startsAt - serverNow) / 1000))));
    } else if (room.phase === 'playing' && room.startsAt !== null && serverNow - room.startsAt < 700) {
      ct = '开始！';
    } else if (room.phase === 'playing' && remain === 0) {
      ct = '时间到！'; // 本地计时先归零：等待服务端结算
    } else if (room.phase === 'result' && this.resultTimer) {
      ct = '时间到！';
    }
    if (ct !== this.countdownText) {
      this.countdownText = ct;
      this.countdownEl.textContent = ct;
      this.countdownEl.classList.toggle('hidden', ct === '');
      this.countdownEl.classList.toggle('small', ct === '时间到！');
      // 重新触发弹出动画
      this.countdownEl.classList.remove('pop');
      void this.countdownEl.offsetWidth;
      if (ct) this.countdownEl.classList.add('pop');
      if (/^[123]$/.test(ct)) sfx.count(Number(ct));
      else if (ct === '开始！') sfx.go();
      else if (ct === '时间到！') sfx.timeUp();
    }

    this.updateHud(room, game, you, serverNow);

    // 冲刺状态
    const me = game.players.find((p) => p.id === you);
    if (me) {
      const text = me.dashLeft > 0 ? '冲刺中！' : me.cdLeft > 0 ? `冲刺冷却 ${((me.cdLeft * TICK_MS) / 1000).toFixed(1)}s` : '冲刺就绪 [空格]';
      if (this.dashEl.textContent !== text) this.dashEl.textContent = text;
      this.dashEl.classList.toggle('ready', me.dashLeft === 0 && me.cdLeft === 0);
    } else if (this.dashEl.textContent !== '') this.dashEl.textContent = '';
  }

  private updateHud(room: RoomView, game: ClientGame, you: string | null, serverNow: number): void {
    const names = new Map(room.members.map((m) => [m.id, m]));
    const spectating = !game.players.some((p) => p.id === you);
    const secs = (until: number) => Math.max(0, Math.ceil((until - serverNow) / 1000));

    // 状态提示：观战、谁掉线了（座位还保留几秒）、在线人数不足时多久后结束
    const notes: { text: string; kind: 'info' | 'warn' }[] = [];
    if (spectating && (room.phase === 'countdown' || room.phase === 'playing')) {
      notes.push({ text: '观战中 · 本局结束后回到大厅即可加入下一局', kind: 'info' });
    }
    if (room.phase === 'countdown' || room.phase === 'playing') {
      for (const p of game.players) {
        const m = names.get(p.id);
        if (m && !m.online && !m.left && m.offlineUntil !== null) {
          notes.push({ text: `${m.name} 掉线，重连中 ${secs(m.offlineUntil)}s`, kind: 'warn' });
        }
      }
    }
    if (room.phase === 'playing' && room.soloEndsAt !== null) {
      notes.push({ text: `在线玩家不足 2 人，${secs(room.soloEndsAt)}s 后结束本局`, kind: 'warn' });
    }
    const nk = JSON.stringify(notes);
    if (nk !== this.notesKey) {
      this.notesKey = nk;
      this.bannerEl.replaceChildren(...notes.map((n) => h('span', { class: `pill ${n.kind}` }, n.text)));
      this.bannerEl.classList.toggle('hidden', notes.length === 0);
    }

    // 比分：结构（谁在场、在线、领先）变化才重建，分数和比分条原地更新，才有过渡动画
    let best = 0;
    let leaders = 0;
    for (const p of game.players) {
      if (names.get(p.id)?.left) continue;
      const s = game.scores[p.slot] ?? 0;
      if (s > best) {
        best = s;
        leaders = 1;
      } else if (s === best) leaders++;
    }
    const sk = JSON.stringify([
      you,
      game.players.map((p) => {
        const m = names.get(p.id);
        const s = game.scores[p.slot] ?? 0;
        return [p.id, p.slot, m?.name, m?.online, m?.left, best > 1 && s === best && !m?.left, leaders];
      }),
    ]);
    if (sk !== this.structKey) {
      this.structKey = sk;
      this.chipScores.clear();
      this.chipsEl.replaceChildren(
        ...game.players.map((p) => {
          const m = names.get(p.id);
          const score = game.scores[p.slot] ?? 0;
          const scoreEl = h('span', { class: 'chip-score' }, String(score));
          this.chipScores.set(p.id, scoreEl);
          const isLead = best > 1 && score === best && !m?.left;
          return h(
            'div',
            { class: `chip ${p.id === you ? 'me' : ''} ${isLead ? 'lead' : ''} ${m && !m.online ? 'off' : ''}` },
            playerBadge(p.slot),
            h('span', { class: 'chip-name' }, m?.name ?? '?'),
            scoreEl,
            m?.left ? h('span', { class: 'chip-tag' }, '已离开') : m && !m.online ? h('span', { class: 'chip-tag' }, '掉线') : null,
          );
        }),
      );
      this.barEl.replaceChildren(
        ...game.players.map((p) => h('span', { style: { background: PALETTE[p.slot]!.color }, 'data-slot': String(p.slot) })),
      );
    }
    const total = game.w * game.h;
    for (const p of game.players) {
      const el = this.chipScores.get(p.id);
      const s = String(game.scores[p.slot] ?? 0);
      if (el && el.textContent !== s) el.textContent = s;
    }
    const spans = this.barEl.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i] as HTMLElement;
      const slot = Number(span.dataset.slot);
      const w = `${((game.scores[slot] ?? 0) / total) * 100}%`;
      if (span.style.width !== w) span.style.width = w;
    }
  }

  hideResult(): void {
    window.clearTimeout(this.resultTimer);
    this.resultTimer = 0;
    this.resultEl.classList.add('hidden');
    this.resultEl.replaceChildren();
    stopConfetti();
  }

  showResult(room: RoomView, you: string | null): void {
    const res = room.lastResult;
    if (!res) return;
    const first = this.resultShownRound !== res.round;
    if (first && this.resultTimer) return; // "时间到！"正在展示
    if (first && res.reason === 'time' && this.sawPlaying === res.round) {
      // 刚打完：先让"时间到！"停一下，再弹结算
      this.resultTimer = window.setTimeout(() => {
        this.resultTimer = 0;
        this.countdownText = '';
        this.countdownEl.classList.add('hidden');
        this.renderResult(room, you, true);
      }, TIME_UP_HOLD_MS);
      return;
    }
    this.renderResult(room, you, first && this.sawPlaying === res.round);
  }

  private renderResult(room: RoomView, you: string | null, celebrate: boolean): void {
    const res = room.lastResult;
    if (!res) return;
    this.resultShownRound = res.round;
    this.el.classList.remove('final');
    const me = room.members.find((m) => m.id === you);
    const winnerNames = res.winners.map((id) => res.ranking.find((r) => r.id === id)?.name ?? '?');
    const iWon = !!you && res.winners.includes(you);
    const iPlayed = !!you && res.ranking.some((r) => r.id === you);
    let title: string;
    if (res.winners.length === 0) title = '本局结束';
    else if (res.winners.length > 1) title = iWon ? '平局！你并列第一' : '平局！';
    else title = iWon ? '你赢了！' : `${winnerNames[0]} 获胜！`;
    const total = GRID_W * GRID_H;
    const active = res.ranking.filter((r) => !r.left);
    let sub: string;
    if (res.reason !== 'time') sub = REASON_TEXT[res.reason];
    else if (res.winners.length > 1) sub = `${winnerNames.join('、')} 并列第一（${res.ranking[0]?.score ?? 0} 格）`;
    else if (active.length >= 2) sub = `${winnerNames[0]} 以 ${active[0]!.score} : ${active[1]!.score} 领先 ${active[0]!.score - active[1]!.score} 格`;
    else sub = REASON_TEXT[res.reason];

    // 已点过"再来一局"的人（服务端会把点击者置为已准备）
    const readyNames = room.phase === 'lobby' ? room.members.filter((m) => !m.left && m.role === 'player' && m.ready).map((m) => m.name) : [];
    const isPlayer = me?.role === 'player';
    const rematchLabel = isPlayer ? '再来一局' : '回到大厅';

    let rank = 0;
    let prevScore = -1;
    const counters: [HTMLElement, number][] = [];
    const rows = res.ranking.map((r, i) => {
      if (r.score !== prevScore) rank = i + 1;
      prevScore = r.score;
      const scoreEl = h('span', { class: 'rank-score' }, `${r.score} 格`);
      counters.push([scoreEl, r.score]);
      const win = res.winners.includes(r.id);
      return h(
        'li',
        { class: `rank-row ${win ? 'win' : ''} ${r.id === you ? 'me' : ''}`, style: { animationDelay: `${0.15 + i * 0.08}s` } },
        h('span', { class: 'rank-no' }, win ? '冠军' : `#${rank}`),
        playerBadge(r.slot),
        h('span', { class: 'rank-name' }, r.name, r.id === you ? '（你）' : '', r.left ? '（已离开）' : ''),
        scoreEl,
        h('span', { class: 'rank-pct' }, `${Math.round((r.score / total) * 100)}%`),
      );
    });

    const kind = iWon ? (res.winners.length > 1 ? 'tie' : 'won') : iPlayed ? 'lost' : 'watch';
    this.resultEl.replaceChildren(
      h(
        'div',
        { class: `result-card ${kind}` },
        h('p', { class: 'eyebrow' }, `第 ${res.round} 局 · ${res.reason === 'time' ? '时间到' : '提前结束'}`),
        h('h2', { class: 'result-title' }, title),
        h('p', { class: 'result-sub' }, sub),
        h('ol', { class: 'ranking' }, ...rows),
        readyNames.length ? h('p', { class: 'hint' }, `已在大厅：${readyNames.join('、')}`) : null,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary big', type: 'button', autofocus: true, on: { click: this.handlers.onRematch } }, rematchLabel),
          h('button', { class: 'btn link', type: 'button', on: { click: this.handlers.onLeave } }, '离开房间'),
        ),
      ),
    );
    this.resultEl.classList.remove('hidden');
    if (!celebrate) return;

    // 庆祝：分数滚动、彩带、音效
    for (const [el, n] of counters) countUp(el, n, 700, (v) => `${v} 格`);
    const winnerColors = res.winners.map((id) => PALETTE[res.ranking.find((r) => r.id === id)?.slot ?? 0]!.color);
    if (kind === 'won' || kind === 'tie') {
      confetti([...winnerColors, '#FFFFFF', '#FDE68A'], true);
      if (kind === 'won') sfx.win();
      else sfx.draw();
    } else if (kind === 'watch') {
      confetti([...winnerColors, '#FFFFFF'], false);
      sfx.draw();
    } else {
      sfx.lose();
    }
  }
}
