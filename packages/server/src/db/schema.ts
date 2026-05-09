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
    // Lifetime aggregate of session_score across all committed sessions.
    // Mirrors PlayerProfile.total_score from the deprecated on-chain program;
    // bumped by sessionEngine.commitSession.
    totalScore: { type: Number, required: true, default: 0 },
    lastSeenAt: { type: Date, default: null },
    ipCountry: { type: String, default: null },
  },
  { timestamps: true }
);

const catchSchema = new Schema(
  {
    playerId: {
      type: Schema.Types.ObjectId,
      ref: "Player",
      required: true,
      index: true,
    },
    // Linkage to the off-chain FishingSession that produced this catch.
    // Null on legacy rows written by the deprecated ER webhook before cutover.
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "FishingSession",
      default: null,
      index: true,
    },
    // Position of this catch within the session — used by the audit Merkle
    // tree and to detect dropped catches. Null on legacy rows.
    castIndex: { type: Number, default: null },
    // Numeric species id (matches SPECIES_TABLE in services/fishing/constants.ts).
    // The string `species` field is the human-facing label; speciesId is the
    // canonical identifier for audit and migrations. Null on apex catches —
    // those are identified by `apexFishId` instead.
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
    // Single zone post-migration. Enum kept as a one-element list so mongoose
    // enforces the value on writes; legacy rows with other zones still load
    // because mongoose enum validation runs on save, not load.
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
  { timestamps: true }
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
  { timestamps: true }
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
  { _id: false }
);

const finalRankSchema = new Schema(
  {
    rank: { type: Number, required: true },
    playerId: { type: Schema.Types.ObjectId, ref: "Player", default: null },
    displayName: { type: String, required: true },
    prizeSOL: { type: Number, required: true },
  },
  { _id: false }
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
  { timestamps: true }
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
  { _id: false }
);

