// Canvas 2D 棋盘渲染。逻辑位置按格跳变，画面在"上一格 → 当前格"之间补间，转向不会突兀折线。

import { PALETTE, type Shape } from '@turf/shared/constants';
import type { PState } from '@turf/shared/protocol';
import type { ClientGame } from './sync';

interface Tween {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  dur: number;
}

export interface PlayerLabel {
  name: string;
  you: boolean;
  offline: boolean;
  left: boolean;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex: string, withWhite: number): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round(c + (255 - c) * withWhite);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

/** 地块用浅色，角色用原色：既明亮，又能一眼分清"人"和"地" */
export const CELL_TINT = PALETTE.map((p) => mix(p.color, 0.45));

export function traceShape(ctx: CanvasRenderingContext2D, shape: Shape, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.95, cy + r * 0.75);
      ctx.lineTo(cx - r * 0.95, cy + r * 0.75);
      ctx.closePath();
      break;
    case 'square':
      ctx.rect(cx - r * 0.8, cy - r * 0.8, r * 1.6, r * 1.6);
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class BoardRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  cell = 24;
  private gw = 32;
  private gh = 20;
  private dpr = 1;
  private tweens = new Map<string, Tween>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board';
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(maxW: number, maxH: number, gw: number, gh: number): void {
    this.gw = gw;
    this.gh = gh;
    this.cell = Math.max(8, Math.floor(Math.min(maxW / gw, maxH / gh)));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = this.cell * gw;
    const cssH = this.cell * gh;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
  }

  /** 每次收到权威玩家状态时调用，更新补间目标 */
  onPlayers(players: readonly PState[], now: number): void {
    for (const p of players) {
      const tw = this.tweens.get(p.id);
      if (!tw) {
        this.tweens.set(p.id, { fx: p.x, fy: p.y, tx: p.x, ty: p.y, t0: now, dur: 1 });
        continue;
      }
      if (p.x === tw.tx && p.y === tw.ty) continue;
      const cur = this.pos(tw, now);
      // 距离过大（快照纠正、重连）直接跳过去，不做长距离滑动
      const far = Math.abs(p.x - cur.x) + Math.abs(p.y - cur.y) > 2.5;
      tw.fx = far ? p.x : cur.x;
      tw.fy = far ? p.y : cur.y;
      tw.tx = p.x;
      tw.ty = p.y;
      tw.t0 = now;
      tw.dur = p.dashLeft > 0 ? 50 : 150;
    }
  }

  resetTweens(): void {
    this.tweens.clear();
  }

  private pos(tw: Tween, now: number): { x: number; y: number } {
    const k = Math.min(1, Math.max(0, (now - tw.t0) / tw.dur));
    return { x: tw.fx + (tw.tx - tw.fx) * k, y: tw.fy + (tw.ty - tw.fy) * k };
  }

  draw(game: ClientGame, labels: ReadonlyMap<string, PlayerLabel>, now: number): void {
    const { ctx, cell: c, gw, gh } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, gw * c, gh * c);

    // 底板
    ctx.fillStyle = '#F7F8FC';
    ctx.fillRect(0, 0, gw * c, gh * c);

    // 地块
    for (let i = 0; i < game.cells.length; i++) {
      const o = game.cells[i]!;
      if (o < 0) continue;
      ctx.fillStyle = CELL_TINT[o]!;
      ctx.fillRect((i % gw) * c, Math.floor(i / gw) * c, c, c);
    }

    // 网格线
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < gw; x++) {
      ctx.moveTo(x * c + 0.5, 0);
      ctx.lineTo(x * c + 0.5, gh * c);
    }
    for (let y = 1; y < gh; y++) {
      ctx.moveTo(0, y * c + 0.5);
      ctx.lineTo(gw * c, y * c + 0.5);
    }
    ctx.stroke();

    // 角色（自己最后画，保证在最上层）
    const order = [...game.players].sort(
      (a, b) => Number(labels.get(a.id)?.you ?? false) - Number(labels.get(b.id)?.you ?? false),
    );
    for (const p of order) {
      const label = labels.get(p.id);
      if (label?.left) continue;
      const tw = this.tweens.get(p.id);
      const pos = tw ? this.pos(tw, now) : { x: p.x, y: p.y };
      this.drawPlayer(p, pos.x, pos.y, label);
    }
  }

  private drawPlayer(p: PState, gx: number, gy: number, label: PlayerLabel | undefined): void {
    const { ctx, cell: c } = this;
    const pal = PALETTE[p.slot]!;
    const cx = gx * c + c / 2;
    const cy = gy * c + c / 2;
    const size = c * 0.92;
    const dim = p.frozen || label?.offline;

    ctx.save();
    ctx.globalAlpha = dim ? 0.45 : 1;
    // 冲刺光晕
    if (p.dashLeft > 0) {
      ctx.shadowColor = pal.color;
      ctx.shadowBlur = c * 0.8;
    } else {
      ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
      ctx.shadowBlur = c * 0.25;
      ctx.shadowOffsetY = c * 0.06;
    }
    roundRect(ctx, cx - size / 2, cy - size / 2, size, size, c * 0.22);
    ctx.fillStyle = pal.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1.5, c * 0.08);
    ctx.strokeStyle = label?.you ? '#0F172A' : '#FFFFFF';
    ctx.stroke();

    // 形状标记：不依赖颜色也能分清是谁
    traceShape(ctx, pal.shape, cx, cy, c * 0.24);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();

    // 朝向小箭头
    const ax = { U: 0, D: 0, L: -1, R: 1 }[p.dir];
    const ay = { U: -1, D: 1, L: 0, R: 0 }[p.dir];
    ctx.beginPath();
    const tipX = cx + ax * size * 0.62;
    const tipY = cy + ay * size * 0.62;
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(cx + ax * size * 0.42 - ay * c * 0.14, cy + ay * size * 0.42 + ax * c * 0.14);
    ctx.lineTo(cx + ax * size * 0.42 + ay * c * 0.14, cy + ay * size * 0.42 - ax * c * 0.14);
    ctx.closePath();
    ctx.fillStyle = pal.color;
    ctx.fill();

    // 头顶昵称
    if (label) {
      const text = label.you ? `${label.name}（你）` : label.name;
      const fs = Math.max(11, Math.round(c * 0.52));
      ctx.font = `700 ${fs}px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      // 贴边时把标签挪回画布内；在最上面一行时画到角色下方，避免被裁掉
      const tw = ctx.measureText(text).width;
      const boardW = this.gw * c;
      const lx = Math.min(Math.max(cx, tw / 2 + 3), boardW - tw / 2 - 3);
      const above = cy - size / 2 - 3 - fs >= 0;
      ctx.textBaseline = above ? 'bottom' : 'top';
      const ty = above ? cy - size / 2 - 3 : cy + size / 2 + 3;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineJoin = 'round';
      ctx.strokeText(text, lx, ty);
      ctx.fillStyle = '#0F172A';
      ctx.fillText(text, lx, ty);
      if (label.offline) {
        const tag = '掉线';
        ctx.font = `600 ${Math.max(10, fs - 2)}px system-ui, sans-serif`;
        const tagW = ctx.measureText(tag).width;
        const tx = Math.min(Math.max(cx, tagW / 2 + 3), boardW - tagW / 2 - 3);
        const tagY = above ? cy + size / 2 + 2 : cy - size / 2 - 2;
        ctx.textBaseline = above ? 'top' : 'bottom';
        ctx.strokeText(tag, tx, tagY);
        ctx.fillStyle = '#B45309';
        ctx.fillText(tag, tx, tagY);
      }
    }
    ctx.restore();
  }
}
