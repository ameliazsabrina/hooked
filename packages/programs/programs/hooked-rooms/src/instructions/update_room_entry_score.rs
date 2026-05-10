use anchor_lang::prelude::*;

use hooked_common::{CONFIG_SEED, GATEWAY_REGISTRY_SEED, ROOM_ENTRY_SEED, ROOM_SEED};

use crate::errors::RoomError;
use crate::state::{GatewayRegistry, ProgramConfig, Room, RoomEntry};

#[derive(Accounts)]
pub struct UpdateRoomEntryScore<'info> {
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

    #[account(
        mut,
        seeds = [ROOM_ENTRY_SEED, room.key().as_ref(), entry.authority.as_ref()],
        bump = entry.bump,
        constraint = entry.room == room.key() @ RoomError::EntryRoomMismatch,
    )]
    pub entry: Account<'info, RoomEntry>,

    #[account(
        seeds = [GATEWAY_REGISTRY_SEED],
        bump = registry.bump,
        constraint = registry.contains(&keeper.key()) @ RoomError::NotGateway,
    )]
    pub registry: Account<'info, GatewayRegistry>,

    pub keeper: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateRoomEntryScore>, score_delta: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let entry = &mut ctx.accounts.entry;
    let new_score = entry
        .final_score
        .checked_add(score_delta)
        .ok_or(RoomError::Overflow)?;
    entry.final_score = new_score;

    let room = &mut ctx.accounts.room;
    let authority = entry.authority;

    update_top_three(room, authority, new_score);

    Ok(())
}

fn update_top_three(room: &mut Room, authority: Pubkey, new_score: u64) {
    if room.first_place == authority {
        room.first_place_score = new_score;
    } else if room.second_place == authority {
        room.second_place_score = new_score;
    } else if room.third_place == authority {
        room.third_place_score = new_score;
    } else if new_score > room.first_place_score {
        room.third_place = room.second_place;
        room.third_place_score = room.second_place_score;
        room.second_place = room.first_place;
        room.second_place_score = room.first_place_score;
        room.first_place = authority;
        room.first_place_score = new_score;
        return;
    } else if new_score > room.second_place_score {
        room.third_place = room.second_place;
        room.third_place_score = room.second_place_score;
        room.second_place = authority;
        room.second_place_score = new_score;
        return;
    } else if new_score > room.third_place_score {
        room.third_place = authority;
        room.third_place_score = new_score;
        return;
    } else {
        return;
    }

    resort_cached_top_three(room);
}

fn resort_cached_top_three(room: &mut Room) {
    let mut slots: [(Pubkey, u64); 3] = [
        (room.first_place, room.first_place_score),
        (room.second_place, room.second_place_score),
        (room.third_place, room.third_place_score),
    ];
    slots.sort_by(|a, b| b.1.cmp(&a.1));
    room.first_place = slots[0].0;
    room.first_place_score = slots[0].1;
    room.second_place = slots[1].0;
    room.second_place_score = slots[1].1;
    room.third_place = slots[2].0;
    room.third_place_score = slots[2].1;
}
