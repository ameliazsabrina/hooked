use anchor_lang::prelude::*;

use hooked_common::{CONFIG_SEED, ROOM_SEED};

use crate::errors::RoomError;
use crate::state::{ProgramConfig, Room, RoomStatus};

/// DEV ONLY — overwrites `closes_at` (and clamps `entry_closes_at`) so the
/// settlement flow can be exercised without waiting the full 7-day window.
/// Same admin-gating as `close_room` (room.admin signs). Status must not
/// already be Closed. Intended for localnet/devnet smoke-tests; remove or
/// gate behind a build feature before mainnet.
#[derive(Accounts)]
pub struct DevForceCloseAt<'info> {
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

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<DevForceCloseAt>, new_closes_at: i64) -> Result<()> {
    require!(!ctx.accounts.config.paused, RoomError::Paused);

    let room = &mut ctx.accounts.room;

    // Preserve invariant: entry_closes_at <= closes_at. Clamp down so the
    // room is also out of entry phase if the caller is force-closing into
    // the past.
    if new_closes_at < room.entry_closes_at {
        room.entry_closes_at = new_closes_at;
    }
    if new_closes_at < room.lp_deploy_at {
        room.lp_deploy_at = new_closes_at;
    }
    room.closes_at = new_closes_at;

    Ok(())
}
