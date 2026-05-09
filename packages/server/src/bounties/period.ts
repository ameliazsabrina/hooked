import { BountyPeriod, type BountyPeriodDocument } from "../db/schema.js";
import { env } from "../config/env.js";
import {
  BOUNTY_TEMPLATES,
  WEEKLY_SLOT_COUNT,
  getTemplatesForNetwork,
  type BountyCadence,
  type BountyTemplate,
} from "./templates.js";

export function isDevnet(): boolean {
  return env.SOLANA_RPC_URL.toLowerCase().includes("devnet");
}

export function weekStartUtc(now: Date = new Date()): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const dow = d.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  return d;
}

export function weekEndUtc(start: Date): Date {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}

function sampleTemplates(
  pool: BountyTemplate[],
  n: number,
  seedKey: string
): BountyTemplate[] {
  let hash = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    hash ^= seedKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const rand = (i: number) => {
    const x = Math.sin(hash + i * 9301) * 10000;
    return x - Math.floor(x);
  };

  const copy = [...pool];
  const out: BountyTemplate[] = [];
  for (let i = 0; i < Math.min(n, copy.length); i++) {
    const idx = Math.floor(rand(i) * copy.length);
    const picked = copy[idx];
    if (picked) {
      out.push(picked);
      copy.splice(idx, 1);
    }
  }
  return out;
}

function buildSlots(templates: BountyTemplate[]) {
  return templates.map((t, i) => ({
    slot: i + 1,
    templateId: t.id,
    label: t.label,
    goalType: t.goalType,
    goalParams: t.goalParams,
    target: t.target,
    reward:
      t.reward.kind === "shells"
        ? { kind: "shells" as const, amount: t.reward.amount, lamports: null }
        : { kind: "sol" as const, amount: null, lamports: t.reward.lamports },
  }));
}

export async function getOrCreateCurrentPeriod(
  cadence: BountyCadence = "weekly",
  now: Date = new Date()
): Promise<BountyPeriodDocument & { _id: unknown }> {
  const startsAt = weekStartUtc(now);
  const endsAt = weekEndUtc(startsAt);

  const existing = await BountyPeriod.findOne({ cadence, startsAt }).lean();
  if (existing) return existing as BountyPeriodDocument & { _id: unknown };

  const devnet = isDevnet();
  const pool = getTemplatesForNetwork(devnet).filter(
    (t) => t.cadence === cadence
  );
  const seedKey = `${cadence}:${startsAt.toISOString()}`;
  const picked = sampleTemplates(pool, WEEKLY_SLOT_COUNT, seedKey);
  const slots = buildSlots(picked);

  try {
    const created = await BountyPeriod.create({
      cadence,
      startsAt,
      endsAt,
      slots,
    });
    return created.toObject() as BountyPeriodDocument & { _id: unknown };
  } catch (err: unknown) {
    const existingRetry = await BountyPeriod.findOne({
      cadence,
      startsAt,
    }).lean();
    if (existingRetry) {
      return existingRetry as BountyPeriodDocument & { _id: unknown };
    }
    throw err;
  }
}

export function getAllTemplates(): BountyTemplate[] {
  return BOUNTY_TEMPLATES;
}
