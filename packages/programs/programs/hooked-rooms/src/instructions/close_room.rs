use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

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

    /// CHECK: Room SOL vault PDA. System-owned, so withdrawals must use system::transfer CPI with invoke_signed.
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

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseRoom>, yield_lamports: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let now = Clock::get()?.unix_timestamp;
    let room = &ctx.accounts.room;

    require!(now >= room.closes_at, RoomError::RoomNotClosable);

    let protocol_share = yield_lamports
        .checked_mul(YIELD_SHARE_PROTOCOL_BPS)
        .ok_or(RoomError::Overflow)?
        .checked_div(BPS_SCALE as u64)
        .ok_or(RoomError::Overflow)?;

    if protocol_share > 0 {
        require!(
            ctx.accounts.room_vault.lamports() >= protocol_share,
            RoomError::VaultInsufficientFunds
        );
        let room_key = ctx.accounts.room.key();
        let vault_bump = ctx.accounts.room.vault_bump;
        let vault_seeds: &[&[u8]] = &[ROOM_VAULT_SEED, room_key.as_ref(), &[vault_bump]];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.room_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                signer_seeds,
            ),
            protocol_share,
        )?;
    }

    // Top-3 winners are written only by `update_room_entry_score` — close_room
    // accepting them as args was unverifiable (P0 2026-05-08).
    let room = &mut ctx.accounts.room;
    room.status = RoomStatus::Settling as u8;
    room.yield_lamports = yield_lamports;

    Ok(())
}
