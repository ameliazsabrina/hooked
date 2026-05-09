use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum RoomStatus {
    Entry = 0,
    Active = 1,
    Settling = 2,
    Closed = 3,
}

impl TryFrom<u8> for RoomStatus {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, ()> {
        match v {
            0 => Ok(RoomStatus::Entry),
            1 => Ok(RoomStatus::Active),
            2 => Ok(RoomStatus::Settling),
            3 => Ok(RoomStatus::Closed),
            _ => Err(()),
        }
    }
}

#[account]
pub struct Room {
    pub admin: Pubkey,
    pub room_id: u64,
    pub created_at: i64,
    pub entry_closes_at: i64,
    pub lp_deploy_at: i64,
    pub closes_at: i64,
    pub capacity_lamports: u64,
    pub deposited_lamports: u64,
    pub human_count: u16,
    pub max_humans: u16,
    pub status: u8,
    pub lp_position: Pubkey,
    pub lp_manager: Pubkey,
    pub lp_deployed_lamports: u64,
    pub yield_lamports: u64,
    pub first_place: Pubkey,
    pub second_place: Pubkey,
    pub third_place: Pubkey,
    pub first_place_score: u64,
    pub second_place_score: u64,
    pub third_place_score: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Room {
    pub const SIZE: usize = 8   // discriminator
        + 32                     // admin
        + 8                      // room_id
        + 8                      // created_at
        + 8                      // entry_closes_at
        + 8                      // lp_deploy_at
        + 8                      // closes_at
        + 8                      // capacity_lamports
        + 8                      // deposited_lamports
        + 2                      // human_count
        + 2                      // max_humans
        + 1                      // status
        + 32                     // lp_position
        + 32                     // lp_manager
        + 8                      // lp_deployed_lamports
        + 8                      // yield_lamports
        + 32                     // first_place
        + 32                     // second_place
        + 32                     // third_place
        + 8                      // first_place_score
        + 8                      // second_place_score
        + 8                      // third_place_score
        + 1                      // bump
        + 1;                     // vault_bump
}

#[account]
pub struct RoomEntry {
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

impl RoomEntry {
    pub const SIZE: usize = 8
        + 32
        + 32
        + 8
        + 8
        + 2
        + 8
        + 8
        + 1
        + 8
        + 1;
}

#[account]
pub struct ProgramConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub lp_manager: Pubkey,
    pub bump: u8,
}

impl ProgramConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1;
}

pub const MAX_GATEWAY_KEYS: usize = 8;

#[account]
pub struct GatewayRegistry {
    pub admin: Pubkey,
    pub key_count: u8,
    pub keys: [Pubkey; MAX_GATEWAY_KEYS],
    pub bump: u8,
}

impl GatewayRegistry {
    pub const SIZE: usize = 8 + 32 + 1 + 32 * MAX_GATEWAY_KEYS + 1;

    pub fn contains(&self, key: &Pubkey) -> bool {
        let count = self.key_count as usize;
        self.keys
            .iter()
            .take(count)
            .any(|k| k == key)
    }
}
