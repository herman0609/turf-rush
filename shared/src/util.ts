import { NAME_MAX, ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from './constants';

/** 规范化用户输入的房间码：去空白和连字符、转大写、校验字符集与长度。不合法返回 null。 */
export function normalizeRoomCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== ROOM_CODE_LEN) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** randomInt(n) 返回 [0, n) 的整数；服务端传入 crypto.randomInt */
export function generateRoomCode(randomInt: (n: number) => number): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return s;
}

/**
 * 昵称清洗：去掉控制字符/格式字符（含零宽字符、换行、双向控制符），折叠空白，
 * 按 Unicode 码点截断到 NAME_MAX。结果仍然只能当纯文本渲染。
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
}

/** 同房间重名时追加数字后缀，保证结果仍不超过 NAME_MAX */
export function dedupeName(name: string, taken: readonly string[]): string {
  const set = new Set(taken);
  if (!set.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = String(i);
    const base = Array.from(name).slice(0, NAME_MAX - suffix.length).join('');
    const candidate = base + suffix;
    if (!set.has(candidate)) return candidate;
  }
  return name;
}

const ADJ = ['迅捷的', '勇敢的', '快乐的', '神秘的', '闪亮的', '机灵的', '淡定的', '热情的', '顽皮的', '飞快的', '酷酷的', '认真的'];
const ANIMAL = ['水獭', '狐狸', '熊猫', '企鹅', '海豚', '松鼠', '考拉', '柴犬', '猫头鹰', '刺猬', '树懒', '小鹿'];

export function randomName(rand: () => number = Math.random): string {
  const a = ADJ[Math.floor(rand() * ADJ.length)]!;
  const b = ANIMAL[Math.floor(rand() * ANIMAL.length)]!;
  return a + b;
}

export interface StartCheckMember {
  id: string;
  name: string;
  role: 'player' | 'spectator';
  ready: boolean;
  online: boolean;
  left: boolean;
}

/**
 * 房主能否开始。返回 null 表示可以开始，否则返回给人看的原因。
 * 服务端用它做权威判断，客户端用同一函数显示按钮状态，保证两端一致。
 */
export function startBlocker(members: readonly StartCheckMember[], hostId: string | null): string | null {
  const players = members.filter((m) => m.role === 'player' && !m.left);
  if (players.length < 2) return '至少需要 2 名玩家';
  const offline = players.find((m) => !m.online);
  if (offline) return `等待 ${offline.name} 重连`;
  const notReady = players.find((m) => m.id !== hostId && !m.ready);
  if (notReady) return `等待 ${notReady.name} 准备`;
  return null;
}
