// 全屏彩带：结算时的庆祝效果。独立的 fixed canvas，不拦截点击，播完自动移除。

export const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
}

let active: { canvas: HTMLCanvasElement; raf: number } | null = null;

export function stopConfetti(): void {
  if (!active) return;
  cancelAnimationFrame(active.raf);
  active.canvas.remove();
  active = null;
}

/** 从屏幕上方两侧喷出彩带；big=true 用于自己获胜 */
export function confetti(colors: readonly string[], big: boolean): void {
  stopConfetti();
  const count = REDUCED_MOTION ? 0 : big ? 170 : 60;
  if (count === 0) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  document.body.append(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const fromLeft = i % 2 === 0;
    const angle = (fromLeft ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const speed = (big ? 0.9 : 0.7) + Math.random() * 0.7;
    pieces.push({
      x: fromLeft ? W * 0.12 : W * 0.88,
      y: H * 0.55,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 1.25,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.02,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      color: colors[i % colors.length]!,
    });
  }

  const t0 = performance.now();
  let last = t0;
  const DURATION = 3200;
  const frame = (t: number) => {
    const dt = Math.min(40, t - last);
    last = t;
    const age = t - t0;
    ctx.clearRect(0, 0, W, H);
    const fade = age > DURATION - 700 ? Math.max(0, (DURATION - age) / 700) : 1;
    for (const p of pieces) {
      p.vy += 0.0016 * dt; // 重力
      p.vx *= 0.995;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // 用 cos 做翻转感
      ctx.scale(1, Math.abs(Math.cos(p.rot * 2)) * 0.8 + 0.2);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (age < DURATION && active) active.raf = requestAnimationFrame(frame);
    else stopConfetti();
  };
  active = { canvas, raf: requestAnimationFrame(frame) };
}

/** 数字从 0 滚动到目标值 */
export function countUp(el: HTMLElement, to: number, ms: number, format: (n: number) => string): void {
  if (REDUCED_MOTION || to === 0) {
    el.textContent = format(to);
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = format(Math.round(to * eased));
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  el.textContent = format(0);
  requestAnimationFrame(step);
}
