use anchor_lang::prelude::*;

use hooked_common::{CONFIG_SEED, ROOM_SEED, ROOM_VAULT_SEED};

use crate::errors::RoomError;
use crate::state::{ProgramConfig, Room, RoomStatus};

#[derive(Accounts)]
pub struct WithdrawToLpManager<'info> {
    #[account(
        mut,
        seeds = [ROOM_SEED, &room.room_id.to_le_bytes()],
        bump = room.bump,
        constraint = room.admin == admin.key() @ RoomError::Unauthorized,
        constraint = room.status == RoomStatus::Entry as u8 @ RoomError::LpDeployWindowNotOpen,
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

    /// CHECK: Off-chain LP manager wallet that will hold principal during the
    /// LP cycle. Pinned to `config.lp_manager`; recorded on `room.lp_manager`
    /// for per-room auditability.
    #[account(
        mut,
        constraint = lp_manager.key() == config.lp_manager @ RoomError::LpManagerMismatch,
    )]
    pub lp_manager: UncheckedAccount<'info>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<WithdrawToLpManager>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let now = Clock::get()?.unix_timestamp;
    let room = &ctx.accounts.room;

    require!(amount > 0, RoomError::LpAmountZero);
    require!(
        room.lp_deployed_lamports == 0,
        RoomError::LpAlreadyDeployed
    );
    require!(
        now >= room.lp_deploy_at && now < room.closes_at,
        RoomError::LpDeployWindowNotOpen
    );
    require!(
        amount <= room.deposited_lamports,
        RoomError::LpAmountExceedsDeposited
    );

    let vault_info = ctx.accounts.room_vault.to_account_info();
    let manager_info = ctx.accounts.lp_manager.to_account_info();

    require!(
        vault_info.lamports() >= amount,
        RoomError::VaultInsufficientFunds
    );

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(amount)
        .ok_or(RoomError::Overflow)?;
    **manager_info.try_borrow_mut_lamports()? = manager_info
        .lamports()
        .checked_add(amount)
        .ok_or(RoomError::Overflow)?;

    let room = &mut ctx.accounts.room;
    room.lp_deployed_lamports = amount;
    room.lp_manager = ctx.accounts.lp_manager.key();

    Ok(())
}
