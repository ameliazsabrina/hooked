use anchor_lang::prelude::*;

use hooked_common::{
    MAX_ROOM_PLAYERS, ROOM_CAPACITY_LAMPORTS, ROOM_DURATION_SECS, ROOM_ENTRY_WINDOW_SECS,
    ROOM_SEED, ROOM_VAULT_SEED,
};

use crate::errors::RoomError;
use crate::state::{Room, RoomStatus};

#[derive(Accounts)]
#[instruction(room_id: u64)]
pub struct CreateRoom<'info> {
    #[account(
        init,
        payer = admin,
        space = Room::SIZE,
        seeds = [ROOM_SEED, &room_id.to_le_bytes()],
        bump,
    )]
    pub room: Account<'info, Room>,

    /// CHECK: Room-owned SOL vault PDA, created lazily via system-program transfers from depositors.
    #[account(
        mut,
        seeds = [ROOM_VAULT_SEED, room.key().as_ref()],
        bump,
    )]
    pub room_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateRoom>, room_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let room = &mut ctx.accounts.room;

    room.admin = ctx.accounts.admin.key();
    room.room_id = room_id;
    room.created_at = now;
    room.entry_closes_at = now
        .checked_add(ROOM_ENTRY_WINDOW_SECS)
        .ok_or(error!(RoomError::Overflow))?;
    room.lp_deploy_at = room.entry_closes_at;
    room.closes_at = now
        .checked_add(ROOM_DURATION_SECS)
        .ok_or(error!(RoomError::Overflow))?;
    room.capacity_lamports = ROOM_CAPACITY_LAMPORTS;
    room.deposited_lamports = 0;
    room.human_count = 0;
    room.max_humans = MAX_ROOM_PLAYERS;
    room.status = RoomStatus::Entry as u8;
    room.lp_position = Pubkey::default();
    room.lp_manager = Pubkey::default();
    room.lp_deployed_lamports = 0;
    room.yield_lamports = 0;
    room.first_place = Pubkey::default();
    room.second_place = Pubkey::default();
    room.third_place = Pubkey::default();
    room.first_place_score = 0;
    room.second_place_score = 0;
    room.third_place_score = 0;
    room.bump = ctx.bumps.room;
    room.vault_bump = ctx.bumps.room_vault;

    Ok(())
}
