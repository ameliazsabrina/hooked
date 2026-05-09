use anchor_lang::prelude::*;

use hooked_common::{CONFIG_SEED, ROOM_SEED, ROOM_VAULT_SEED};

use crate::errors::RoomError;
use crate::state::{ProgramConfig, Room, RoomStatus};

#[derive(Accounts)]
pub struct FinalizeRoom<'info> {
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

pub fn handler(ctx: Context<FinalizeRoom>) -> Result<()> {
    let vault_info = ctx.accounts.room_vault.to_account_info();
    let treasury_info = ctx.accounts.treasury.to_account_info();

    let sweep = vault_info.lamports();
    if sweep > 0 {
        **vault_info.try_borrow_mut_lamports()? = 0;
        **treasury_info.try_borrow_mut_lamports()? = treasury_info
            .lamports()
            .checked_add(sweep)
            .ok_or(RoomError::Overflow)?;
    }

    let room = &mut ctx.accounts.room;
    room.status = RoomStatus::Closed as u8;

    Ok(())
}
