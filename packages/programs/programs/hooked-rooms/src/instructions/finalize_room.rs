use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

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
    /// Owned by System Program (created by depositors via system::transfer),
    /// so lamport withdrawals must go through a system_program::transfer
    /// CPI with the vault's PDA seeds for invoke_signed.
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

pub fn handler(ctx: Context<FinalizeRoom>) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let sweep = ctx.accounts.room_vault.lamports();
    if sweep > 0 {
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
            sweep,
        )?;
    }

    let room = &mut ctx.accounts.room;
    room.status = RoomStatus::Closed as u8;

    Ok(())
}
