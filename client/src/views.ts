// 非对局页面：首页、加入确认、提示页、大厅。全部用 h() 构建，文本只走 textContent。

import { MAX_PLAYERS, NAME_MAX, PALETTE } from '@turf/shared/constants';
import type { MemberView, RoomStatus, RoomView } from '@turf/shared/protocol';
import { normalizeRoomCode, randomName, startBlocker } from '@turf/shared/util';
import { h } from './dom';
import { muteButton } from './audio';

export interface Action {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

function nameField(initial: string) {
  const input = h('input', {
    class: 'input',
    value: initial,
    maxLength: NAME_MAX,
    autocomplete: 'nickname',
    'aria-label': '昵称',
    spellcheck: false,
  });
  const reroll = h(
    'button',
    { class: 'btn ghost', type: 'button', title: '换一个随机昵称', on: { click: () => (input.value = randomName()) } },
    '换一个',
  );
  const el = h('label', { class: 'field' }, h('span', { class: 'field-label' }, '你的昵称'), h('div', { class: 'row' }, input, reroll));
  return { el, input, value: () => input.value.trim() || randomName() };
}

const RULES = [
  '方向键 / WASD 转向，空格冲刺（4 秒冷却）',
  '跑过的格子染成你的颜色，可以覆盖别人的',
  '60 秒后占格最多的人获胜',
];

function rulesCard() {
  return h('ul', { class: 'rules' }, ...RULES.map((r) => h('li', {}, r)));
}

export function homeView(opts: {
  name: string;
  onCreate: (name: string) => Promise<void>;
  onJoin: (name: string, code: string) => void;
}): HTMLElement {
  const nf = nameField(opts.name);
  const createBtn = h('button', { class: 'btn primary big', type: 'button' }, '创建房间');
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    createBtn.textContent = '创建中…';
    try {
      await opts.onCreate(nf.value());
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = '创建房间';
    }
  });

  const codeInput = h('input', {
    class: 'input code-input',
    placeholder: '输入 5 位房间码',
    maxLength: 9,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': '房间码',
  });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const joinForm = h(
    'form',
    {
      class: 'row',
      on: {
        submit: (e: Event) => {
          e.preventDefault();
          const code = normalizeRoomCode(codeInput.value);
          if (!code) {
            err.textContent = '房间码是 5 位字母或数字（不含 0/O/1/I/L）';
            return;
          }
          opts.onJoin(nf.value(), code);
        },
      },
    },
    codeInput,
    h('button', { class: 'btn', type: 'submit' }, '加入'),
  );

  return h(
    'main',
    { class: 'page home' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'logo', 'aria-hidden': 'true' }, ...PALETTE.map((p) => h('span', { style: { background: p.color } }, p.glyph))),
      h('h1', {}, '60 秒抢地盘'),
      h('p', { class: 'tagline' }, '跑起来，把地图染成你的颜色。2–4 人实时对战，无需注册。'),
      nf.el,
      createBtn,
      h('div', { class: 'divider' }, h('span', {}, '或者加入朋友的房间')),
      joinForm,
      err,
      rulesCard(),
    ),
  );
}

export function joinView(opts: {
  code: string;
  name: string;
  status: RoomStatus;
  onJoin: (name: string) => void;
  onHome: () => void;
}): HTMLElement {
  const nf = nameField(opts.name);
  const s = opts.status;
  let note = `房间里有 ${s.players ?? 0} 名玩家，确认昵称后加入。`;
  let label = '加入房间';
  if (s.full) {
    note = `房间已满（${MAX_PLAYERS}/${MAX_PLAYERS}），你可以先观战，有空位时下一局自动加入。`;
    label = '进入观战';
  } else if (s.phase === 'countdown' || s.phase === 'playing') {
    note = '对局正在进行，你将先以观战身份进入，下一局自动加入。';
    label = '进入观战';
  }
  const btn = h('button', { class: 'btn primary big', type: 'submit' }, label);
  return h(
    'main',
    { class: 'page' },
    h(
      'form',
      {
        class: 'card',
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            btn.disabled = true;
            opts.onJoin(nf.value());
          },
        },
      },
      h('p', { class: 'eyebrow' }, '好友邀请你加入'),
      h('h1', {}, '房间 ', h('span', { class: 'mono' }, opts.code)),
      h('p', { class: 'note' }, note),
      nf.el,
      btn,
      h('button', { class: 'btn link', type: 'button', on: { click: opts.onHome } }, '返回首页'),
      rulesCard(),
    ),
  );
}

export function messageView(opts: { title: string; text: string; actions: Action[]; tone?: 'warn' | 'info' }): HTMLElement {
  return h(
    'main',
    { class: 'page' },
    h(
      'div',
      { class: `card message ${opts.tone ?? 'info'}` },
      h('h1', {}, opts.title),
      h('p', { class: 'note' }, opts.text),
      h(
        'div',
        { class: 'actions' },
        ...opts.actions.map((a) =>
          h('button', { class: `btn ${a.primary ? 'primary big' : ''}`, type: 'button', on: { click: a.onClick } }, a.label),
        ),
      ),
    ),
  );
}

export function connectingView(text = '正在连接…'): HTMLElement {
  return h('main', { class: 'page' }, h('div', { class: 'card center' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, text)));
}

