// 对局舞台：棋盘 + HUD + 倒计时 + 结算层。DOM 只在需要时更新，Canvas 每帧重画。

import { GRID_H, GRID_W, PALETTE, TICK_MS } from '@turf/shared/constants';
import type { PState, RoomView } from '@turf/shared/protocol';
import { h } from './dom';
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
  opponents_offline: '其他玩家掉线超过 10 秒，本局提前结束',
  opponents_left: '其他玩家离开了房间，本局提前结束',
} as const;

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
  private readonly resultEl: HTMLElement;
  private hudKey = '';
  private timerText = '';
  private countdownText = '';
  private layoutKey = '';

  constructor(private readonly handlers: StageHandlers) {
    this.timerEl = h('div', { class: 'timer', 'aria-label': '剩余时间' }, '60');
    this.barEl = h('div', { class: 'scorebar', 'aria-hidden': 'true' });
    this.chipsEl = h('div', { class: 'chips' });
    this.bannerEl = h('div', { class: 'banner hidden' });
    this.dashEl = h('span', { class: 'dash-state' });
    this.countdownEl = h('div', { class: 'countdown hidden', 'aria-live': 'assertive' });
    this.resultEl = h('div', { class: 'result hidden', role: 'dialog', 'aria-modal': 'true' });
    this.boardWrap = h('div', { class: 'board-wrap' }, this.renderer.canvas, this.countdownEl, this.resultEl);
    this.el = h(
      'main',
      { class: 'stage' },
      h('div', { class: 'hud' }, h('div', { class: 'hud-top' }, this.chipsEl, this.timerEl), this.barEl),
      this.bannerEl,
      this.boardWrap,
      h('p', { class: 'controls' }, h('span', {}, '方向键 / WASD 转向 · 空格 冲刺'), this.dashEl),
    );
  }

  newRound(round: number): void {
    this.round = round;
    this.renderer.resetTweens();
    this.hudKey = '';
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

  onTick(players: readonly PState[], now: number): void {
    this.renderer.onPlayers(players, now);
  }

  frame(f: Frame): void {
    const { room, game, you, serverNow, now } = f;
    this.layout(game);

    const labels = new Map<string, PlayerLabel>();
    for (const m of room.members) {
      labels.set(m.id, { name: m.name, you: m.id === you, offline: !m.online && !m.left, left: m.left });
    }
    this.renderer.draw(game, labels, now);

    // 计时
    let remain = Math.round(((game.endTick - game.tick) * TICK_MS) / 1000);
    if (room.phase === 'playing' && room.endsAt !== null) remain = Math.max(0, Math.ceil((room.endsAt - serverNow) / 1000));
    if (room.phase === 'result' || room.phase === 'lobby') remain = 0;
    const tt = String(remain);
    if (tt !== this.timerText) {
      this.timerText = tt;
      this.timerEl.textContent = tt;
      this.timerEl.classList.toggle('urgent', room.phase === 'playing' && remain <= 10);
    }

    // 倒计时覆盖层
    let ct = '';
    if (room.phase === 'countdown' && room.startsAt !== null) {
      ct = String(Math.min(3, Math.max(1, Math.ceil((room.startsAt - serverNow) / 1000))));
    } else if (room.phase === 'playing' && room.startsAt !== null && serverNow - room.startsAt < 700) {
      ct = '开始！';
    }
    if (ct !== this.countdownText) {
      this.countdownText = ct;
      this.countdownEl.textContent = ct;
      this.countdownEl.classList.toggle('hidden', ct === '');
      // 重新触发弹出动画
      this.countdownEl.classList.remove('pop');
      void this.countdownEl.offsetWidth;
      if (ct) this.countdownEl.classList.add('pop');
    }

    this.updateHud(room, game, you);

    // 冲刺状态
    const me = game.players.find((p) => p.id === you);
    if (me) {
      const text = me.dashLeft > 0 ? '冲刺中！' : me.cdLeft > 0 ? `冲刺冷却 ${((me.cdLeft * TICK_MS) / 1000).toFixed(1)}s` : '冲刺就绪 [空格]';
      if (this.dashEl.textContent !== text) this.dashEl.textContent = text;
      this.dashEl.classList.toggle('ready', me.dashLeft === 0 && me.cdLeft === 0);
    } else if (this.dashEl.textContent !== '') this.dashEl.textContent = '';
  }

  private updateHud(room: RoomView, game: ClientGame, you: string | null): void {
    const names = new Map(room.members.map((m) => [m.id, m]));
    const spectating = !game.players.some((p) => p.id === you);
    const key = JSON.stringify([game.scores, game.players.map((p) => [p.id, names.get(p.id)?.online, names.get(p.id)?.left]), spectating]);
    if (key === this.hudKey) return;
    this.hudKey = key;

    const total = game.w * game.h;
    const best = Math.max(...game.players.map((p) => game.scores[p.slot] ?? 0));
    this.chipsEl.replaceChildren(
      ...game.players.map((p) => {
        const m = names.get(p.id);
        const score = game.scores[p.slot] ?? 0;
        return h(
          'div',
          { class: `chip ${p.id === you ? 'me' : ''} ${score === best && best > 1 ? 'lead' : ''} ${m && !m.online ? 'off' : ''}` },
          playerBadge(p.slot),
          h('span', { class: 'chip-name' }, m?.name ?? '?'),
          h('span', { class: 'chip-score' }, String(score)),
          m?.left ? h('span', { class: 'chip-tag' }, '已离开') : m && !m.online ? h('span', { class: 'chip-tag' }, '掉线') : null,
        );
      }),
    );
    this.barEl.replaceChildren(
      ...game.players.map((p) =>
        h('span', { style: { width: `${((game.scores[p.slot] ?? 0) / total) * 100}%`, background: PALETTE[p.slot]!.color } }),
      ),
    );
    this.bannerEl.textContent = spectating ? '观战中 · 下一局开始前回到大厅即可加入' : '';
    this.bannerEl.classList.toggle('hidden', !spectating);
  }

  hideResult(): void {
    this.resultEl.classList.add('hidden');
    this.resultEl.replaceChildren();
  }

  showResult(room: RoomView, you: string | null): void {
    const res = room.lastResult;
    if (!res) return;
    const me = room.members.find((m) => m.id === you);
    const winnerNames = res.winners.map((id) => res.ranking.find((r) => r.id === id)?.name ?? '?');
    const iWon = !!you && res.winners.includes(you);
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
    const rows = res.ranking.map((r, i) => {
      if (r.score !== prevScore) rank = i + 1;
      prevScore = r.score;
      return h(
        'li',
        { class: `rank-row ${res.winners.includes(r.id) ? 'win' : ''} ${r.id === you ? 'me' : ''}` },
        h('span', { class: 'rank-no' }, `#${rank}`),
        playerBadge(r.slot),
        h('span', { class: 'rank-name' }, r.name, r.id === you ? '（你）' : '', r.left ? '（已离开）' : ''),
        h('span', { class: 'rank-score' }, `${r.score} 格`),
        h('span', { class: 'rank-pct' }, `${Math.round((r.score / total) * 100)}%`),
      );
    });

    this.resultEl.replaceChildren(
      h(
        'div',
        { class: `result-card ${iWon ? 'won' : ''}` },
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
  }
}
