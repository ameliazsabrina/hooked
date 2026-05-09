use anchor_lang::prelude::*;

use hooked_common::CONFIG_SEED;

use crate::state::ProgramConfig;

#[derive(Accounts)]
pub struct InitProgramConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = ProgramConfig::SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitProgramConfig>,
    treasury: Pubkey,
    lp_manager: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.treasury = treasury;
    config.lp_manager = lp_manager;
    config.bump = ctx.bumps.config;
    Ok(())
}
