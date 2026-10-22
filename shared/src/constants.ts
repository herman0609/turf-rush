// 所有规则与协议参数集中在这里。服务端与客户端共用，避免两端各写一份。

export const PROTOCOL_VERSION = 1;

// ---- 地图与节奏 ----
export const GRID_W = 32;
export const GRID_H = 20;
export const TICK_MS = 50; // 20 Hz
export const DEFAULT_MATCH_SECONDS = 60;
export const COUNTDOWN_MS = 3000;

// ---- 移动（整数定点：1 格 = MOVE_UNITS 个单位）----
export const MOVE_UNITS = 6;
export const SPEED_NORMAL = 2; // 每 3 tick 前进 1 格 ≈ 6.7 格/秒
export const SPEED_DASH = 6; // 每 tick 前进 1 格（速度不得超过 MOVE_UNITS，保证每 tick 至多走一格）
export const DASH_TICKS = 12; // 冲刺持续 0.6 秒
export const DASH_COOLDOWN_TICKS = 80; // 冷却 4 秒，从冲刺开始计
export const TURN_QUEUE_MAX = 2;

// ---- 房间 ----
export const MAX_PLAYERS = 4;
export const MAX_SPECTATORS = 8;
export const NAME_MAX = 12;
export const ROOM_CODE_LEN = 5;
/** 去掉 0 O 1 I L 等易混字符后的 31 个字符 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// ---- 生命周期 ----
export const SEAT_GRACE_MS = 30_000;
export const SOLO_GRACE_MS = 10_000;
export const EMPTY_ROOM_TTL_MS = 5 * 60_000;

// ---- 同步与限流 ----
export const CHECKSUM_EVERY = 20; // 每 20 tick 附带一次全图校验和
export const MAX_INPUTS_PER_TICK = 4;
export const MAX_INPUT_QUEUE = 8;
/** 输入可以预约的最远 tick：next + 10（500ms）。更远的会被钳回来，防止"预约未来"刷队列 */
export const MAX_INPUT_LEAD_TICKS = 10;
export const MAX_MSG_BYTES = 1024;
export const RATE_PER_SEC = 20;
export const RATE_BURST = 40;
export const MAX_CATCHUP_TICKS = 4;

export type Dir = 'U' | 'D' | 'L' | 'R';
export const DIRS: readonly Dir[] = ['U', 'D', 'L', 'R'];
export const DX: Record<Dir, number> = { U: 0, D: 0, L: -1, R: 1 };
export const DY: Record<Dir, number> = { U: -1, D: 1, L: 0, R: 0 };

/** 出生点：按参赛者顺序取用。2 人局取前两个，正好是对角。 */
export const SPAWNS: readonly { x: number; y: number; dir: Dir }[] = [
  { x: 1, y: 1, dir: 'R' },
  { x: GRID_W - 2, y: GRID_H - 2, dir: 'L' },
  { x: GRID_W - 2, y: 1, dir: 'D' },
  { x: 1, y: GRID_H - 2, dir: 'U' },
];

export type Shape = 'circle' | 'triangle' | 'square' | 'diamond';

/** Okabe-Ito 色盲友好配色 + 形状双重编码。下标即座位号 slot。 */
export const PALETTE: readonly { color: string; label: string; shape: Shape; glyph: string }[] = [
  { color: '#0072B2', label: '蓝', shape: 'circle', glyph: '●' },
  { color: '#E69F00', label: '橙', shape: 'triangle', glyph: '▲' },
  { color: '#009E73', label: '绿', shape: 'square', glyph: '■' },
  { color: '#CC79A7', label: '紫', shape: 'diamond', glyph: '◆' },
];
