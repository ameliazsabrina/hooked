use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use hooked_common::{CONFIG_SEED, ROOM_ENTRY_SEED, ROOM_SEED, ROOM_VAULT_SEED};

use crate::errors::RoomError;
use crate::state::{ProgramConfig, Room, RoomEntry, RoomStatus};

#[derive(Accounts)]
pub struct ReturnPrincipal<'info> {
    #[account(
        mut,
        seeds = [ROOM_SEED, &room.room_id.to_le_bytes()],
        bump = room.bump,
        constraint = room.admin == admin.key() @ RoomError::Unauthorized,
        constraint = room.status == RoomStatus::Settling as u8 @ RoomError::RoomNotSettling,
    )]
    pub room: Account<'info, Room>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// CHECK: Room-owned SOL vault PDA, validated by seeds + room.vault_bump.
    /// Owned by System Program (created by depositors via system::transfer),
    /// so lamport withdrawals must go through a system_program::transfer
    /// CPI with the vault's PDA seeds for invoke_signed.
    #[account(
        mut,
        seeds = [ROOM_VAULT_SEED, room.key().as_ref()],
        bump = room.vault_bump,
    )]
    pub room_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ROOM_ENTRY_SEED, room.key().as_ref(), recipient.key().as_ref()],
        bump = entry.bump,
        constraint = entry.room == room.key() @ RoomError::EntryRoomMismatch,
        constraint = !entry.returned @ RoomError::PrincipalAlreadyReturned,
    )]
    pub entry: Account<'info, RoomEntry>,

    /// CHECK: Principal recipient wallet — must match RoomEntry authority (enforced by entry seeds above).
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ReturnPrincipal>, yield_share_lamports: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let entry = &ctx.accounts.entry;

    let total = entry
        .deposit_lamports
        .checked_add(yield_share_lamports)
        .ok_or(RoomError::Overflow)?;

    require!(
        ctx.accounts.room_vault.lamports() >= total,
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
                to: ctx.accounts.recipient.to_account_info(),
            },
            signer_seeds,
        ),
        total,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let entry = &mut ctx.accounts.entry;
    entry.returned = true;
    entry.returned_at = now;
    entry.yield_awarded_lamports = yield_share_lamports;

    Ok(())
}
