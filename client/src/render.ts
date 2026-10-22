// Canvas 2D 棋盘渲染。逻辑位置按格跳变，画面在"上一格 → 当前格"之间补间，转向不会突兀折线。
// 特效（染色弹出、粒子、冲刺拖影）只存在于渲染层，不影响任何游戏状态。

import { DASH_COOLDOWN_TICKS, PALETTE, type Shape } from '@turf/shared/constants';
import type { PState } from '@turf/shared/protocol';
import { REDUCED_MOTION } from './fx';
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

export interface DrawOpts {
  /** 0..1：在自己身上画"你在这里"脉冲光圈的强度（倒计时和开局时） */
  highlightYou: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

interface Ghost {
  x: number;
  y: number;
  t: number;
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

const POP_MS = 220;

/** 与 docs/DECISIONS.md 第 1 节的表格一致 */
const PALETTE_TEXTURE = ['dots', 'diagonal', 'grid', 'hstripes'] as const;
const GHOST_MS = 160;
const MAX_PARTICLES = 320;

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

/** easeOutBack：先冲过头一点再回弹，染色时有"啪"的一下 */
function easeOutBack(k: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

export class BoardRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  cell = 24;
  private gw = 32;
  private gh = 20;
  private dpr = 1;
  private tweens = new Map<string, Tween>();
  private paintedAt = new Float64Array(0);
  private particles: Particle[] = [];
  private ghosts = new Map<string, Ghost[]>();
  private lastDraw = 0;
  private patterns: (CanvasPattern | null)[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board';
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(maxW: number, maxH: number, gw: number, gh: number): void {
    if (gw !== this.gw || gh !== this.gh || this.paintedAt.length !== gw * gh) this.paintedAt = new Float64Array(gw * gh);
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
    this.buildPatterns();
  }

  /**
   * 地块纹理：颜色之外的第二重编码（色盲友好）。
   * 0 圆点 · 1 斜纹 · 2 网格 · 3 横纹。贴片边长等于一格，所以纹理与格子对齐、跨格连续。
   */
  private buildPatterns(): void {
    const px = Math.max(4, Math.round(this.cell * this.dpr));
    this.patterns = PALETTE.map((pal, slot) => {
      const tile = document.createElement('canvas');
      tile.width = px;
      tile.height = px;
      const t = tile.getContext('2d');
      if (!t) return null;
      t.strokeStyle = pal.color;
      t.fillStyle = pal.color;
      t.globalAlpha = 0.42;
      t.lineWidth = Math.max(1, px * 0.08);
      t.lineCap = 'square';
      t.beginPath();
      switch (PALETTE_TEXTURE[slot]) {
        case 'dots':
          t.arc(px / 2, px / 2, px * 0.13, 0, Math.PI * 2);
          t.fill();
          break;
        case 'diagonal':
          // 斜率 -1 的三条线，保证相邻贴片接缝处连续
          for (const k of [-0.5, 0, 0.5, 1]) {
            t.moveTo(k * px - px * 0.5, px);
            t.lineTo(k * px + px * 0.5, 0);
          }
          t.stroke();
          break;
        case 'grid':
          t.moveTo(px / 2, 0);
          t.lineTo(px / 2, px);
          t.moveTo(0, px / 2);
          t.lineTo(px, px / 2);
          t.stroke();
          break;
        case 'hstripes':
          t.moveTo(0, px * 0.3);
          t.lineTo(px, px * 0.3);
          t.moveTo(0, px * 0.7);
          t.lineTo(px, px * 0.7);
          t.stroke();
          break;
      }
      const pat = this.ctx.createPattern(tile, 'repeat');
      // 贴片按设备像素绘制，这里缩回 CSS 像素坐标
      pat?.setTransform(new DOMMatrix().scale(1 / this.dpr));
      return pat;
    });
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

  /** 新一局或重连：清空补间与特效 */
  reset(): void {
    this.tweens.clear();
    this.particles = [];
    this.ghosts.clear();
    this.paintedAt.fill(0);
  }

  /** 格子刚被染色：播放弹出动画 */
  markPainted(idx: number, now: number): void {
    if (idx >= 0 && idx < this.paintedAt.length) this.paintedAt[idx] = now;
  }

  /** 在格子中心喷出若干粒子 */
  burst(idx: number, slot: number, n: number): void {
    if (REDUCED_MOTION || n <= 0) return;
    const c = this.cell;
    const cx = (idx % this.gw) * c + c / 2;
    const cy = Math.floor(idx / this.gw) * c + c / 2;
    const color = PALETTE[slot]?.color ?? '#999';
    for (let i = 0; i < n && this.particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.04 + Math.random() * 0.1) * (c / 24);
      const max = 260 + Math.random() * 260;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 0.03 * (c / 24),
        life: max,
        max,
        size: Math.max(3, c * (0.18 + Math.random() * 0.16)),
        color,
      });
    }
  }

  private pos(tw: Tween, now: number): { x: number; y: number } {
    const k = Math.min(1, Math.max(0, (now - tw.t0) / tw.dur));
    return { x: tw.fx + (tw.tx - tw.fx) * k, y: tw.fy + (tw.ty - tw.fy) * k };
  }

  draw(game: ClientGame, labels: ReadonlyMap<string, PlayerLabel>, now: number, opts: DrawOpts): void {
    const { ctx, cell: c, gw, gh } = this;
    const dt = this.lastDraw ? Math.min(50, now - this.lastDraw) : 16;
    this.lastDraw = now;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, gw * c, gh * c);

    // 底板
    ctx.fillStyle = '#F7F8FC';
    ctx.fillRect(0, 0, gw * c, gh * c);

