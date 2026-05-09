use anchor_lang::prelude::*;

use hooked_common::CONFIG_SEED;

use crate::errors::RoomError;
use crate::state::ProgramConfig;

#[derive(Accounts)]
pub struct UpdateProgramConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.admin == admin.key() @ RoomError::Unauthorized,
    )]
    pub config: Account<'info, ProgramConfig>,

    pub admin: Signer<'info>,
}

pub fn treasury(ctx: Context<UpdateProgramConfig>, new_treasury: Pubkey) -> Result<()> {
    ctx.accounts.config.treasury = new_treasury;
    Ok(())
}

pub fn lp_manager(ctx: Context<UpdateProgramConfig>, new_lp_manager: Pubkey) -> Result<()> {
    ctx.accounts.config.lp_manager = new_lp_manager;
    Ok(())
}
