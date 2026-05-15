import type { Activity } from './types';

let clip: Activity | null = null;

export function setClip(a: Activity): void {
  clip = JSON.parse(JSON.stringify(a));
}

export function getClip(): Activity | null {
  return clip ? JSON.parse(JSON.stringify(clip)) : null;
}

export function hasClip(): boolean {
  return clip !== null;
}