    // 地块：同一玩家的格子合成一条路径，先填浅色再叠纹理。
    // 刚染上的格子单独画：从小弹到满格，并带一层白色闪光。
    const pops: number[] = [];
    const paths = PALETTE.map(() => new Path2D());
    const has = PALETTE.map(() => false);
    for (let i = 0; i < game.cells.length; i++) {
      const o = game.cells[i]!;
      if (o < 0 || o >= paths.length) continue;
      const age = now - (this.paintedAt[i] ?? 0);
      if (age < POP_MS && !REDUCED_MOTION) {
        pops.push(i);
        continue;
      }
      paths[o]!.rect((i % gw) * c, Math.floor(i / gw) * c, c, c);
      has[o] = true;
    }
    for (let o = 0; o < paths.length; o++) {
      if (!has[o]) continue;
      ctx.fillStyle = CELL_TINT[o]!;
      ctx.fill(paths[o]!);
      const pat = this.patterns[o];
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fill(paths[o]!);
      }
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

    for (const i of pops) {
      const o = game.cells[i]!;
      const k = Math.min(1, (now - this.paintedAt[i]!) / POP_MS);
      const s = c * Math.min(1.12, 0.45 + 0.55 * easeOutBack(k));
      const x = (i % gw) * c + (c - s) / 2;
      const y = Math.floor(i / gw) * c + (c - s) / 2;
      ctx.fillStyle = CELL_TINT[o]!;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.65 * (1 - k)})`;
      ctx.fillRect(x, y, s, s);
    }

    // 冲刺拖影
    for (const p of game.players) {
      const label = labels.get(p.id);
      if (label?.left) continue;
      const tw = this.tweens.get(p.id);
      const pos = tw ? this.pos(tw, now) : { x: p.x, y: p.y };
      let list = this.ghosts.get(p.id);
      if (p.dashLeft > 0 && !REDUCED_MOTION) {
        if (!list) this.ghosts.set(p.id, (list = []));
        list.push({ x: pos.x, y: pos.y, t: now });
      }
      if (!list) continue;
      while (list.length && now - list[0]!.t > GHOST_MS) list.shift();
      const color = PALETTE[p.slot]!.color;
      for (const g of list) {
        const k = 1 - (now - g.t) / GHOST_MS;
        const s = c * (0.5 + 0.35 * k);
        ctx.globalAlpha = 0.35 * k;
        ctx.fillStyle = color;
        roundRect(ctx, g.x * c + (c - s) / 2, g.y * c + (c - s) / 2, s, s, s * 0.25);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 粒子
    if (this.particles.length) {
      const alive: Particle[] = [];
      for (const pt of this.particles) {
        pt.life -= dt;
        if (pt.life <= 0) continue;
        pt.vy += 0.0004 * dt * (c / 24);
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        const k = pt.life / pt.max;
        ctx.globalAlpha = Math.min(1, k * 1.4);
        ctx.fillStyle = pt.color;
        const s = pt.size * (0.5 + 0.5 * k);
        ctx.fillRect(pt.x - s / 2, pt.y - s / 2, s, s);
        alive.push(pt);
      }
      ctx.globalAlpha = 1;
      this.particles = alive;
    }

    // 角色（自己最后画，保证在最上层）
    const order = [...game.players].sort(
      (a, b) => Number(labels.get(a.id)?.you ?? false) - Number(labels.get(b.id)?.you ?? false),
    );
    for (const p of order) {
      const label = labels.get(p.id);
      if (label?.left) continue;
      const tw = this.tweens.get(p.id);
      const pos = tw ? this.pos(tw, now) : { x: p.x, y: p.y };
      if (label?.you && opts.highlightYou > 0) this.drawYouRing(pos.x, pos.y, now, opts.highlightYou, p.slot);
      this.drawPlayer(p, pos.x, pos.y, label);
    }
  }

  /** "你在这里"：脉冲光圈 */
  private drawYouRing(gx: number, gy: number, now: number, strength: number, slot: number): void {
    const { ctx, cell: c } = this;
    const cx = gx * c + c / 2;
    const cy = gy * c + c / 2;
    const phase = (now % 900) / 900;
    ctx.save();
    for (let i = 0; i < 2; i++) {
      const k = (phase + i * 0.5) % 1;
      ctx.globalAlpha = strength * (1 - k) * 0.8;
      ctx.strokeStyle = PALETTE[slot]!.color;
      ctx.lineWidth = Math.max(2, c * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, c * (0.7 + k * 1.6), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPlayer(p: PState, gx: number, gy: number, label: PlayerLabel | undefined): void {
    const { ctx, cell: c } = this;
    const pal = PALETTE[p.slot]!;
    const cx = gx * c + c / 2;
    const cy = gy * c + c / 2;
    const size = c * (p.dashLeft > 0 ? 1.0 : 0.92);
    const dim = p.frozen || label?.offline;

    ctx.save();
    ctx.globalAlpha = dim ? 0.45 : 1;
    // 冲刺光晕
    if (p.dashLeft > 0) {
      ctx.shadowColor = pal.color;
      ctx.shadowBlur = c * 0.9;
    } else {
      ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
      ctx.shadowBlur = c * 0.25;
      ctx.shadowOffsetY = c * 0.06;
    }
    roundRect(ctx, cx - size / 2, cy - size / 2, size, size, c * 0.22);
    ctx.fillStyle = pal.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = Math.max(1.5, c * 0.08);
    ctx.strokeStyle = label?.you ? '#0F172A' : '#FFFFFF';
    ctx.stroke();

    // 自己的冲刺冷却环：一圈逐渐补满，满了就能再冲
    if (label?.you && p.dashLeft === 0 && p.cdLeft > 0) {
      const prog = 1 - p.cdLeft / DASH_COOLDOWN_TICKS;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.72, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
      ctx.lineWidth = Math.max(1.5, c * 0.07);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

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
