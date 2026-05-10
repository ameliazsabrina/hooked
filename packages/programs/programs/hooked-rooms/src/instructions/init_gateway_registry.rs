use anchor_lang::prelude::*;

use hooked_common::GATEWAY_REGISTRY_SEED;

use crate::state::{GatewayRegistry, GATEWAY_REGISTRY_VERSION, MAX_GATEWAY_KEYS};

#[derive(Accounts)]
pub struct InitGatewayRegistry<'info> {
    #[account(
        init,
        payer = admin,
        space = GatewayRegistry::SIZE,
        seeds = [GATEWAY_REGISTRY_SEED],
        bump,
    )]
    pub registry: Account<'info, GatewayRegistry>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitGatewayRegistry>, initial_keeper: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.version = GATEWAY_REGISTRY_VERSION;
    registry.admin = ctx.accounts.admin.key();
    registry.key_count = 1;
    registry.keys = [Pubkey::default(); MAX_GATEWAY_KEYS];
    registry.keys[0] = initial_keeper;
    registry.bump = ctx.bumps.registry;
    registry._reserved = [0u8; 64];
    Ok(())
}
