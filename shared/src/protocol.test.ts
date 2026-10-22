import { describe, expect, it } from 'vitest';
import { NAME_MAX, ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from './constants';
import { parseClientMessage } from './protocol';
import { dedupeName, generateRoomCode, normalizeRoomCode, sanitizeName, startBlocker } from './util';

describe('parseClientMessage', () => {
  it('接受合法消息', () => {
    expect(parseClientMessage({ t: 'join', v: 1, code: 'ABCDE', name: 'x' }).ok).toBe(true);
    expect(parseClientMessage({ t: 'input', seq: 1, dir: 'U' }).ok).toBe(true);
    expect(parseClientMessage({ t: 'input', seq: 2, dash: true }).ok).toBe(true);
    expect(parseClientMessage({ t: 'ping', c: 123.5 }).ok).toBe(true);
  });

  it.each([
    ['未知类型', { t: 'teleport', x: 1 }],
    ['多余字段（试图上报位置）', { t: 'input', seq: 1, dir: 'U', x: 3 }],
    ['非法方向', { t: 'input', seq: 1, dir: 'X' }],
    ['seq 非整数', { t: 'input', seq: 1.5, dir: 'U' }],
    ['seq 为 0', { t: 'input', seq: 0, dir: 'U' }],
    ['空输入', { t: 'input', seq: 1 }],
    ['dash 为 false', { t: 'input', seq: 1, dash: false }],
    ['昵称过长', { t: 'join', v: 1, code: 'ABCDE', name: 'x'.repeat(65) }],
    ['ping 非数字', { t: 'ping', c: 'now' }],
    ['不是对象', 'hello'],
    ['null', null],
  ])('拒绝：%s', (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});

describe('房间码', () => {
  it('生成的房间码只包含合法字符', () => {
    let i = 0;
    const seq = [0, 30, 5, 17, 9];
    const code = generateRoomCode(() => seq[i++ % seq.length]!);
    expect(code).toHaveLength(ROOM_CODE_LEN);
    for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
  });

  it('字母表不含易混字符', () => {
    for (const ch of '01OIL') expect(ROOM_CODE_ALPHABET).not.toContain(ch);
  });

  it('输入规范化：大小写、空格、连字符', () => {
    expect(normalizeRoomCode(' ab-c de ')).toBe('ABCDE');
    expect(normalizeRoomCode('ABCD')).toBeNull();
    expect(normalizeRoomCode('ABCD0')).toBeNull();
    expect(normalizeRoomCode('<scr')).toBeNull();
  });
});

describe('昵称', () => {
  it('去除控制字符、零宽字符与换行，折叠空白', () => {
    expect(sanitizeName('  小\u200b明\n\t 你好 ')).toBe('小明 你好');
    expect(sanitizeName('\u202Eabc')).toBe('abc');
  });

  it('按码点截断到上限', () => {
    expect(Array.from(sanitizeName('一二三四五六七八九十十一十二'))).toHaveLength(NAME_MAX);
  });

  it('HTML 字符原样保留（渲染层只当纯文本）', () => {
    expect(sanitizeName('<img onerror=1>')).toBe('<img onerror=1>'.slice(0, NAME_MAX));
  });

  it('重名追加后缀且不超长', () => {
    expect(dedupeName('小明', ['小明'])).toBe('小明2');
    expect(dedupeName('小明', ['小明', '小明2'])).toBe('小明3');
    const long = '一二三四五六七八九十十一';
    expect(Array.from(dedupeName(long, [long])).length).toBeLessThanOrEqual(NAME_MAX);
  });
});

describe('startBlocker', () => {
  const m = (id: string, extra: Partial<Parameters<typeof startBlocker>[0][number]> = {}) => ({
    id,
    name: id,
    role: 'player' as const,
    ready: false,
    online: true,
    left: false,
    ...extra,
  });

  it('不足 2 人', () => {
    expect(startBlocker([m('h')], 'h')).toBe('至少需要 2 名玩家');
  });
  it('有人未准备（房主无需准备）', () => {
    expect(startBlocker([m('h'), m('b')], 'h')).toBe('等待 b 准备');
    expect(startBlocker([m('h'), m('b', { ready: true })], 'h')).toBeNull();
  });
  it('有人离线', () => {
    expect(startBlocker([m('h'), m('b', { ready: true, online: false })], 'h')).toBe('等待 b 重连');
  });
  it('观战者不计入', () => {
    expect(startBlocker([m('h'), m('s', { role: 'spectator' })], 'h')).toBe('至少需要 2 名玩家');
  });
});