const roomWinnerSchema = new Schema(
  {
    rank: { type: Number, required: true },
    walletAddress: { type: String, required: true },
    displayName: { type: String, required: true },
    prizeSol: { type: Number, required: true },
  },
  { _id: false }
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

    // LP cycle tracking (Meteora DLMM SOL/USDC). Populated by the
    // room-lifecycle tick: deployedAt when withdraw_to_lp_manager fires,
    // exitedAt when liquidity is removed and yield reconciled.
    // realizedYieldLamports is what gets passed to close_room; clamped to 0
    // on net loss (LP_MANAGER buffer covers the gap).
    // Per-leg signatures + amounts let the admin dashboard reconstruct the
    // full SOL→USDC→SOL cycle. Fields are optional; older rooms have null.
    lp: {
      type: {
        status: {
          type: String,
          enum: ["pending", "deployed", "exited", "failed", "skipped"],
          default: "pending",
        },
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
  },
  { timestamps: true }
);
roomSchema.index({ phase: 1, closesAt: 1 });

// Per-cast reaction telemetry. Written by the WS gateway when a cast resolves
// (whether hit, missed reaction, miss in mechanic, or pre-nibble cancel) so
// offline analysis can spot impossible reflexes (<100ms), repeated pre-nibble
// taps, or sample jitter outside human ranges.
const reactionLogSchema = new Schema(
  {
    wallet: { type: String, required: true, index: true },
    clientCastId: { type: String, required: true },
    sessionPda: { type: String, default: null },
    nibbleDelayMs: { type: Number, required: true },
    // Null when outcome is "cancelled" (disconnect before nibble) or
    // "escaped_no_tap" (player never tapped within window).
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
  { timestamps: false }
);
adminAuditLogSchema.index({ adminWallet: 1, timestamp: -1 });
adminAuditLogSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

const bountyRewardSchema = new Schema(
  {
    kind: { type: String, enum: ["shells", "sol"], required: true },
    amount: { type: Number, default: null },
    lamports: { type: Number, default: null },
  },
  { _id: false }
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
  { _id: false }
);

const bountyPeriodSchema = new Schema(
  {
    cadence: { type: String, enum: ["weekly"], required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    slots: { type: [bountySlotSchema], default: [] },
  },
  { timestamps: true }
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
  { timestamps: true }
);
playerBountyProgressSchema.index(
  { playerId: 1, periodId: 1, slot: 1 },
  { unique: true }
);

// ---------------------------------------------------------------------------
// ApexFish — admin-uploaded apex fish definition. Replaces the legacy
// filesystem catalog (PNGs in client/public/assets/fish/apex + entries in
// FISH_SPECIES). Image bytes are stored inline as a Buffer; the public
// `GET /admin/apex-fish/:id/image` route streams them. Weights are stored
// in kilograms (admin UX); converted to hectograms (×10) when snapshot onto
// a session for the cast roll's integer math.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// FishingEvent — admin-managed event window that gates Apex fish drops and
// holds an optional SOL prize pool. One document per event; `active: true`
// is enforced as unique by a partial index so only one event is live at a
// time. The lifecycle worker (`jobs/eventLifecycle.ts`) auto-promotes the
// next-scheduled event to active when its `startsAt` arrives and demotes
// it when `endsAt` passes.
//
// `apexFishIds` references the `ApexFish` collection. Cast rolls during this
// event only pick from this list when the rarity tier lands on Apex (see
// services/fishing/rng.ts:rollCast). The session-start snapshot
// (`eventApexFishesAtStart`) freezes the chosen pool + weight ranges so an
// admin can't retroactively change Apex availability mid-session.
//
// `finalRanks` is computed after `endsAt` by services/eventWinners.ts and
// mirrors `roomWinnerSchema` so the existing `bountySolPayout` keeper
// transfer pattern can drive payout without a new worker.
// ---------------------------------------------------------------------------
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
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 64 },
    active: { type: Boolean, required: true, default: false },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    // Basis points (out of BPS_SCALE = 10_000) redirected from Basic to Apex
    // during the event. Capped at 5000 (MAX_EVENT_APEX_BP) so the rarity
    // distribution stays well-formed; see effectiveRarityWeights in rng.ts.
    apexBp: { type: Number, required: true, min: 0, max: 5000 },
    prizePoolSol: { type: Number, required: true, default: 0, min: 0 },
    // ApexFish ObjectIds (admin-uploaded catalog). At least one required so a
    // cast that rolls Apex during this event always has a fish to land on.
    apexFishIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "ApexFish" }],
      required: true,
      validate: {
        validator: (v: unknown[]) => Array.isArray(v) && v.length >= 1,
        message: "apexFishIds must contain at least one fish id",
      },
    },
    // Populated by services/eventWinners.computeEventWinners after endsAt.
    // null until computed; payout flow flips `paid` true per row.
    finalRanks: { type: [fishingEventFinalRankSchema], default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

// Only one active event at a time. Mongo partial unique index on the active
// flag ensures concurrent activations resolve to a single winner.
fishingEventSchema.index(
  { active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
fishingEventSchema.index({ startsAt: 1 });
fishingEventSchema.index({ endsAt: 1 });

// ---------------------------------------------------------------------------
// FishingDailySeed — daily HMAC key with public commit-reveal so players can
// audit RNG fairness post-hoc. One document per UTC date.
//
//   publishedAt: row written (commitment, sha256(seed), is public immediately)
//   revealAfter: timestamp after which the raw `seed` is exposed via the
//                audit API. Set to start-of-next-UTC-day at write time.
//
// Phase 5 audit flow:
//   1. cast time     → row exists with seed + seedHash; seedHash exposed publicly
//   2. cast persists → pendingCast.seedHash = sha256(seedForCast(seed, ...))
//   3. day ends      → revealAfter < Date.now(); audit API returns the raw seed
//   4. player        → recomputes seedForCast(...), checks it matches their
//                      catch's seedHash, proving the fish wasn't rerolled
// ---------------------------------------------------------------------------
const fishingDailySeedSchema = new Schema(
  {
    // ISO date (YYYY-MM-DD) in UTC. Unique — one seed per day.
    date: { type: String, required: true, unique: true, index: true },
    // 32-byte raw seed used as HMAC key in seedForCast. Never exposed before
    // revealAfter; gated by the audit endpoint.
    seed: { type: Buffer, required: true },
    // sha256(seed). Public from the moment the row is written.
    seedHash: { type: Buffer, required: true },
    publishedAt: { type: Date, required: true, default: () => new Date() },
    // Public exposure of `seed` only after this timestamp. Default = start of
    // next UTC day (i.e. once today is over).
    revealAfter: { type: Date, required: true },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------------------
// FishingSession — server-authoritative replacement for the on-chain
// `FishingSession` PDA. One document per (player, dateKey, window). Tracks
// bait, score, in-flight cast state, and the audit hooks (daily seed, merkle
// root, keeper bridge tx) that let players verify their session was rolled
// fairly even though the RNG ran off-chain.
//
// Field map to the on-chain struct (programs/hooked-fishing/src/state.rs):
//   authority     → playerId + walletAddress
//   bait_remaining→ baitRemaining
//   session_score → sessionScore
//   cast_count    → castCount
//   pity_counter  → pityCounter
//   window        → window (0 day, 1 night)
//   date          → dateKey (full int, not u16-truncated)
//   tier          → tier (bait tier, derived from deposit)
//   is_active     → status = "active"
//   pending_cast + current_*  → pendingCast subdoc
//   delegation_state, bump    → DROPPED (no PDA / no ER)
// ---------------------------------------------------------------------------
const pendingCastSchema = new Schema(
  {
    castIndex: { type: Number, required: true },
    // Numeric SPECIES_TABLE index for non-apex casts. Null when the cast
    // rolled Apex — the rolled fish is identified by `apexFishId` (a doc
    // in the admin-managed `ApexFish` collection) instead, since the apex
    // catalog is dynamic and not represented in SPECIES_TABLE.
    speciesId: { type: Number, default: null },
    apexFishId: { type: Schema.Types.ObjectId, ref: "ApexFish", default: null },
    // Display name from FISH_SPECIES (non-apex) or ApexFish.name (apex).
    // Persisted at cast time so the catch row gets a stable label even if
    // the apex fish is later renamed.
    speciesName: { type: String, default: null },
    rarity: { type: Number, required: true, min: 0, max: 4 },
    weightHg: { type: Number, required: true },
    greenZoneStart: { type: Number, required: true },
    greenZoneWidth: { type: Number, required: true },
    mechanic: { type: Number, required: true, min: 0, max: 1 },
    castAt: { type: Date, required: true },
    // sha256 of the per-cast HMAC seed. Used by the audit endpoint to prove
    // the rolled fish is the one the seed produced — without leaking the
    // seed itself until the daily reveal.
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
    // Denormalized for fast wallet → session lookups during cast handling
    // and for inclusion in the per-cast HMAC seed input.
    walletAddress: { type: String, required: true, index: true },

    // Day-grouping (UTC days since epoch) and window (0 day, 1 night).
    dateKey: { type: Number, required: true },
    window: { type: Number, required: true, enum: [0, 1] },

    // Bait economy. baitInitial is captured at start so we can show "X/Y left"
    // without re-deriving from deposit tier.
    baitInitial: { type: Number, required: true, min: 0 },
    baitRemaining: { type: Number, required: true, min: 0 },
    tier: { type: Number, required: true, default: 0 },

    // Score + pity counters.
    sessionScore: { type: Number, required: true, default: 0, min: 0 },
    castCount: { type: Number, required: true, default: 0, min: 0 },
    catchCount: { type: Number, required: true, default: 0, min: 0 },
    pityCounter: { type: Number, required: true, default: 0, min: 0 },

    // Lifecycle. "active" → "committed" on commitSession. "abandoned" if
    // the player never commits before the next window opens (keeper sweep).
    status: {
      type: String,
      enum: ["active", "committed", "abandoned"],
      required: true,
      default: "active",
      index: true,
    },
    startedAt: { type: Date, required: true, default: () => new Date() },
    committedAt: { type: Date, default: null },

    // In-flight cast (replaces FishingSession.pending_cast + current_*).
    // Null when no cast is pending.
    pendingCast: { type: pendingCastSchema, default: null },

    // Audit context: which dailySeed key this session's casts were rolled
    // against, and the per-session merkle root submitted in the keeper
    // bridge tx memo.
    dailySeedDate: { type: String, required: true },
    merkleRoot: { type: Buffer, default: null },

    // Bridge to hooked_rooms.update_room_entry_score. Populated by the
    // keeper job in Phase 3.
    chainScoreTxSignature: { type: String, default: null },
    chainScoreBridgedAt: { type: Date, default: null },

    // Snapshot of the active FishingEvent at session start so an admin can't
    // retroactively change Apex availability or species choice for an already-
    // rolled session. `eventApexFishesAtStart` pins the apex fish pool +
    // weight ranges so cast rolls in this session always resolve against the
    // pool the admin selected at session-start time, even if the event (or
    // an individual ApexFish doc) is later edited.
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

// One session per (player, dateKey, window) — matches the on-chain PDA seeds
// `[SESSION_SEED, authority, date_le, window]` so legacy and new code agree
// on session identity during the cutover.
fishingSessionSchema.index(
  { playerId: 1, dateKey: 1, window: 1 },
  { unique: true },
);
fishingSessionSchema.index({ status: 1, dateKey: 1 });
fishingSessionSchema.index({ walletAddress: 1, dateKey: -1 });

export type PlayerDocument = InferSchemaType<typeof playerSchema>;
export type CatchDocument = InferSchemaType<typeof catchSchema>;
export type FishingSessionDocument = InferSchemaType<typeof fishingSessionSchema>;
export type FishingDailySeedDocument = InferSchemaType<typeof fishingDailySeedSchema>;
export type FishingEventDocument = InferSchemaType<typeof fishingEventSchema>;
export type FishingEventFinalRank = InferSchemaType<typeof fishingEventFinalRankSchema>;
export type ApexFishDocument = InferSchemaType<typeof apexFishSchema>;
export type ReactionLogDocument = InferSchemaType<typeof reactionLogSchema>;
export type PoolTierDocument = InferSchemaType<typeof poolTierSchema>;
export type DailyLeaderboardDocument = InferSchemaType<typeof dailyLeaderboardSchema>;
export type RoomDocument = InferSchemaType<typeof roomSchema>;
export type AdminAuditLogDocument = InferSchemaType<typeof adminAuditLogSchema>;
export type BountyPeriodDocument = InferSchemaType<typeof bountyPeriodSchema>;
export type PlayerBountyProgressDocument = InferSchemaType<typeof playerBountyProgressSchema>;

export const APEX_IMAGE_MIME_TYPES_LIST = APEX_IMAGE_MIME_TYPES;
export type ApexImageMimeType = (typeof APEX_IMAGE_MIME_TYPES)[number];

// Reuse an already-registered model if the module graph is loaded twice
// (happens under Vitest when multiple test files import schema.ts).
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
export const FishingDailySeed = model("FishingDailySeed", fishingDailySeedSchema);
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
