use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("4ERUTWVN3aJP5tghEcZNd555NGcK3Jr8B21mnBB8JSMg");

#[program]
pub mod hooked_rooms {
    use super::*;

    pub fn create_room(ctx: Context<CreateRoom>, room_id: u64) -> Result<()> {
        instructions::create_room::handler(ctx, room_id)
    }

    pub fn deposit_room(ctx: Context<DepositRoom>, deposit_lamports: u64) -> Result<()> {
        instructions::deposit_room::handler(ctx, deposit_lamports)
    }

    pub fn close_room(ctx: Context<CloseRoom>, yield_lamports: u64) -> Result<()> {
        instructions::close_room::handler(ctx, yield_lamports)
    }

    pub fn return_principal(
        ctx: Context<ReturnPrincipal>,
        yield_share_lamports: u64,
    ) -> Result<()> {
        instructions::return_principal::handler(ctx, yield_share_lamports)
    }

    pub fn finalize_room(ctx: Context<FinalizeRoom>) -> Result<()> {
        instructions::finalize_room::handler(ctx)
    }

    pub fn init_program_config(
        ctx: Context<InitProgramConfig>,
        treasury: Pubkey,
        lp_manager: Pubkey,
    ) -> Result<()> {
        instructions::init_program_config::handler(ctx, treasury, lp_manager)
    }

    pub fn set_treasury(ctx: Context<UpdateProgramConfig>, new_treasury: Pubkey) -> Result<()> {
        instructions::update_program_config::treasury(ctx, new_treasury)
    }

    pub fn set_lp_manager(
        ctx: Context<UpdateProgramConfig>,
        new_lp_manager: Pubkey,
    ) -> Result<()> {
        instructions::update_program_config::lp_manager(ctx, new_lp_manager)
    }

    pub fn init_gateway_registry(
        ctx: Context<InitGatewayRegistry>,
        initial_keeper: Pubkey,
    ) -> Result<()> {
        instructions::init_gateway_registry::handler(ctx, initial_keeper)
    }

    pub fn add_gateway_key(ctx: Context<UpdateGatewayRegistry>, key: Pubkey) -> Result<()> {
        instructions::update_gateway_registry::add(ctx, key)
    }

    pub fn remove_gateway_key(ctx: Context<UpdateGatewayRegistry>, key: Pubkey) -> Result<()> {
        instructions::update_gateway_registry::remove(ctx, key)
    }

    pub fn update_room_entry_score(
        ctx: Context<UpdateRoomEntryScore>,
        score_delta: u64,
    ) -> Result<()> {
        instructions::update_room_entry_score::handler(ctx, score_delta)
    }

    pub fn withdraw_to_lp_manager(
        ctx: Context<WithdrawToLpManager>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_to_lp_manager::handler(ctx, amount)
    }
}
