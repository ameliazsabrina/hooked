import mongoose, { Schema, type InferSchemaType } from "mongoose";

const playerSchema = new Schema(
  {
    walletAddress: { type: String, required: true, unique: true, index: true },
    nickname: {
      type: String,
      unique: true,
      sparse: true,
      default: null,
      trim: true,
      minlength: 3,
      maxlength: 16,
    },
    deposits: {
      type: [
        {
          poolId: { type: String, required: true },
          amount: { type: Number, required: true },
          depositTxSignature: { type: String, required: true },
          returnTxSignature: { type: String, default: null },
          activeMonth: { type: String, required: true },
          depositedAt: { type: Date, required: true },
          expiresAt: { type: Date, required: true },
          returned: { type: Boolean, required: true, default: false },
          returnedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    currentPoolId: { type: String, default: null },
    skin: {
      type: {
        head: { type: Number, required: true },
        shirt: { type: Number, required: true },
        pants: { type: Number, required: true },
        shoes: { type: Number, required: true },
      },
      default: null,
    },
    shellBalance: { type: Number, required: true, default: 0 },
    equipment: {
      type: {
        rodTier: { type: Number, required: true, default: 0 },
        rodEquipped: { type: String, required: true, default: "old" },
        baitEquipped: { type: String, required: true, default: "fly" },
        luckyLureTier: { type: Number, required: true, default: 0 },
        ownedRods: { type: [String], required: true, default: ["old"] },
        ownedBaits: { type: [String], required: true, default: ["fly"] },
      },
      default: () => ({
        rodTier: 0,
        rodEquipped: "old",
        baitEquipped: "fly",
        luckyLureTier: 0,
        ownedRods: ["old"],
        ownedBaits: ["fly"],
      }),
    },
    loginStreak: { type: Number, required: true, default: 0 },
    totalCatches: { type: Number, required: true, default: 0 },
    // Lifetime aggregate of session_score; bumped by sessionEngine.commitSession.
    totalScore: { type: Number, required: true, default: 0 },
    lastSeenAt: { type: Date, default: null },
    ipCountry: { type: String, default: null },
  },
  { timestamps: true },
);

const catchSchema = new Schema(
  {
    playerId: {
      type: Schema.Types.ObjectId,
      ref: "Player",
      required: true,
      index: true,
    },
    // Null on legacy rows written by the deprecated ER webhook.
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "FishingSession",
      default: null,
      index: true,
    },
    // Position within the session — used by the audit Merkle tree.
    castIndex: { type: Number, default: null },
    // Canonical id for audit/migrations. Null on apex catches (identified by apexFishId).
    speciesId: { type: Number, default: null },
    apexFishId: {
      type: Schema.Types.ObjectId,
      ref: "ApexFish",
      default: null,
      index: true,
    },
    species: { type: String, required: true },
    rarity: {
      type: String,
      required: true,
      enum: ["basic", "rare", "monster", "legendary", "apex"],
    },
    weightKg: { type: Number, required: true },
    score: { type: Number, required: true },
    // Legacy rows with other zones still load (enum validation is save-time).
    zone: {
      type: String,
      required: true,
      enum: ["open_sea"],
    },
    isBounty: { type: Boolean, required: true, default: false },
    eventTag: { type: String, default: null },
    released: { type: Boolean, required: true, default: false },
    sellValue: { type: Number, required: true, default: 0 },
    soldAt: { type: Date, default: null },
    soldPrice: { type: Number, default: null },
    caughtAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

catchSchema.index({ playerId: 1, caughtAt: -1 });
catchSchema.index({ caughtAt: -1, score: -1 });
catchSchema.index({ sessionId: 1, castIndex: 1 });

const poolTierSchema = new Schema(
  {
    tier: { type: Number, required: true, enum: [1] },
    activeMonth: { type: String, required: true },
    totalDepositedSol: { type: Number, required: true, default: 0 },
    realPlayerCount: { type: Number, required: true, default: 0 },

    onChainPoolId: { type: String, default: null },
    onChainPoolAddress: { type: String, default: null },

    startedAt: { type: Date, default: null },
    entryClosesAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["open", "locked", "closed"],
      default: "open",
    },

    totalYieldSol: { type: Number, default: null },

    winners: {
      type: [
        {
          rank: { type: Number, required: true },
          walletAddress: { type: String, required: true },
          displayName: { type: String, required: true },
          prizeSol: { type: Number, required: true },
          paid: { type: Boolean, required: true, default: false },
          signature: { type: String, default: null },
          paidAt: { type: Date, default: null },
          attempts: { type: Number, required: true, default: 0 },
          lastError: { type: String, default: null },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);
poolTierSchema.index({ tier: 1, activeMonth: 1 }, { unique: true });

const leaderboardEntrySchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, ref: "Player", default: null },
    displayName: { type: String, required: true },
    dailyScore: { type: Number, required: true, default: 0 },
    catchCount: { type: Number, required: true, default: 0 },
    topCatch: {
      type: {
        species: { type: String, required: true },
        rarity: { type: String, required: true },
        weightKg: { type: Number, required: true },
        score: { type: Number, required: true },
      },
      default: null,
    },
  },
  { _id: false },
);

const finalRankSchema = new Schema(
  {
    rank: { type: Number, required: true },
    playerId: { type: Schema.Types.ObjectId, ref: "Player", default: null },
    displayName: { type: String, required: true },
    prizeSOL: { type: Number, required: true },
  },
  { _id: false },
);

const dailyLeaderboardSchema = new Schema(
  {
    date: { type: String, required: true },
    tier: { type: Number, required: true, enum: [1] },
    entries: { type: [leaderboardEntrySchema], default: [] },
    prizePool: { type: Number, required: true, default: 0 },
    distributed: { type: Boolean, required: true, default: false },
    finalRanks: { type: [finalRankSchema], default: null },
  },
  { timestamps: true },
);
dailyLeaderboardSchema.index({ date: 1, tier: 1 }, { unique: true });

const roomPlayerSchema = new Schema(
  {
    walletAddress: { type: String, required: true },
    deposit: { type: Number, required: true },
    depositTxSignature: { type: String, required: true },
    depositedAt: { type: Date, required: true },
    returned: { type: Boolean, required: true, default: false },
    returnTxSignature: { type: String, default: null },
    returnedAt: { type: Date, default: null },
  },
  { _id: false },
);

const roomWinnerSchema = new Schema(
  {
    rank: { type: Number, required: true },
    walletAddress: { type: String, required: true },
    displayName: { type: String, required: true },
    prizeSol: { type: Number, required: true },
  },
  { _id: false },
);

const roomSchema = new Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },

    createdAt: { type: Date, required: true },
    entryClosesAt: { type: Date, required: true },
    closesAt: { type: Date, required: true },
    phase: {
      type: String,
      enum: ["entry", "active", "settling", "closed"],
      default: "entry",
      required: true,
    },

    capacitySol: { type: Number, required: true, default: 20 },
    maxPlayers: { type: Number, required: true, default: 40 },

    depositedSol: { type: Number, required: true, default: 0 },
    realPlayerCount: { type: Number, required: true, default: 0 },

    onChainPoolId: { type: String, default: null },
    onChainPoolAddress: { type: String, default: null },

    totalYieldSol: { type: Number, default: null },

    // LP cycle tracking (Meteora DLMM SOL/USDC). realizedYieldLamports is
    // clamped to 0 on net loss (LP_MANAGER buffer covers the gap).
    lp: {
      type: {
        status: {
          type: String,
          enum: [
            "pending",
            "deployed",
            "exited",
            "failed",
            "failed_permanent",
            "skipped",
          ],
          default: "pending",
        },
        deployAttempts: { type: Number, default: 0 },
        exitAttempts: { type: Number, default: 0 },
        positionPubkey: { type: String, default: null },
        deployedLamports: { type: Number, default: null },
        deployedAt: { type: Date, default: null },
        deployTxSignature: { type: String, default: null },
        exitedLamports: { type: Number, default: null },
        exitedAt: { type: Date, default: null },
        feesLamports: { type: Number, default: null },
        swapSlippageLamports: { type: Number, default: null },
        realizedYieldLamports: { type: Number, default: null },
        bufferTopUpLamports: { type: Number, default: null },
        lastError: { type: String, default: null },
        withdrawTxSignature: { type: String, default: null },
        swapInTxSignature: { type: String, default: null },
        swapInSolLamports: { type: Number, default: null },
        swapInUsdcRaw: { type: String, default: null },
        addLiquidityTxSignature: { type: String, default: null },
        removeLiquidityTxSignature: { type: String, default: null },
        removeLiquidityUsdcRaw: { type: String, default: null },
        removeLiquiditySolLamports: { type: Number, default: null },
        swapOutTxSignature: { type: String, default: null },
        swapOutUsdcRaw: { type: String, default: null },
        swapOutSolLamports: { type: Number, default: null },
        depositYieldTxSignature: { type: String, default: null },
      },
      default: () => ({ status: "pending" }),
    },

    players: { type: [roomPlayerSchema], default: [] },

    winners: { type: [roomWinnerSchema], default: [] },

    createdByAdmin: { type: String, required: true },

    overflowTriggered: { type: Boolean, required: true, default: false },

    createTxSignature: { type: String, default: null },
    closeTxSignature: { type: String, default: null },
    finalizeTxSignature: { type: String, default: null },

    // Set when settleRoom finds Redis ahead of the on-chain top-3 cache —
    // indicates the per-session score-bridge worker was broken for this
    // room. Settlement proceeds normally via patch txs.
    scoreBridgeGapDetected: { type: Boolean, default: false },
    scoreBridgeGapAt: { type: Date, default: null },
    scoreBridgeGapPushed: { type: Number, default: 0 },
  },
  { timestamps: true },
);
roomSchema.index({ phase: 1, closesAt: 1 });

// Per-cast reaction telemetry for offline cheat detection (impossible reflexes,
// repeated pre-nibble taps, inhuman sample jitter).
const reactionLogSchema = new Schema(
  {
    wallet: { type: String, required: true, index: true },
    clientCastId: { type: String, required: true },
    sessionPda: { type: String, default: null },
    nibbleDelayMs: { type: Number, required: true },
    // Null on "cancelled" or "escaped_no_tap".
    reactionTimeMs: { type: Number, default: null },
    preNibbleTapCount: { type: Number, required: true, default: 0 },
    sampleJitterMaxMs: { type: Number, default: null },
    outcome: {
      type: String,
      enum: ["hit", "escaped_no_tap", "escaped_miss", "cancelled"],
      required: true,
    },
    rarity: { type: Number, default: null },
    speciesId: { type: Number, default: null },
  },
  { timestamps: true },
);
reactionLogSchema.index({ wallet: 1, createdAt: -1 });

const adminAuditLogSchema = new Schema(
  {
    adminWallet: { type: String, required: true, index: true },
    procedure: { type: String, required: true },
    inputHash: { type: String, required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    outcome: { type: String, enum: ["ok", "error"], required: true },
    errorMessage: { type: String, default: null },
    ipAddress: { type: String, default: null },
  },
  { timestamps: false },
);
adminAuditLogSchema.index({ adminWallet: 1, timestamp: -1 });
adminAuditLogSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

const bountyRewardSchema = new Schema(
  {
    kind: { type: String, enum: ["shells", "sol"], required: true },
    amount: { type: Number, default: null },
    lamports: { type: Number, default: null },
  },
  { _id: false },
);

const bountySlotSchema = new Schema(
  {
    slot: { type: Number, required: true },
    templateId: { type: String, required: true },
    label: { type: String, required: true },
    goalType: {
      type: String,
      enum: [
        "catch_rarity_count",
        "catch_single_trigger",
        "catch_score_threshold",
        "leaderboard_rank",
      ],
      required: true,
    },
    goalParams: { type: Schema.Types.Mixed, required: true },
    target: { type: Number, required: true },
    reward: { type: bountyRewardSchema, required: true },
  },
  { _id: false },
);

const bountyPeriodSchema = new Schema(
  {
    cadence: { type: String, enum: ["weekly"], required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    slots: { type: [bountySlotSchema], default: [] },
  },
  { timestamps: true },
);
bountyPeriodSchema.index({ cadence: 1, startsAt: 1 }, { unique: true });
bountyPeriodSchema.index({ cadence: 1, endsAt: 1 });

const playerBountyProgressSchema = new Schema(
  {
    playerId: {
      type: Schema.Types.ObjectId,
      ref: "Player",
      required: true,
      index: true,
    },
    periodId: {
      type: Schema.Types.ObjectId,
      ref: "BountyPeriod",
      required: true,
      index: true,
    },
    slot: { type: Number, required: true },
    progress: { type: Number, required: true, default: 0 },
    target: { type: Number, required: true },
    completed: { type: Boolean, required: true, default: false },
    completedAt: { type: Date, default: null },
    rewardCredited: { type: Boolean, required: true, default: false },
    rewardShellsCredited: { type: Number, default: null },
    rewardSolPayoutStatus: {
      type: String,
      enum: ["pending", "sent", "failed", null],
      default: null,
    },
    rewardTxSignature: { type: String, default: null },
  },
  { timestamps: true },
);
playerBountyProgressSchema.index(
  { playerId: 1, periodId: 1, slot: 1 },
  { unique: true },
);

// Weights stored in kg (admin UX); converted to hectograms (×10) when
// snapshot onto a session for the cast roll's integer math.
const APEX_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

const apexFishSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 1,
      maxlength: 64,
    },
    weightMinKg: { type: Number, required: true, min: 0 },
    weightMaxKg: { type: Number, required: true, min: 0 },
    imageData: { type: Buffer, required: true },
    imageMimeType: {
      type: String,
      required: true,
      enum: APEX_IMAGE_MIME_TYPES,
    },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);
apexFishSchema.pre("validate", function (next) {
  if (this.weightMaxKg < this.weightMinKg) {
    return next(new Error("weightMaxKg must be ≥ weightMinKg"));
  }
  next();
});

const fishingEventFinalRankSchema = new Schema(
  {
    rank: { type: Number, required: true },
    walletAddress: { type: String, required: true },
    displayName: { type: String, required: true },
    score: { type: Number, required: true },
    prizeSol: { type: Number, required: true, min: 0 },
    paid: { type: Boolean, required: true, default: false },
    signature: { type: String, default: null },
    paidAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null },
  },
  { _id: false },
);

const fishingEventSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 64,
    },
    active: { type: Boolean, required: true, default: false },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    // Basis points redirected from Basic to Apex. Capped at 5000 to keep
    // the rarity distribution well-formed (see effectiveRarityWeights).
    apexBp: { type: Number, required: true, min: 0, max: 5000 },
    prizePoolSol: { type: Number, required: true, default: 0, min: 0 },
    apexFishIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "ApexFish" }],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length >= 1,
        message: "apexFishIds must contain at least one fish id",
      },
    },
    finalRanks: { type: [fishingEventFinalRankSchema], default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

// Partial unique index ensures concurrent activations resolve to one winner.
fishingEventSchema.index(
  { active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
fishingEventSchema.index({ startsAt: 1 });
fishingEventSchema.index({ endsAt: 1 });

// Daily HMAC key with public commit-reveal for post-hoc RNG fairness audits.
// Players recompute seedForCast(...) after revealAfter and match against the
// catch's seedHash to prove the fish wasn't rerolled.
const fishingDailySeedSchema = new Schema(
  {
    date: { type: String, required: true, unique: true, index: true },
    // 32-byte HMAC key. Never exposed before revealAfter.
    seed: { type: Buffer, required: true },
    seedHash: { type: Buffer, required: true },
    publishedAt: { type: Date, required: true, default: () => new Date() },
    // Default = start of next UTC day.
    revealAfter: { type: Date, required: true },
  },
  { timestamps: true },
);

const pendingCastSchema = new Schema(
  {
    castIndex: { type: Number, required: true },
    // Null when the cast rolled Apex (use apexFishId instead).
    speciesId: { type: Number, default: null },
    apexFishId: { type: Schema.Types.ObjectId, ref: "ApexFish", default: null },
    // Persisted at cast time so the catch row keeps a stable label even
    // if the apex fish is later renamed.
    speciesName: { type: String, default: null },
    rarity: { type: Number, required: true, min: 0, max: 4 },
    weightHg: { type: Number, required: true },
    greenZoneStart: { type: Number, required: true },
    greenZoneWidth: { type: Number, required: true },
    mechanic: { type: Number, required: true, min: 0, max: 1 },
    castAt: { type: Date, required: true },
    // Used by the audit endpoint without leaking the seed before reveal.
    seedHash: { type: Buffer, required: true },
  },
  { _id: false },
);

const fishingSessionSchema = new Schema(
  {
    playerId: {
      type: Schema.Types.ObjectId,
      ref: "Player",
      required: true,
      index: true,
    },
    // Denormalized for fast wallet → session lookups and HMAC seed input.
    walletAddress: { type: String, required: true, index: true },

    // A new room deposit within the same (dateKey, window) abandons any
    // prior active session — see roomRouter.markPriorSessionAbandoned.
    roomId: { type: String, default: null, index: true },

    // UTC days since epoch and window (0 day, 1 night).
    dateKey: { type: Number, required: true },
    window: { type: Number, required: true, enum: [0, 1] },

    baitInitial: { type: Number, required: true, min: 0 },
    baitRemaining: { type: Number, required: true, min: 0 },
    tier: { type: Number, required: true, default: 0 },

    sessionScore: { type: Number, required: true, default: 0, min: 0 },
    castCount: { type: Number, required: true, default: 0, min: 0 },
    catchCount: { type: Number, required: true, default: 0, min: 0 },
    pityCounter: { type: Number, required: true, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["active", "committed", "abandoned"],
      required: true,
      default: "active",
      index: true,
    },
    startedAt: { type: Date, required: true, default: () => new Date() },
    committedAt: { type: Date, default: null },

    pendingCast: { type: pendingCastSchema, default: null },

    dailySeedDate: { type: String, required: true },
    merkleRoot: { type: Buffer, default: null },

    chainScoreTxSignature: { type: String, default: null },
    chainScoreBridgedAt: { type: Date, default: null },
    eventActiveAtStart: { type: Boolean, required: true, default: false },
    eventNameAtStart: { type: String, default: null },
    eventApexBpAtStart: { type: Number, required: true, default: 0 },
    eventApexFishesAtStart: {
      type: [
        new Schema(
          {
            apexFishId: { type: Schema.Types.ObjectId, required: true },
            name: { type: String, required: true },
            weightMinHg: { type: Number, required: true },
            weightMaxHg: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      required: true,
      default: [],
    },
  },
  { timestamps: true },
);

fishingSessionSchema.index(
  { playerId: 1, dateKey: 1, window: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
fishingSessionSchema.index({ status: 1, dateKey: 1 });
fishingSessionSchema.index({ walletAddress: 1, dateKey: -1 });
const keeperHeartbeatSchema = new Schema(
  {
    keeperName: { type: String, required: true, unique: true, index: true },
    lastTickAt: { type: Date, required: true, index: true },
    lastTickStatus: {
      type: String,
      enum: ["ok", "error"],
      required: true,
    },
    lastError: { type: String, default: null },
    consecutiveErrors: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export type PlayerDocument = InferSchemaType<typeof playerSchema>;
export type CatchDocument = InferSchemaType<typeof catchSchema>;
export type FishingSessionDocument = InferSchemaType<
  typeof fishingSessionSchema
>;
export type FishingDailySeedDocument = InferSchemaType<
  typeof fishingDailySeedSchema
>;
export type FishingEventDocument = InferSchemaType<typeof fishingEventSchema>;
export type FishingEventFinalRank = InferSchemaType<
  typeof fishingEventFinalRankSchema
>;
export type ApexFishDocument = InferSchemaType<typeof apexFishSchema>;
export type ReactionLogDocument = InferSchemaType<typeof reactionLogSchema>;
export type PoolTierDocument = InferSchemaType<typeof poolTierSchema>;
export type DailyLeaderboardDocument = InferSchemaType<
  typeof dailyLeaderboardSchema
>;
export type RoomDocument = InferSchemaType<typeof roomSchema>;
export type AdminAuditLogDocument = InferSchemaType<typeof adminAuditLogSchema>;
export type BountyPeriodDocument = InferSchemaType<typeof bountyPeriodSchema>;
export type PlayerBountyProgressDocument = InferSchemaType<
  typeof playerBountyProgressSchema
>;

export const APEX_IMAGE_MIME_TYPES_LIST = APEX_IMAGE_MIME_TYPES;
export type ApexImageMimeType = (typeof APEX_IMAGE_MIME_TYPES)[number];

// Reuse an already-registered model — Vitest may load schema.ts twice.
function model<S extends mongoose.Schema>(
  name: string,
  schema: S,
): mongoose.Model<mongoose.InferSchemaType<S>> {
  return (
    (mongoose.models[name] as mongoose.Model<mongoose.InferSchemaType<S>>) ??
    mongoose.model(name, schema)
  );
}

export const Player = model("Player", playerSchema);
export const Catch = model("Catch", catchSchema);
export const FishingSession = model("FishingSession", fishingSessionSchema);
export const FishingDailySeed = model(
  "FishingDailySeed",
  fishingDailySeedSchema,
);
export const FishingEvent = model("FishingEvent", fishingEventSchema);
export const ApexFish = model("ApexFish", apexFishSchema);
export const ReactionLog = model("ReactionLog", reactionLogSchema);
export const PoolTier = model("PoolTier", poolTierSchema);
export const DailyLeaderboard = model(
  "DailyLeaderboard",
  dailyLeaderboardSchema,
);
export const Room = model("Room", roomSchema);
export const AdminAuditLog = model("AdminAuditLog", adminAuditLogSchema);
export const BountyPeriod = model("BountyPeriod", bountyPeriodSchema);
export const PlayerBountyProgress = model(
  "PlayerBountyProgress",
  playerBountyProgressSchema,
);
export const KeeperHeartbeat = model("KeeperHeartbeat", keeperHeartbeatSchema);
export type KeeperHeartbeatDocument = InferSchemaType<
  typeof keeperHeartbeatSchema
>;