export function playerBadge(slot: number | null): HTMLElement {
  if (slot === null) return h('span', { class: 'badge spectator', 'aria-hidden': 'true' }, '👁︎');
  const p = PALETTE[slot]!;
  return h('span', { class: 'badge', style: { background: p.color }, title: p.label, 'aria-hidden': 'true' }, p.glyph);
}

function memberRow(m: MemberView, room: RoomView, you: string | null, serverNow: number): HTMLElement {
  const tags: HTMLElement[] = [];
  if (m.id === room.hostId) tags.push(h('span', { class: 'tag host' }, '房主'));
  if (m.id === you) tags.push(h('span', { class: 'tag you' }, '你'));
  if (!m.online && m.offlineUntil !== null) {
    const left = Math.max(0, Math.ceil((m.offlineUntil - serverNow) / 1000));
    tags.push(h('span', { class: 'tag offline' }, `掉线，重连中 ${left}s`));
  } else if (m.role === 'player') {
    if (m.id === room.hostId) tags.push(h('span', { class: 'tag muted' }, '无需准备'));
    else tags.push(h('span', { class: `tag ${m.ready ? 'ready' : 'muted'}` }, m.ready ? '已准备' : '未准备'));
  }
  return h(
    'li',
    { class: `member ${m.online ? '' : 'is-offline'}` },
    playerBadge(m.slot),
    h('span', { class: 'member-name' }, m.name),
    h('span', { class: 'tags' }, ...tags),
  );
}

export function lobbyView(opts: {
  room: RoomView;
  you: string | null;
  inviteUrl: string;
  serverNow: number;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  onCopy: () => void;
  onShare: (() => void) | null;
}): HTMLElement {
  const { room, you } = opts;
  const live = room.members.filter((m) => !m.left);
  const players = live.filter((m) => m.role === 'player').sort((a, b) => (a.slot ?? 9) - (b.slot ?? 9));
  const spectators = live.filter((m) => m.role === 'spectator');
  const me = live.find((m) => m.id === you);
  const isHost = !!me && me.id === room.hostId;

  let primary: HTMLElement;
  let hint = '';
  if (isHost) {
    const why = startBlocker(live, room.hostId);
    primary = h('button', { class: 'btn primary big', type: 'button', disabled: !!why, on: { click: opts.onStart } }, '开始游戏');
    hint = why ?? '人齐了，开始吧！';
  } else if (me?.role === 'player') {
    primary = h(
      'button',
      { class: `btn big ${me.ready ? 'ready-on' : 'primary'}`, type: 'button', on: { click: () => opts.onReady(!me.ready) } },
      me.ready ? '已准备（点击取消）' : '准备',
    );
    hint = me.ready ? '等待房主开始…' : '准备好了就点一下';
  } else {
    primary = h('button', { class: 'btn big', type: 'button', disabled: true }, '观战中');
    hint = '房间已满，有空位时自动加入';
  }

  const last = room.lastResult;
  let lastLine: HTMLElement | null = null;
  if (last) {
    const names = last.winners.map((id) => last.ranking.find((r) => r.id === id)?.name ?? '?');
    lastLine = h(
      'p',
      { class: 'last-result' },
      `上一局：${names.length > 1 ? `平局（${names.join('、')}）` : names.length === 1 ? `${names[0]} 获胜` : '无人获胜'}`,
    );
  }

  return h(
    'main',
    { class: 'page lobby' },
    h(
      'div',
      { class: 'card wide' },
      h('div', { class: 'card-corner' }, muteButton()),
      h(
        'header',
        { class: 'lobby-head' },
        h('div', {}, h('p', { class: 'eyebrow' }, '房间码'), h('div', { class: 'room-code mono', 'aria-label': `房间码 ${room.code}` }, room.code)),
        h(
          'div',
          { class: 'invite' },
          h('p', { class: 'eyebrow' }, '把链接发给朋友，打开就能加入'),
          h(
            'div',
            { class: 'row' },
            h('input', { class: 'input mono', readOnly: true, value: opts.inviteUrl, 'aria-label': '邀请链接', on: { focus: (e: FocusEvent) => (e.target as HTMLInputElement).select() } }),
            h('button', { class: 'btn', type: 'button', on: { click: opts.onCopy } }, '复制邀请链接'),
            opts.onShare ? h('button', { class: 'btn ghost', type: 'button', on: { click: opts.onShare } }, '分享') : null,
          ),
        ),
      ),
      h('h2', {}, `玩家 ${players.length}/${MAX_PLAYERS}`),
      h(
        'ul',
        { class: 'members' },
        ...players.map((m) => memberRow(m, room, you, opts.serverNow)),
        ...Array.from({ length: MAX_PLAYERS - players.length }, () =>
          h('li', { class: 'member empty' }, h('span', { class: 'badge empty' }), h('span', { class: 'member-name' }, '等待加入…')),
        ),
      ),
      spectators.length
        ? h('div', {}, h('h3', {}, `观战 ${spectators.length}`), h('ul', { class: 'members small' }, ...spectators.map((m) => memberRow(m, room, you, opts.serverNow))))
        : null,
      h('div', { class: 'lobby-actions' }, primary, h('p', { class: 'hint' }, hint)),
      lastLine,
      h(
        'footer',
        { class: 'lobby-foot' },
        rulesCard(),
        h('button', { class: 'btn link danger', type: 'button', on: { click: opts.onLeave } }, '离开房间'),
      ),
    ),
  );
}
