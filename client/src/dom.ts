// 极简 DOM 构建器。所有文本一律通过 textContent / createTextNode 输出，
// 从不使用 innerHTML，昵称等用户输入天然无法注入 HTML。

type Child = Node | string | number | null | undefined | false;
type Attrs = {
  class?: string;
  id?: string;
  style?: Partial<CSSStyleDeclaration>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
  [attr: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
    } else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

let toastBox: HTMLElement | null = null;

export function toast(text: string, kind: 'info' | 'warn' | 'ok' = 'info', ms = 2600): void {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: `toast toast-${kind}` }, text);
  toastBox.append(t);
  window.setTimeout(() => {
    t.classList.add('out');
    window.setTimeout(() => t.remove(), 300);
  }, ms);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 退化方案：临时 textarea + execCommand
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
