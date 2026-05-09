use anchor_lang::prelude::*;

use hooked_common::GATEWAY_REGISTRY_SEED;

use crate::errors::RoomError;
use crate::state::{GatewayRegistry, MAX_GATEWAY_KEYS};

#[derive(Accounts)]
pub struct UpdateGatewayRegistry<'info> {
    #[account(
        mut,
        seeds = [GATEWAY_REGISTRY_SEED],
        bump = registry.bump,
        constraint = registry.admin == admin.key() @ RoomError::Unauthorized,
    )]
    pub registry: Account<'info, GatewayRegistry>,

    pub admin: Signer<'info>,
}

pub fn add(ctx: Context<UpdateGatewayRegistry>, key: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    require!(
        !registry.contains(&key),
        RoomError::GatewayKeyAlreadyPresent
    );
    require!(
        (registry.key_count as usize) < MAX_GATEWAY_KEYS,
        RoomError::GatewayRegistryFull
    );
    let idx = registry.key_count as usize;
    registry.keys[idx] = key;
    registry.key_count = registry
        .key_count
        .checked_add(1)
        .ok_or(RoomError::Overflow)?;
    Ok(())
}

pub fn remove(ctx: Context<UpdateGatewayRegistry>, key: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    let count = registry.key_count as usize;
    let pos = registry
        .keys
        .iter()
        .take(count)
        .position(|k| k == &key)
        .ok_or(RoomError::GatewayKeyNotFound)?;
    let last = count - 1;
    if pos != last {
        registry.keys[pos] = registry.keys[last];
    }
    registry.keys[last] = Pubkey::default();
    registry.key_count = (last) as u8;
    Ok(())
}
