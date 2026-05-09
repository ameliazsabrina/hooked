use anchor_lang::prelude::*;

use hooked_common::{BPS_SCALE, CONFIG_SEED, ROOM_SEED, ROOM_VAULT_SEED, YIELD_SHARE_PROTOCOL_BPS};

use crate::errors::RoomError;
use crate::state::{ProgramConfig, Room, RoomStatus};

#[derive(Accounts)]
pub struct CloseRoom<'info> {
    #[account(
        mut,
        seeds = [ROOM_SEED, &room.room_id.to_le_bytes()],
        bump = room.bump,
        constraint = room.admin == admin.key() @ RoomError::Unauthorized,
        constraint = room.status != RoomStatus::Closed as u8 @ RoomError::RoomAlreadyClosed,
    )]
    pub room: Account<'info, Room>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// CHECK: Room-owned SOL vault PDA, validated by seeds + room.vault_bump.
    #[account(
        mut,
        seeds = [ROOM_VAULT_SEED, room.key().as_ref()],
        bump = room.vault_bump,
    )]
    pub room_vault: UncheckedAccount<'info>,

    /// CHECK: Protocol treasury destination account. Pinned to `config.treasury`.
    #[account(
        mut,
        constraint = treasury.key() == config.treasury @ RoomError::TreasuryMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<CloseRoom>, yield_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let room = &ctx.accounts.room;

    require!(now >= room.closes_at, RoomError::RoomNotClosable);

    let protocol_share = yield_lamports
        .checked_mul(YIELD_SHARE_PROTOCOL_BPS)
        .ok_or(RoomError::Overflow)?
        .checked_div(BPS_SCALE as u64)
        .ok_or(RoomError::Overflow)?;

    if protocol_share > 0 {
        let vault_info = ctx.accounts.room_vault.to_account_info();
        let treasury_info = ctx.accounts.treasury.to_account_info();
        require!(
            vault_info.lamports() >= protocol_share,
            RoomError::VaultInsufficientFunds
        );
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(protocol_share)
            .ok_or(RoomError::Overflow)?;
        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(protocol_share)
            .ok_or(RoomError::Overflow)?;
    }

    // first_place / second_place / third_place are not written here. They are
    // canonical from `update_room_entry_score`, which is the only writer of
    // the cached top-3 leaderboard. close_room used to accept them as args,
    // but admin had no on-chain proof the supplied keys matched real winners
    // (P0 finding 2026-05-08). Removing the args makes the leaderboard
    // structurally trustless — yield distribution flows from the cache.
    let room = &mut ctx.accounts.room;
    room.status = RoomStatus::Settling as u8;
    room.yield_lamports = yield_lamports;

    Ok(())
}
