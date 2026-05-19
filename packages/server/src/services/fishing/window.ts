// UTC window rules:
//   00:00–01:59 → night of YESTERDAY
//   02:00–13:59 → day
//   14:00–23:59 → night
// dateKey is days-since-epoch (full int, not u16-truncated).

export interface WindowAssignment {
  window: 0 | 1;
  dateKey: number;
}

export function assignWindow(now: Date): WindowAssignment {
  const hour = now.getUTCHours();
  const dt = new Date(now);
  let window: 0 | 1;
  if (hour < 2) {
    window = 1;
    dt.setUTCDate(dt.getUTCDate() - 1);
  } else if (hour < 14) {
    window = 0;
  } else {
    window = 1;
  }
  const dateKey = Math.floor(
    Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) /
      (24 * 60 * 60 * 1000),
  );
  return { window, dateKey };
}

/** Convert a dateKey (days-since-epoch) to ISO date string for human display. */
export function dateKeyToISO(dateKey: number): string {
  return new Date(dateKey * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
