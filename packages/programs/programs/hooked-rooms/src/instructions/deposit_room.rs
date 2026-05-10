use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use hooked_common::{
    is_valid_deposit_lamports, CONFIG_SEED, MAX_DEPOSIT_LAMPORTS, MIN_DEPOSIT_LAMPORTS,
    ROOM_ENTRY_SEED, ROOM_SEED, ROOM_VAULT_SEED,
};

use crate::errors::RoomError;
use crate::state::{ProgramConfig, Room, RoomEntry, RoomStatus, ROOM_ENTRY_VERSION};

#[derive(Accounts)]
pub struct DepositRoom<'info> {
    #[account(
        mut,
        seeds = [ROOM_SEED, &room.room_id.to_le_bytes()],
        bump = room.bump,
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

    #[account(
        init,
        payer = authority,
        space = RoomEntry::SIZE,
        seeds = [ROOM_ENTRY_SEED, room.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub entry: Account<'info, RoomEntry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositRoom>, deposit_lamports: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let now = Clock::get()?.unix_timestamp;
    let room = &ctx.accounts.room;

    require!(
        room.status == RoomStatus::Entry as u8,
        RoomError::RoomNotAcceptingDeposits
    );
    require!(
        now < room.entry_closes_at,
        RoomError::RoomEntryWindowClosed
    );
    require!(
        deposit_lamports >= MIN_DEPOSIT_LAMPORTS,
        RoomError::DepositBelowMinimum
    );
    require!(
        deposit_lamports <= MAX_DEPOSIT_LAMPORTS,
        RoomError::DepositAboveMaximum
    );
    require!(
        is_valid_deposit_lamports(deposit_lamports),
        RoomError::InvalidDepositAmount
    );
    require!(room.human_count < room.max_humans, RoomError::RoomFull);
    let new_total = room
        .deposited_lamports
        .checked_add(deposit_lamports)
        .ok_or(RoomError::Overflow)?;
    require!(
        new_total <= room.capacity_lamports,
        RoomError::RoomCapacityExceeded
    );

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.room_vault.to_account_info(),
            },
        ),
        deposit_lamports,
    )?;

    let entry = &mut ctx.accounts.entry;
    entry.version = ROOM_ENTRY_VERSION;
    entry.room = ctx.accounts.room.key();
    entry.authority = ctx.accounts.authority.key();
    entry.deposit_lamports = deposit_lamports;
    entry.final_score = 0;
    entry.final_rank = 0;
    entry.yield_awarded_lamports = 0;
    entry.joined_at = now;
    entry.returned = false;
    entry.returned_at = 0;
    entry.bump = ctx.bumps.entry;
    entry._reserved = [0u8; 32];

    let room = &mut ctx.accounts.room;
    room.deposited_lamports = new_total;
    room.human_count = room
        .human_count
        .checked_add(1)
        .ok_or(RoomError::Overflow)?;

    Ok(())
}
