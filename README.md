# 🎣 Hooked

> A real-time on-chain fishing game on Solana — cast, hook, climb the leaderboard.

<!-- Drop your gameplay GIF here. Save it to ./design/gameplay.gif and it will render below. -->
<p align="center">
  <img src="/packages/client/public/assets/hooked-gif.gif" alt="Hooked gameplay" width="720" />
</p>

---

## 🌊 What is Hooked?

Hooked is a skill-based competitive fishing game that lives on Solana. Players join time-bound **fishing rooms**, tap to hook fish under timing pressure, and race up a live leaderboard. When the room closes, top finishers split a real on-chain reward pool — seeded by yield from a Meteora DLMM position.

Under the hood, fishing is deterministic. A **daily HMAC seed** rotates server-side so every catch is reproducible and tamper-resistant, but still surprising in the moment. The game itself runs on **Phaser 3** with a retro pixel-art aesthetic — think Game Boy meets DeFi.

Bring a wallet. Bring patience. The big fish bite when you least expect it.

## 🐟 Features

- 🪝 **Wallet-native auth** — connect with Phantom or Solflare, no email required
- 🎣 **Skill-based tap-to-hook** mechanics with timing windows and difficulty curves
- 🏟️ **Multiplayer rooms** with three phases: `entry → active → closed`
- 🏆 **Per-room leaderboards** updated in real time over WebSocket
- 📖 **Fish collections** — discover and catalog every species you reel in
- 🛒 **In-game item shop** for rods and cosmetic upgrades
- 🦈 **Apex-fish events** — rare, high-value spawns surfaced by the admin dashboard
- 🧭 **Onboarding flow** that walks new anglers through their first cast
- 🛠️ **Admin dashboard** for managing rooms, events, and players

## 🪝 Tech Stack

**Frontend**

- React 18, TypeScript, Vite
- Phaser 3 (game engine)
- tRPC client + React Query
- Solana wallet adapters (Phantom, Solflare)
- Jersey-10 / VT323 retro pixel fonts

**Backend**

- Fastify 5 (HTTP + WebSocket gateway)
- tRPC 11 (typed RPC layer)
- MongoDB (players, rooms, sessions)
- Redis + BullMQ (queues, rate limiting)
- Anchor 0.32 + `@solana/web3.js`

**On-chain**

- Anchor program for Hooked Rooms (`packages/programs`)
- SPL Token for in-game economy
- Meteora DLMM integration for reward-pool yield

## 🐙 Monorepo Layout

```
packages/
  client/    # React + Vite + Phaser game
  server/    # Fastify + tRPC + WebSocket gateway
  shared/    # Shared TS types and helpers
  programs/  # Anchor Solana programs
```

## ⚓ How It Flows

```
   ┌──────────┐    tRPC (HTTP)    ┌──────────┐    Anchor    ┌──────────────┐
   │  Client  │ ────────────────▶ │  Server  │ ───────────▶ │ Solana / DLMM │
   │ (Phaser) │ ◀──── WS ────────▶│ (Fastify)│ ◀────────── │  + Treasury   │
   └────┬─────┘                   └────┬─────┘             └──────────────┘
        │ wallet sign                  │
        ▼                              ▼
    Phantom / Solflare           Mongo · Redis · BullMQ
```

- 🧑‍🎣 Player connects a wallet and signs in.
- 🔁 Client ↔ Server talk over **tRPC** for commands and **WebSocket** for live fishing events.
- 🎲 Server resolves catches using a **daily HMAC seed**, so RNG is deterministic and auditable.
- 🔐 Players sign their own join / claim transactions; a **keeper keypair** handles server-side on-chain writes.
- 💧 A Meteora DLMM position generates yield that feeds the top-3 reward pool of each room.

## 🏝️ Getting Started

**Prerequisites**

- Node.js 20+
- pnpm
- MongoDB (local or hosted)
- Redis
- A Solana RPC URL (devnet for local dev)

**Install**

```bash
pnpm install
```

**Configure environment**

```bash
cp packages/client/.env.example packages/client/.env
cp packages/server/.env.example packages/server/.env
```

Key vars to fill in (see each `.env.example` for the full list):

| Package | Variable                                 | Purpose                    |
| ------- | ---------------------------------------- | -------------------------- |
| client  | `VITE_SOLANA_CLUSTER`                    | `devnet` or `mainnet-beta` |
| client  | `VITE_GATEWAY_HTTP`                      | Server HTTP base URL       |
| client  | `VITE_WS_URL`                            | Server WebSocket URL       |
| client  | `VITE_HOOKED_ROOMS_PROGRAM_ID`           | On-chain program ID        |
| server  | `MONGODB_URI`                            | Mongo connection string    |
| server  | `REDIS_URL`                              | Redis connection string    |
| server  | `SOLANA_RPC_URL`                         | RPC endpoint               |
| server  | `HOOKED_ROOMS_PROGRAM_ID`                | On-chain program ID        |
| server  | `FISHING_DAILY_SEED_HEX`                 | HMAC seed for daily RNG    |
| server  | `TREASURY_KP` / `ADMIN_KP` / `KEEPER_KP` | Server-side keypairs       |

**Run**

```bash
pnpm dev
```

Client boots on **http://localhost:5173**, server on **http://localhost:3001**.

## 🦀 Scripts

| Command           | What it does                               |
| ----------------- | ------------------------------------------ |
| `pnpm dev`        | Run client + server in parallel            |
| `pnpm dev:client` | Client only                                |
| `pnpm dev:server` | Server only                                |
| `pnpm build`      | Build `shared`, then `client` and `server` |
| `pnpm lint`       | Lint every package                         |

## 🫧 Deployment

Production runs as a container on Heroku via [Dockerfile](Dockerfile) and [heroku.yml](heroku.yml). The server entrypoint is `node dist/index.js`. Set the same env vars from the table above in your hosting provider.

## 🐠 Contributing

Branch off `main`, write conventional-commit messages, open a PR. Bug reports and feature ideas are welcome — file an issue with a clear repro and we'll take a look.

## 🌊 License

TBD.
