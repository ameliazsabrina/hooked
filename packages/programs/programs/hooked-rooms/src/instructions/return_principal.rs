use anchor_lang::prelude::*;

use hooked_common::{ROOM_ENTRY_SEED, ROOM_SEED, ROOM_VAULT_SEED};

use crate::errors::RoomError;
use crate::state::{Room, RoomEntry, RoomStatus};

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

    /// CHECK: Room-owned SOL vault PDA, validated by seeds + room.vault_bump.
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
}

pub fn handler(ctx: Context<ReturnPrincipal>, yield_share_lamports: u64) -> Result<()> {
    let entry = &ctx.accounts.entry;

    let total = entry
        .deposit_lamports
        .checked_add(yield_share_lamports)
        .ok_or(RoomError::Overflow)?;

    let vault_info = ctx.accounts.room_vault.to_account_info();
    let recipient_info = ctx.accounts.recipient.to_account_info();

    require!(
        vault_info.lamports() >= total,
        RoomError::VaultInsufficientFunds
    );

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(total)
        .ok_or(RoomError::Overflow)?;
    **recipient_info.try_borrow_mut_lamports()? = recipient_info
        .lamports()
        .checked_add(total)
        .ok_or(RoomError::Overflow)?;

    let now = Clock::get()?.unix_timestamp;
    let entry = &mut ctx.accounts.entry;
    entry.returned = true;
    entry.returned_at = now;
    entry.yield_awarded_lamports = yield_share_lamports;

    Ok(())
}
