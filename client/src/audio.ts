// 音效：全部用 WebAudio 现场合成，不引入外部素材。
// 浏览器要求用户手势之后才能出声，所以 AudioContext 在第一次点击/按键时才创建。

const MUTE_KEY = 'turf.muted';
const MASTER = 0.55;

interface ToneOpts {
  f: number;
  /** 结束频率（指数滑音） */
  f2?: number;
  type?: OscillatorType;
  /** 相对当前时间的延迟（秒） */
  t?: number;
  dur?: number;
  vol?: number;
  attack?: number;
}

interface NoiseOpts {
  t?: number;
  dur?: number;
  vol?: number;
  from?: number;
  to?: number;
  q?: number;
}

class Sfx {
  private ac: AudioContext | null = null;
  private out: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private last = new Map<string, number>();
  private listeners = new Set<(muted: boolean) => void>();
  muted: boolean;

  constructor() {
    let m = false;
    try {
      m = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* 隐私模式下 localStorage 可能不可用 */
    }
    this.muted = m;
  }

  /** 在用户手势中调用：创建或恢复 AudioContext */
  unlock(): void {
    if (!this.ac) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ac = new AC();
      this.out = this.ac.createGain();
      this.out.gain.value = this.muted ? 0 : MASTER;
      // 压缩器兜底，多个音效叠加时不爆音
      const comp = this.ac.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.out.connect(comp);
      comp.connect(this.ac.destination);
    }
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ac && this.out) this.out.gain.setTargetAtTime(muted ? 0 : MASTER, this.ac.currentTime, 0.02);
    this.listeners.forEach((l) => l(muted));
  }

  toggle(): void {
    this.unlock();
    this.setMuted(!this.muted);
  }

  onChange(l: (muted: boolean) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** 返回可用的 AudioContext；静音、未解锁或命中节流时返回 null */
  private ready(key?: string, minGapMs = 0): AudioContext | null {
    if (this.muted || !this.ac || !this.out || this.ac.state !== 'running') return null;
    if (key) {
      const now = performance.now();
      if (now - (this.last.get(key) ?? -1e9) < minGapMs) return null;
      this.last.set(key, now);
    }
    return this.ac;
  }

  private tone(ac: AudioContext, o: ToneOpts): void {
    const { f, f2, type = 'sine', t = 0, dur = 0.12, vol = 0.3, attack = 0.005 } = o;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    const t0 = ac.currentTime + t;
    osc.type = type;
    osc.frequency.setValueAtTime(f, t0);
    if (f2) osc.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.out!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  private noise(ac: AudioContext, o: NoiseOpts): void {
    const { t = 0, dur = 0.25, vol = 0.2, from = 800, to = 3000, q = 1.2 } = o;
    if (!this.noiseBuf) {
      const len = Math.floor(ac.sampleRate * 0.5);
      this.noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    const g = ac.createGain();
    const t0 = ac.currentTime + t;
    bp.frequency.setValueAtTime(from, t0);
    bp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.out!);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  // ---------------------------------------------------------------- 具体音效

  /** 倒计时 3 / 2 / 1 */
  count(n: number): void {
    const ac = this.ready();
    if (!ac) return;
    this.tone(ac, { f: n === 1 ? 659 : 523, type: 'triangle', dur: 0.16, vol: 0.35 });
  }

  /** 开始！ */
  go(): void {
    const ac = this.ready();
    if (!ac) return;
    for (const f of [784, 988, 1175]) this.tone(ac, { f, type: 'triangle', dur: 0.4, vol: 0.22 });
    this.noise(ac, { dur: 0.25, vol: 0.12, from: 2000, to: 6000 });
  }

  /** 自己染色：音高随连续染色缓慢上升，节流避免嘈杂 */
  paint(combo: number): void {
    const ac = this.ready('paint', 75);
    if (!ac) return;
    const f = 520 * Math.pow(2, (combo % 12) / 24);
    this.tone(ac, { f, f2: f * 1.25, type: 'sine', dur: 0.06, vol: 0.09 });
  }

  /** 自己覆盖了别人的格子 */
  steal(): void {
    const ac = this.ready('steal', 110);
    if (!ac) return;
    this.tone(ac, { f: 880, f2: 1400, type: 'square', dur: 0.07, vol: 0.05 });
  }

  /** 自己的格子被别人覆盖 */
  stolen(): void {
    const ac = this.ready('stolen', 300);
    if (!ac) return;
    this.tone(ac, { f: 330, f2: 220, type: 'triangle', dur: 0.1, vol: 0.1 });
  }

  dash(): void {
    const ac = this.ready('dash', 120);
    if (!ac) return;
    this.noise(ac, { dur: 0.32, vol: 0.28, from: 500, to: 4500, q: 0.9 });
    this.tone(ac, { f: 180, f2: 520, type: 'sawtooth', dur: 0.22, vol: 0.05 });
  }

  /** 冲刺冷却结束 */
  dashReady(): void {
    const ac = this.ready('dashReady', 500);
    if (!ac) return;
    this.tone(ac, { f: 1047, type: 'sine', dur: 0.08, vol: 0.08 });
    this.tone(ac, { f: 1568, type: 'sine', t: 0.06, dur: 0.1, vol: 0.07 });
  }

  /** 按下方向键的即时反馈（不等服务端确认） */
  turn(): void {
    const ac = this.ready('turn', 40);
    if (!ac) return;
    this.tone(ac, { f: 1300, type: 'sine', dur: 0.03, vol: 0.05 });
  }

  /** 最后 10 秒：每秒一次心跳，最后 3 秒更急 */
  tick(urgent: boolean): void {
    const ac = this.ready();
    if (!ac) return;
    this.tone(ac, { f: urgent ? 1046 : 784, type: 'square', dur: 0.05, vol: urgent ? 0.09 : 0.06 });
    this.tone(ac, { f: 110, f2: 70, type: 'sine', dur: 0.14, vol: 0.35 });
  }

  /** 被反超 */
  overtaken(): void {
    const ac = this.ready('lead', 600);
    if (!ac) return;
    this.tone(ac, { f: 523, f2: 494, type: 'triangle', dur: 0.16, vol: 0.2 });
    this.tone(ac, { f: 415, f2: 370, type: 'triangle', t: 0.13, dur: 0.24, vol: 0.2 });
  }

  /** 反超别人 */
  lead(): void {
    const ac = this.ready('lead', 600);
    if (!ac) return;
    [659, 784, 1047].forEach((f, i) => this.tone(ac, { f, type: 'triangle', t: i * 0.07, dur: 0.16, vol: 0.18 }));
  }

  /** 时间到 */
  timeUp(): void {
    const ac = this.ready();
    if (!ac) return;
    this.tone(ac, { f: 988, type: 'square', dur: 0.16, vol: 0.08 });
    this.tone(ac, { f: 740, type: 'square', t: 0.17, dur: 0.32, vol: 0.08 });
  }

  win(): void {
    const ac = this.ready();
    if (!ac) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(ac, { f, type: 'triangle', t: i * 0.1, dur: 0.22, vol: 0.22 }));
    for (const f of [523, 659, 784, 1047]) this.tone(ac, { f, type: 'sine', t: 0.42, dur: 0.9, vol: 0.12, attack: 0.02 });
    this.noise(ac, { t: 0.4, dur: 0.6, vol: 0.08, from: 3000, to: 8000 });
  }

  lose(): void {
    const ac = this.ready();
    if (!ac) return;
    [523, 466, 415].forEach((f, i) => this.tone(ac, { f, type: 'sine', t: i * 0.16, dur: 0.3, vol: 0.18 }));
  }

  /** 平局 */
  draw(): void {
    const ac = this.ready();
    if (!ac) return;
    [587, 587, 784].forEach((f, i) => this.tone(ac, { f, type: 'triangle', t: i * 0.12, dur: 0.2, vol: 0.18 }));
  }

  /** 普通按钮/准备 */
  ui(): void {
    const ac = this.ready('ui', 40);
    if (!ac) return;
    this.tone(ac, { f: 660, type: 'sine', dur: 0.05, vol: 0.08 });
  }

  /** 有人进入房间 */
  join(): void {
    const ac = this.ready('join', 200);
    if (!ac) return;
    this.tone(ac, { f: 523, type: 'triangle', dur: 0.1, vol: 0.14 });
    this.tone(ac, { f: 784, type: 'triangle', t: 0.09, dur: 0.14, vol: 0.14 });
  }
}

export const sfx = new Sfx();

/** 第一次用户手势时解锁音频 */
export function installAudioUnlock(): void {
  const unlock = () => sfx.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function speakerIcon(muted: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const paths = muted
    ? ['M4 9v6h4l5 4V5L8 9H4z', 'M16.5 9.5l5 5', 'M21.5 9.5l-5 5']
    : ['M4 9v6h4l5 4V5L8 9H4z', 'M16 8.8a4.5 4.5 0 0 1 0 6.4', 'M18.6 6.2a8.2 8.2 0 0 1 0 11.6'];
  paths.forEach((d, i) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', i === 0 ? 'currentColor' : 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', i === 0 ? '1' : '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  });
  return svg;
}

/** 静音开关按钮；多个实例之间状态同步，快捷键 M */
export function muteButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mute-btn';
  const paint = (muted: boolean) => {
    btn.replaceChildren(speakerIcon(muted));
    btn.setAttribute('aria-pressed', String(muted));
    btn.setAttribute('aria-label', muted ? '打开音效' : '静音');
    btn.title = muted ? '打开音效（M）' : '静音（M）';
    btn.classList.toggle('off', muted);
  };
  paint(sfx.muted);
  btn.addEventListener('click', () => sfx.toggle());
  const off = sfx.onChange(paint);
  // 按钮被移出 DOM 后自动解绑
  const mo = new MutationObserver(() => {
    if (!btn.isConnected) {
      off();
      mo.disconnect();
    }
  });
  queueMicrotask(() => {
    if (btn.parentNode) mo.observe(document.body, { childList: true, subtree: true });
  });
  return btn;
}
