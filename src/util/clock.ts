export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ManualClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}

export function manualClock(iso: string): ManualClock {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set(next: string) {
      t = new Date(next).getTime();
    },
    advance(ms: number) {
      t += ms;
    },
  };
}
