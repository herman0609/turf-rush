// 身份（playerId + token）存 sessionStorage：每个标签页独立，同一浏览器开两个标签页就是两个人。
// 昵称是偏好，存 localStorage，下次打开自动带上。

import type { RoomStatus } from '@turf/shared/protocol';
import { randomName } from '@turf/shared/util';

export interface Identity {
  playerId: string;
  token: string;
}

const idKey = (code: string) => `turf:id:${code}`;
const createdKey = (code: string) => `turf:created:${code}`;
const NAME_KEY = 'turf:name';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getIdentity(code: string): Identity | null {
  return safe(() => {
    const raw = sessionStorage.getItem(idKey(code));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Identity>;
    return typeof v.playerId === 'string' && typeof v.token === 'string' ? (v as Identity) : null;
  }, null);
}

export function setIdentity(code: string, id: Identity): void {
  safe(() => sessionStorage.setItem(idKey(code), JSON.stringify(id)), undefined);
}

export function clearIdentity(code: string): void {
  safe(() => sessionStorage.removeItem(idKey(code)), undefined);
}

/** 创建者跳转到 /r/CODE 后直接加入，不再二次确认昵称 */
export function markCreated(code: string): void {
  safe(() => sessionStorage.setItem(createdKey(code), '1'), undefined);
}

export function consumeCreated(code: string): boolean {
  return safe(() => {
    const v = sessionStorage.getItem(createdKey(code)) === '1';
    sessionStorage.removeItem(createdKey(code));
    return v;
  }, false);
}

export function getNickname(): string {
  return safe(() => localStorage.getItem(NAME_KEY), null) || randomName();
}

export function saveNickname(name: string): void {
  safe(() => localStorage.setItem(NAME_KEY, name), undefined);
}

export async function createRoom(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (res.status === 429) throw new Error('创建太频繁了，请稍后再试');
  if (!res.ok) throw new Error('服务器繁忙，请稍后再试');
  const body = (await res.json()) as { code: string };
  return body.code;
}

export async function getRoomStatus(code: string): Promise<RoomStatus> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (res.status === 429) throw new Error('查询太频繁了，请稍后再试');
  if (!res.ok) throw new Error('网络异常，请稍后再试');
  return (await res.json()) as RoomStatus;
}
