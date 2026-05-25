use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

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

    /// CHECK: Room SOL vault PDA, validated by seeds + room.vault_bump.
    #[account(
        mut,
        seeds = [ROOM_VAULT_SEED, room.key().as_ref()],
        bump = room.vault_bump,
    )]
    pub room_vault: UncheckedAccount<'info>,

    /// CHECK: Off-chain LP manager wallet, pinned to `config.lp_manager`.
    #[account(
        mut,
        constraint = lp_manager.key() == config.lp_manager @ RoomError::LpManagerMismatch,
    )]
    pub lp_manager: UncheckedAccount<'info>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
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
    // Only a lower bound: LP may be deployed any time at/after lp_deploy_at,
    // including after closes_at, to recover rooms whose LP automation failed
    // during the original window. The `status == Entry` account constraint
    // still blocks this once close_room has run, so funds can never leave to
    // the LP manager after settlement begins.
    require!(now >= room.lp_deploy_at, RoomError::LpDeployWindowNotOpen);
    require!(
        amount <= room.deposited_lamports,
        RoomError::LpAmountExceedsDeposited
    );

    require!(
        ctx.accounts.room_vault.lamports() >= amount,
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
                to: ctx.accounts.lp_manager.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let room = &mut ctx.accounts.room;
    room.lp_deployed_lamports = amount;
    room.lp_manager = ctx.accounts.lp_manager.key();

    Ok(())
}
