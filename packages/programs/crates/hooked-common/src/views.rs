use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RoomEntryView {
    pub room: Pubkey,
    pub authority: Pubkey,
    pub deposit_lamports: u64,
    pub final_score: u64,
    pub final_rank: u16,
    pub yield_awarded_lamports: u64,
    pub joined_at: i64,
    pub returned: bool,
    pub returned_at: i64,
    pub bump: u8,
}
