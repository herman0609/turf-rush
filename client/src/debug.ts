// 调试面板：演示弱网表现用。打开方式：?debug=1、任一弱网参数（?lag / ?jitter / ?chaos），或按 ` 键切换。
// 只用 textContent 渲染。

import { h } from './dom';
import { NET_SIM, NET_SIM_ON } from './net';

export type DebugRow = [label: string, value: string, warn?: boolean];

const KEY = 'turf.debug';

export class DebugPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  visible: boolean;

  constructor() {
    const q = new URLSearchParams(location.search);
    this.visible = NET_SIM_ON || q.get('debug') === '1' || sessionStorage.getItem(KEY) === '1';
    const sim = NET_SIM_ON
      ? `模拟弱网 lag ${NET_SIM.lag}ms · jitter ${NET_SIM.jitter}ms${NET_SIM.chaos ? ' · chaos' : ''}`
      : '未模拟弱网（可加 ?lag=200&jitter=40&chaos=1）';
    this.body = h('div', { class: 'debug-body' });
    this.el = h(
      'aside',
      { class: `debug${this.visible ? '' : ' hidden'}`, 'aria-label': '调试面板' },
      h('div', { class: 'debug-title' }, h('strong', {}, '调试'), h('span', {}, ' ` 键关闭')),
      h('div', { class: `debug-sim${NET_SIM_ON ? ' on' : ''}` }, sim),
      this.body,
    );
    document.body.append(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    sessionStorage.setItem(KEY, this.visible ? '1' : '0');
    this.el.classList.toggle('hidden', !this.visible);
  }

  update(rows: readonly DebugRow[]): void {
    if (!this.visible) return;
    const frag = document.createDocumentFragment();
    for (const [label, value, warn] of rows) {
      frag.append(h('span', { class: 'debug-k' }, label), h('span', { class: `debug-v${warn ? ' warn' : ''}` }, value));
    }
    this.body.replaceChildren(frag);
  }
}
