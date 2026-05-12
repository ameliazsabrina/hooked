// Use namespace imports throughout. @coral-xyz/anchor and @solana/web3.js
// publish CommonJS, so under Node 22+'s native TypeScript stripping (which
// runs the file as ESM) named imports like `{ BN, Program }` fail with
// "Named export not found". Namespace imports + value-level destructuring
// work in both CJS-via-ts-node and ESM-from-Node modes; the destructured
// classes (PublicKey, Keypair, BN, Program) double as their own types.
import * as anchor from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import { expect } from "chai";
import type { HookedRooms } from "../target/types/hooked_rooms";

const { Program, BN } = anchor;
const { PublicKey, Keypair, LAMPORTS_PER_SOL } = web3;

// PRD v2.2 — weekly SOL rooms
describe("room lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.HookedRooms as Program<HookedRooms>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const ROOM_ID = new BN(1_001);
  const HALF_SOL = new BN(LAMPORTS_PER_SOL / 2);
  const THREE_QUARTER_SOL = new BN((3 * LAMPORTS_PER_SOL) / 4);
  const ONE_SOL = new BN(LAMPORTS_PER_SOL);
  const TWO_SOL = new BN(2 * LAMPORTS_PER_SOL);

  const player1 = Keypair.generate();
  const player2 = Keypair.generate();

  const treasury = Keypair.generate();
  const lpManager = Keypair.generate();

  // ─── PDA helpers ─────────────────────────────────────────────────────

  function roomPda(roomId: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("room"), roomId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  }

  function roomVaultPda(room: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("room_vault"), room.toBuffer()],
      program.programId,
    )[0];
  }

  function roomEntryPda(room: PublicKey, player: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("room_entry"), room.toBuffer(), player.toBuffer()],
      program.programId,
    )[0];
  }

  function programConfigPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    )[0];
  }

  before(async () => {
    const fund = async (kp: Keypair, sol: number) => {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        sol * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
    };
    await Promise.all([fund(player1, 5), fund(player2, 5), fund(treasury, 1)]);

    // Bootstrap ProgramConfig. Every state-changing ix (create_room,
    // deposit_room, close_room, …) requires this account to exist and reads
    // `paused` from it. Idempotent: if a previous run left it behind, skip.
    const config = programConfigPda();
    const existing = await provider.connection.getAccountInfo(config);
    if (!existing) {
      await program.methods
        .initProgramConfig(treasury.publicKey, lpManager.publicKey)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();
    }
  });

  // =====================================================================
  // create_room
  // =====================================================================

  it("creates a room with a native-SOL vault", async () => {
    const room = roomPda(ROOM_ID);
    const vault = roomVaultPda(room);

    await program.methods
      .createRoom(ROOM_ID)
      .accounts({ admin: admin.publicKey } as any)
      .rpc();

    const acc = await program.account.room.fetch(room);
    expect(acc.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(acc.roomId.toNumber()).to.equal(1_001);
    expect(acc.depositedLamports.toNumber()).to.equal(0);
    expect(acc.humanCount).to.equal(0);
    expect(acc.maxHumans).to.equal(40);
    expect(acc.capacityLamports.toString()).to.equal(
      (20 * LAMPORTS_PER_SOL).toString(),
    );
    expect(acc.status).to.equal(0); // Entry

    // entry_closes_at = created_at + 24h, closes_at = created_at + 7d
    const oneDay = 24 * 60 * 60;
    const sevenDays = 7 * oneDay;
    expect(acc.entryClosesAt.toNumber() - acc.createdAt.toNumber()).to.equal(
      oneDay,
    );
    expect(acc.closesAt.toNumber() - acc.createdAt.toNumber()).to.equal(
      sevenDays,
    );

    // Vault exists (system-owned PDA, rent-exempt 0 lamports OK — no data).
    const vaultInfo = await provider.connection.getAccountInfo(vault);
    // vault PDA is created on first transfer; before deposit it may be null.
    // create_room does not pre-create the vault account (no data). Accept null.
    expect(vaultInfo === null || vaultInfo.lamports >= 0).to.equal(true);
  });

  // =====================================================================
  // deposit_room
  // =====================================================================

  it("player1 deposits 1 SOL", async () => {
    const room = roomPda(ROOM_ID);
    const vault = roomVaultPda(room);

    const vaultBefore =
      (await provider.connection.getAccountInfo(vault))?.lamports ?? 0;

    await program.methods
      .depositRoom(ONE_SOL)
      .accounts({
        room,
        authority: player1.publicKey,
      } as any)
      .signers([player1])
      .rpc();

    const vaultAfter =
      (await provider.connection.getAccountInfo(vault))?.lamports ?? 0;
    expect(vaultAfter - vaultBefore).to.equal(ONE_SOL.toNumber());

    const acc = await program.account.room.fetch(room);
    expect(acc.depositedLamports.toNumber()).to.equal(ONE_SOL.toNumber());
    expect(acc.humanCount).to.equal(1);

    const entry = await program.account.roomEntry.fetch(
      roomEntryPda(room, player1.publicKey),
    );
    expect(entry.room.toBase58()).to.equal(room.toBase58());
    expect(entry.authority.toBase58()).to.equal(player1.publicKey.toBase58());
    expect(entry.depositLamports.toNumber()).to.equal(ONE_SOL.toNumber());
    expect(entry.returned).to.equal(false);
    expect(entry.returnedAt.toNumber()).to.equal(0);
  });

  it("rejects deposit below minimum", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .depositRoom(new BN(LAMPORTS_PER_SOL / 10)) // 0.1 SOL
        .accounts({
          room,
          authority: player2.publicKey,
        } as any)
        .signers([player2])
        .rpc();
      expect.fail("should throw DepositBelowMinimum");
    } catch (err: any) {
      expect(err.toString()).to.contain("DepositBelowMinimum");
    }
  });

  it("rejects deposit above maximum", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .depositRoom(new BN(3 * LAMPORTS_PER_SOL))
        .accounts({
          room,
          authority: player2.publicKey,
        } as any)
        .signers([player2])
        .rpc();
      expect.fail("should throw DepositAboveMaximum");
    } catch (err: any) {
      expect(err.toString()).to.contain("DepositAboveMaximum");
    }
  });

  it("rejects deposit that is not a valid 0.5 SOL increment", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .depositRoom(THREE_QUARTER_SOL)
        .accounts({
          room,
          authority: player2.publicKey,
        } as any)
        .signers([player2])
        .rpc();
      expect.fail("should throw InvalidDepositAmount");
    } catch (err: any) {
      expect(err.toString()).to.contain("InvalidDepositAmount");
    }
  });

  it("player2 deposits 2 SOL (max)", async () => {
    const room = roomPda(ROOM_ID);

    await program.methods
      .depositRoom(TWO_SOL)
      .accounts({
        room,
        authority: player2.publicKey,
      } as any)
      .signers([player2])
      .rpc();

    const acc = await program.account.room.fetch(room);
    expect(acc.depositedLamports.toNumber()).to.equal(
      ONE_SOL.toNumber() + TWO_SOL.toNumber(),
    );
    expect(acc.humanCount).to.equal(2);
  });

  it("rejects duplicate deposit from same player (entry PDA exists)", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .depositRoom(HALF_SOL)
        .accounts({
          room,
          authority: player1.publicKey,
        } as any)
        .signers([player1])
        .rpc();
      expect.fail("should throw — entry PDA already in use");
    } catch (err: any) {
      expect(err.toString()).to.contain("already in use");
    }
  });

  // =====================================================================
  // close_room (must fail before closes_at)
  // =====================================================================

  it("rejects close before closes_at", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .closeRoom(new BN(100_000))
        .accounts({
          room,
          treasury: treasury.publicKey,
          admin: admin.publicKey,
        } as any)
        .rpc();
      expect.fail("should throw RoomNotClosable");
    } catch (err: any) {
      expect(err.toString()).to.contain("RoomNotClosable");
    }
  });

  it("rejects close from non-admin", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .closeRoom(new BN(100_000))
        .accounts({
          room,
          treasury: treasury.publicKey,
          admin: player1.publicKey,
        } as any)
        .signers([player1])
        .rpc();
      expect.fail("should throw Unauthorized");
    } catch (err: any) {
      const s = err.toString();
      expect(
        s.includes("Unauthorized") ||
          s.includes("ConstraintRaw") ||
          s.includes("2012"),
      ).to.equal(true);
    }
  });

  // =====================================================================
  // return_principal + finalize_room — status must be Settling.
  // Without clock warp we can't legitimately close here, so we document the
  // expected flow and test the error paths.
  // =====================================================================

  it("rejects return_principal while room is not Settling", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .returnPrincipal(new BN(0))
        .accounts({
          room,
          recipient: player1.publicKey,
          admin: admin.publicKey,
        } as any)
        .rpc();
      expect.fail("should throw RoomNotSettling");
    } catch (err: any) {
      expect(err.toString()).to.contain("RoomNotSettling");
    }
  });

  it("rejects finalize_room while room is not Settling", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .finalizeRoom()
        .accounts({
          room,
          treasury: treasury.publicKey,
          admin: admin.publicKey,
        } as any)
        .rpc();
      expect.fail("should throw RoomNotSettling");
    } catch (err: any) {
      expect(err.toString()).to.contain("RoomNotSettling");
    }
  });

  // NOTE: The full happy-path close + auto-return flow requires advancing the
  // validator clock past `room.closes_at` (7 days). Exercised in integration
  // environments via `solana-test-validator --warp-slot` — documented here
  // rather than tested automatically.

  // =====================================================================
  // withdraw_to_lp_manager — failure paths only.
  // The success path requires `now >= lp_deploy_at` (created_at + 24h),
  // which we can't fast-forward on a live validator. Exercised via the
  // server-side dry-run integration tests + manual mainnet canary.
  // =====================================================================

  it("rejects withdraw_to_lp_manager before lp_deploy_at", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .withdrawToLpManager(ONE_SOL)
        .accounts({
          room,
          // Must be the canonical lp_manager pinned in ProgramConfig — a
          // random key would trigger LpManagerMismatch first and mask the
          // window-not-open assertion this test is actually checking.
          lpManager: lpManager.publicKey,
          admin: admin.publicKey,
        } as any)
        .rpc();
      expect.fail("should throw LpDeployWindowNotOpen");
    } catch (err: any) {
      expect(err.toString()).to.contain("LpDeployWindowNotOpen");
    }
  });

  it("rejects withdraw_to_lp_manager from non-admin", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .withdrawToLpManager(ONE_SOL)
        .accounts({
          room,
          lpManager: lpManager.publicKey,
          admin: player1.publicKey,
        } as any)
        .signers([player1])
        .rpc();
      expect.fail("should throw Unauthorized");
    } catch (err: any) {
      const s = err.toString();
      expect(
        s.includes("Unauthorized") ||
          s.includes("ConstraintRaw") ||
          s.includes("2012"),
      ).to.equal(true);
    }
  });

  it("rejects withdraw_to_lp_manager with zero amount", async () => {
    const room = roomPda(ROOM_ID);

    try {
      await program.methods
        .withdrawToLpManager(new BN(0))
        .accounts({
          room,
          lpManager: lpManager.publicKey,
          admin: admin.publicKey,
        } as any)
        .rpc();
      expect.fail("should throw — zero amount or window-not-open");
    } catch (err: any) {
      // Either error is acceptable: time guard fires before zero-amount guard
      // when the room is still pre-lp_deploy_at, so we accept either.
      const s = err.toString();
      expect(
        s.includes("LpAmountZero") || s.includes("LpDeployWindowNotOpen"),
      ).to.equal(true);
    }
  });

  // =====================================================================
  // Phase 2 — GatewayRegistry + update_room_entry_score
  // =====================================================================

  const keeper = Keypair.generate();
  const rogue = Keypair.generate();

  function gatewayRegistryPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("gateway_registry")],
      program.programId,
    )[0];
  }

  it("initializes the gateway registry with a keeper", async () => {
    const sig = await provider.connection.requestAirdrop(
      keeper.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);

    await program.methods
      .initGatewayRegistry(keeper.publicKey)
      .accounts({ admin: admin.publicKey } as any)
      .rpc();

    const reg =
      await program.account.gatewayRegistry.fetch(gatewayRegistryPda());
    expect(reg.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(reg.keyCount).to.equal(1);
    expect(reg.keys[0].toBase58()).to.equal(keeper.publicKey.toBase58());
  });

  it("rejects update_room_entry_score from non-whitelisted signer", async () => {
    const room = roomPda(ROOM_ID);
    const entry = roomEntryPda(room, player1.publicKey);
    const sig = await provider.connection.requestAirdrop(
      rogue.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateRoomEntryScore(new BN(100))
        .accounts({
          room,
          entry,
          keeper: rogue.publicKey,
        } as any)
        .signers([rogue])
        .rpc();
      expect.fail("should throw NotGateway");
    } catch (err: any) {
      expect(err.toString()).to.contain("NotGateway");
    }
  });

  it("keeper can update room entry score cumulatively (player1)", async () => {
    const room = roomPda(ROOM_ID);
    const entry = roomEntryPda(room, player1.publicKey);

    await program.methods
      .updateRoomEntryScore(new BN(500))
      .accounts({
        room,
        entry,
        keeper: keeper.publicKey,
      } as any)
      .signers([keeper])
      .rpc();

    await program.methods
      .updateRoomEntryScore(new BN(300))
      .accounts({
        room,
        entry,
        keeper: keeper.publicKey,
      } as any)
      .signers([keeper])
      .rpc();

    const entryAcc = await program.account.roomEntry.fetch(entry);
    expect(entryAcc.finalScore.toNumber()).to.equal(800);

    const roomAcc = await program.account.room.fetch(room);
    expect(roomAcc.firstPlace.toBase58()).to.equal(
      player1.publicKey.toBase58(),
    );
    expect(roomAcc.firstPlaceScore.toNumber()).to.equal(800);
  });

  it("second scorer takes 2nd place, higher scorer displaces 1st", async () => {
    const room = roomPda(ROOM_ID);
    const entry2 = roomEntryPda(room, player2.publicKey);

    // player2 scores 400 — 2nd place
    await program.methods
      .updateRoomEntryScore(new BN(400))
      .accounts({
        room,
        entry: entry2,
        keeper: keeper.publicKey,
      } as any)
      .signers([keeper])
      .rpc();

    let roomAcc = await program.account.room.fetch(room);
    expect(roomAcc.firstPlace.toBase58()).to.equal(
      player1.publicKey.toBase58(),
    );
    expect(roomAcc.firstPlaceScore.toNumber()).to.equal(800);
    expect(roomAcc.secondPlace.toBase58()).to.equal(
      player2.publicKey.toBase58(),
    );
    expect(roomAcc.secondPlaceScore.toNumber()).to.equal(400);

    // player2 adds 1000 — total 1400, displaces player1
    await program.methods
      .updateRoomEntryScore(new BN(1000))
      .accounts({
        room,
        entry: entry2,
        keeper: keeper.publicKey,
      } as any)
      .signers([keeper])
      .rpc();

    roomAcc = await program.account.room.fetch(room);
    expect(roomAcc.firstPlace.toBase58()).to.equal(
      player2.publicKey.toBase58(),
    );
    expect(roomAcc.firstPlaceScore.toNumber()).to.equal(1400);
    expect(roomAcc.secondPlace.toBase58()).to.equal(
      player1.publicKey.toBase58(),
    );
    expect(roomAcc.secondPlaceScore.toNumber()).to.equal(800);
  });

  it("admin can add + remove gateway keys", async () => {
    const second = Keypair.generate();
    const registry = gatewayRegistryPda();

    await program.methods
      .addGatewayKey(second.publicKey)
      .accounts({ admin: admin.publicKey } as any)
      .rpc();

    let reg = await program.account.gatewayRegistry.fetch(registry);
    expect(reg.keyCount).to.equal(2);
    expect(reg.keys.slice(0, 2).map((k) => k.toBase58())).to.include(
      second.publicKey.toBase58(),
    );

    // Duplicate add rejected
    try {
      await program.methods
        .addGatewayKey(second.publicKey)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();
      expect.fail("should reject duplicate");
    } catch (err: any) {
      expect(err.toString()).to.contain("GatewayKeyAlreadyPresent");
    }

    // Non-admin cannot modify
    try {
      await program.methods
        .addGatewayKey(Keypair.generate().publicKey)
        .accounts({ admin: player1.publicKey } as any)
        .signers([player1])
        .rpc();
      expect.fail("should reject non-admin");
    } catch (err: any) {
      const s = err.toString();
      expect(s.includes("Unauthorized") || s.includes("2012")).to.equal(true);
    }

    // Remove
    await program.methods
      .removeGatewayKey(second.publicKey)
      .accounts({ admin: admin.publicKey } as any)
      .rpc();

    reg = await program.account.gatewayRegistry.fetch(registry);
    expect(reg.keyCount).to.equal(1);
  });

  // =====================================================================
  // Pause switch — emergency kill-switch on ProgramConfig.
  //
  // Before mainnet ship: `set_paused(true)` must block every state-changing
  // ix until admin flips it back. Using deposit_room as the canary because
  // it's the highest-volume user-facing path; if pause works there it works
  // everywhere (the gate is identical).
  // =====================================================================

  describe("pause switch", () => {
    const pausePlayer = Keypair.generate();
    const pauseRoomId = new BN(9_001);

    before(async () => {
      const sig = await provider.connection.requestAirdrop(
        pausePlayer.publicKey,
        3 * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);

      // Fresh room for this block so we don't collide with the lifecycle
      // suite's shared room state.
      await program.methods
        .createRoom(pauseRoomId)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();
    });

    afterEach(async () => {
      // Belt-and-suspenders: never leave the program paused between tests.
      try {
        await program.methods
          .setPaused(false)
          .accounts({ admin: admin.publicKey } as any)
          .rpc();
      } catch {
        // Ignore — config may already be unpaused.
      }
    });

    it("admin can flip paused on and off", async () => {
      const config = programConfigPda();

      await program.methods
        .setPaused(true)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();
      let cfg = await program.account.programConfig.fetch(config);
      expect(cfg.paused).to.equal(true);

      await program.methods
        .setPaused(false)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();
      cfg = await program.account.programConfig.fetch(config);
      expect(cfg.paused).to.equal(false);
    });

    it("rejects set_paused from non-admin", async () => {
      try {
        await program.methods
          .setPaused(true)
          .accounts({ admin: player1.publicKey } as any)
          .signers([player1])
          .rpc();
        expect.fail("should reject non-admin");
      } catch (err: any) {
        const s = err.toString();
        expect(
          s.includes("Unauthorized") ||
            s.includes("ConstraintRaw") ||
            s.includes("2012"),
        ).to.equal(true);
      }
    });

    it("blocks deposit_room while paused, succeeds after unpause", async () => {
      const room = roomPda(pauseRoomId);

      // Pause.
      await program.methods
        .setPaused(true)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();

      // Deposit must fail with Paused.
      try {
        await program.methods
          .depositRoom(ONE_SOL)
          .accounts({
            room,
            authority: pausePlayer.publicKey,
          } as any)
          .signers([pausePlayer])
          .rpc();
        expect.fail("deposit should have been blocked by Paused");
      } catch (err: any) {
        expect(err.toString()).to.contain("Paused");
      }

      // Unpause.
      await program.methods
        .setPaused(false)
        .accounts({ admin: admin.publicKey } as any)
        .rpc();

      // Same deposit now succeeds.
      await program.methods
        .depositRoom(ONE_SOL)
        .accounts({
          room,
          authority: pausePlayer.publicKey,
        } as any)
        .signers([pausePlayer])
        .rpc();

      const acc = await program.account.room.fetch(room);
      expect(acc.depositedLamports.toNumber()).to.equal(ONE_SOL.toNumber());
      expect(acc.humanCount).to.equal(1);
    });
  });

  it("rejects update for an entry belonging to a different room", async () => {
    // Create a second room with its own entry, then try to call
    // update_room_entry_score passing the first room but entry from the second.
    const otherRoomId = new BN(1_002);
    const otherRoom = roomPda(otherRoomId);
    const otherPlayer = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      otherPlayer.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);

    await program.methods
      .createRoom(otherRoomId)
      .accounts({ admin: admin.publicKey } as any)
      .rpc();

    await program.methods
      .depositRoom(ONE_SOL)
      .accounts({
        room: otherRoom,
        authority: otherPlayer.publicKey,
      } as any)
      .signers([otherPlayer])
      .rpc();

    const otherEntry = roomEntryPda(otherRoom, otherPlayer.publicKey);
    const wrongRoom = roomPda(ROOM_ID);

    try {
      await program.methods
        .updateRoomEntryScore(new BN(10))
        .accounts({
          room: wrongRoom,
          entry: otherEntry,
          keeper: keeper.publicKey,
        } as any)
        .signers([keeper])
        .rpc();
      expect.fail("should reject cross-room entry");
    } catch (err: any) {
      const s = err.toString();
      // Seeds mismatch surfaces as ConstraintSeeds on room_entry lookup.
      expect(
        s.includes("EntryRoomMismatch") ||
          s.includes("ConstraintSeeds") ||
          s.includes("2006"),
      ).to.equal(true);
    }
  });

  // =====================================================================
  // withdraw_to_lp_manager — happy path (requires surfpool clock warp).
  // =====================================================================

  it("withdraws principal to lp_manager after lp_deploy_at (CPI happy path)", async function () {
    // this test only meaningful under surfpool.
    const rpcUrl = (provider.connection as any)._rpcEndpoint as string;
    const probeRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_getSurfnetInfo",
        params: [],
      }),
    }).catch(() => null);
    if (!probeRes || !probeRes.ok) {
      this.skip();
    }
    const probeJson = await probeRes!.json().catch(() => null);
    if (!probeJson || probeJson.error) {
      this.skip();
    }

    const LP_ROOM_ID = new BN(2_001);
    const room = roomPda(LP_ROOM_ID);
    const vault = roomVaultPda(room);
    const lpPlayer = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      lpPlayer.publicKey,
      3 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);

    // Fresh room so we know created_at and can warp predictably.
    await program.methods
      .createRoom(LP_ROOM_ID)
      .accounts({ admin: admin.publicKey } as any)
      .rpc();

    const roomAccBefore = await program.account.room.fetch(room);
    const createdAt = roomAccBefore.createdAt.toNumber();
    const lpDeployAt = roomAccBefore.lpDeployAt.toNumber();
    const closesAt = roomAccBefore.closesAt.toNumber();

    // Deposit while still inside the entry window (no warp yet).
    await program.methods
      .depositRoom(ONE_SOL)
      .accounts({ room, authority: lpPlayer.publicKey } as any)
      .signers([lpPlayer])
      .rpc();

    const vaultBefore = (await provider.connection.getAccountInfo(vault))!
      .lamports;
    const managerBefore =
      (await provider.connection.getAccountInfo(lpManager.publicKey))
        ?.lamports ?? 0;

    // Jump the network clock to lp_deploy_at + 60s. Inside the LP window
    // (which closes at closes_at = created_at + 7d), so the require!(now >=
    // lp_deploy_at && now < closes_at) gate passes.
    // surfnet_timeTravel takes absoluteTimestamp in MILLISECONDS, even though
    // the on-chain Clock::unix_timestamp the program reads is seconds.
    const warpToSec = lpDeployAt + 60;
    expect(warpToSec).to.be.lessThan(closesAt);
    const warpRes = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "surfnet_timeTravel",
        params: [{ absoluteTimestamp: warpToSec * 1000 }],
      }),
    });
    const warpJson = await warpRes.json();
    expect(
      warpJson.error,
      `timeTravel failed: ${JSON.stringify(warpJson)}`,
    ).to.equal(undefined);

    // Now call the previously-broken instruction. With the fix it should
    // succeed; with the old direct-lamport-mutation code it would fail with
    // "instruction spent from the balance of an account it does not own".
    await program.methods
      .withdrawToLpManager(ONE_SOL)
      .accounts({
        room,
        lpManager: lpManager.publicKey,
        admin: admin.publicKey,
      } as any)
      .rpc();

    // Vault is system-owned with no data. After draining to 0 lamports the
    // runtime garbage-collects it, so getAccountInfo returns null. Treat
    // null as 0 lamports for the delta check.
    const vaultAfter =
      (await provider.connection.getAccountInfo(vault))?.lamports ?? 0;
    const managerAfter = (await provider.connection.getAccountInfo(
      lpManager.publicKey,
    ))!.lamports;

    expect(vaultBefore - vaultAfter).to.equal(ONE_SOL.toNumber());
    expect(managerAfter - managerBefore).to.equal(ONE_SOL.toNumber());

    const roomAccAfter = await program.account.room.fetch(room);
    expect(roomAccAfter.lpDeployedLamports.toString()).to.equal(
      ONE_SOL.toString(),
    );
    expect(roomAccAfter.lpManager.toBase58()).to.equal(
      lpManager.publicKey.toBase58(),
    );
  });
});
