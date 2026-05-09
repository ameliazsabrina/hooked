pub const MAX_CATCHES: usize = 15;

pub const GREEN_ZONE_WIDTH_BPS: u16 = 2000;

pub const BPS_SCALE: u16 = 10_000;

pub const PITY_THRESHOLD: u8 = 10;

pub const MIN_RESOLVE_ELAPSED_SECS: i64 = 1;
pub const MAX_RESOLVE_ELAPSED_SECS: i64 = 30;

pub const DELEGATION_COMMIT_MS: u32 = 30_000;

// Rarity multipliers × 10 (integer math). Applied as `(mult * weight_hg) / 100`
// to yield `weight_kg * mult_as_decimal`. Decimals: Basic 1.0, Rare 1.5,
// Monster 2.5, Legendary 3.5, Apex 4.0.
pub const SCORE_MULTIPLIERS: [u32; 5] = [10, 15, 25, 35, 40];

// PRD §6.2 catch-rate targets (24h avg, bp out of 10_000):
//   Basic 7550 / Rare 2000 / Monster 400 / Legendary 40 / Apex 10.
// Apex baseline is 0 bp here — it is gated by `EventConfig` (e.g. Colosseum).
// During an active event, `EventConfig.apex_bp` is subtracted from Basic in
// `initiate_cast` to honor the 10 bp target without changing this table. The
// extra 10 bp of headroom in Basic absorbs Apex when no event is active.
pub const DAY_RARITY_WEIGHTS: [u16; 5] = [7604, 1980, 380, 36, 0];

pub const NIGHT_RARITY_WEIGHTS: [u16; 5] = [7516, 2020, 420, 44, 0];

const _: () = {
    let day_sum = DAY_RARITY_WEIGHTS[0] as u32
        + DAY_RARITY_WEIGHTS[1] as u32
        + DAY_RARITY_WEIGHTS[2] as u32
        + DAY_RARITY_WEIGHTS[3] as u32
        + DAY_RARITY_WEIGHTS[4] as u32;
    let night_sum = NIGHT_RARITY_WEIGHTS[0] as u32
        + NIGHT_RARITY_WEIGHTS[1] as u32
        + NIGHT_RARITY_WEIGHTS[2] as u32
        + NIGHT_RARITY_WEIGHTS[3] as u32
        + NIGHT_RARITY_WEIGHTS[4] as u32;
    assert!(day_sum == BPS_SCALE as u32, "DAY_RARITY_WEIGHTS must sum to BPS_SCALE");
    assert!(night_sum == BPS_SCALE as u32, "NIGHT_RARITY_WEIGHTS must sum to BPS_SCALE");
};

pub struct SpeciesEntry {
    pub id: u8,
    pub rarity: u8,
    pub zone: u8,
    pub min_weight_hg: u16,
    pub max_weight_hg: u16,
}

pub const SPECIES_COUNT: usize = 23;

pub const SPECIES_TABLE: [SpeciesEntry; SPECIES_COUNT] = [
    SpeciesEntry { id: 0,  rarity: 0, zone: 0, min_weight_hg: 10,  max_weight_hg: 30  },
    SpeciesEntry { id: 1,  rarity: 0, zone: 0, min_weight_hg: 20,  max_weight_hg: 50  },
    SpeciesEntry { id: 2,  rarity: 0, zone: 0, min_weight_hg: 30,  max_weight_hg: 60  },
    SpeciesEntry { id: 3,  rarity: 0, zone: 1, min_weight_hg: 10,  max_weight_hg: 40  },
    SpeciesEntry { id: 4,  rarity: 0, zone: 1, min_weight_hg: 50,  max_weight_hg: 100 },
    SpeciesEntry { id: 5,  rarity: 1, zone: 0, min_weight_hg: 50,  max_weight_hg: 100 },
    SpeciesEntry { id: 6,  rarity: 1, zone: 1, min_weight_hg: 70,  max_weight_hg: 130 },
    SpeciesEntry { id: 7,  rarity: 1, zone: 1, min_weight_hg: 80,  max_weight_hg: 150 },
    SpeciesEntry { id: 8,  rarity: 1, zone: 2, min_weight_hg: 120, max_weight_hg: 200 },
    SpeciesEntry { id: 9,  rarity: 1, zone: 2, min_weight_hg: 100, max_weight_hg: 180 },
    SpeciesEntry { id: 10, rarity: 2, zone: 2, min_weight_hg: 200, max_weight_hg: 300 },
    SpeciesEntry { id: 11, rarity: 2, zone: 0, min_weight_hg: 150, max_weight_hg: 250 },
    SpeciesEntry { id: 12, rarity: 2, zone: 1, min_weight_hg: 100, max_weight_hg: 200 },
    SpeciesEntry { id: 13, rarity: 2, zone: 1, min_weight_hg: 120, max_weight_hg: 220 },
    SpeciesEntry { id: 14, rarity: 2, zone: 2, min_weight_hg: 220, max_weight_hg: 300 },
    SpeciesEntry { id: 15, rarity: 3, zone: 3, min_weight_hg: 400, max_weight_hg: 500 },
    SpeciesEntry { id: 16, rarity: 3, zone: 2, min_weight_hg: 300, max_weight_hg: 450 },
    SpeciesEntry { id: 17, rarity: 3, zone: 3, min_weight_hg: 250, max_weight_hg: 400 },
    SpeciesEntry { id: 18, rarity: 3, zone: 3, min_weight_hg: 350, max_weight_hg: 500 },
    SpeciesEntry { id: 19, rarity: 3, zone: 3, min_weight_hg: 200, max_weight_hg: 350 },
    // Apex (Colosseum event) — 30–100 kg, gated by EventConfig.
    SpeciesEntry { id: 20, rarity: 4, zone: 3, min_weight_hg: 300, max_weight_hg: 500  }, // Anh Lucerna
    SpeciesEntry { id: 21, rarity: 4, zone: 3, min_weight_hg: 500, max_weight_hg: 800  }, // Mattus Aureus
    SpeciesEntry { id: 22, rarity: 4, zone: 3, min_weight_hg: 700, max_weight_hg: 1000 }, // Maximus Tridens
];

pub const SPECIES_PER_RARITY: [u8; 5] = [5, 5, 5, 5, 3];

pub const RARITY_START_INDEX: [u8; 5] = [0, 5, 10, 15, 20];

pub const CIRCULAR_TAP_LEGENDARY_TAPS: u8 = 3;
pub const CIRCULAR_TAP_LEGENDARY_ALLOWED_MISSES: u8 = 1;
pub const CIRCULAR_TAP_APEX_TAPS: u8 = 5;
pub const CIRCULAR_TAP_APEX_ALLOWED_MISSES: u8 = 0;

pub const ROOM_ENTRY_WINDOW_SECS: i64 = 24 * 60 * 60;

pub const ROOM_DURATION_SECS: i64 = 7 * 24 * 60 * 60;

pub const MIN_DEPOSIT_LAMPORTS: u64 = 500_000_000;
pub const MAX_DEPOSIT_LAMPORTS: u64 = 2_000_000_000;
pub const DEPOSIT_STEP_LAMPORTS: u64 = 500_000_000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

pub const ROOM_CAPACITY_LAMPORTS: u64 = 20_000_000_000;

pub const MAX_ROOM_PLAYERS: u16 = 40;

pub const BAITS_PER_SOL_PER_SESSION: u64 = 10;
pub const MIN_BAITS_PER_SESSION: u8 = 5;
pub const MAX_BAITS_PER_SESSION: u8 = 20;
pub const BAIT_STEP: u8 = 5;

pub fn is_valid_deposit_lamports(deposit_lamports: u64) -> bool {
    deposit_lamports >= MIN_DEPOSIT_LAMPORTS
        && deposit_lamports <= MAX_DEPOSIT_LAMPORTS
        && deposit_lamports % DEPOSIT_STEP_LAMPORTS == 0
}

pub fn baits_per_session_for_lamports(deposit_lamports: u64) -> Option<u8> {
    if !is_valid_deposit_lamports(deposit_lamports) {
        return None;
    }

    let baits = deposit_lamports
        .checked_mul(BAITS_PER_SOL_PER_SESSION)?
        .checked_div(LAMPORTS_PER_SOL)?;
    u8::try_from(baits).ok().filter(|amount| *amount > 0)
}

pub fn is_valid_bait_amount(amount: u8) -> bool {
    amount >= MIN_BAITS_PER_SESSION
        && amount <= MAX_BAITS_PER_SESSION
        && amount % BAIT_STEP == 0
}

pub const YIELD_SHARE_PROTOCOL_BPS: u64 = 3000;
pub const YIELD_SHARE_FIRST_BPS: u64 = 4000;
pub const YIELD_SHARE_SECOND_BPS: u64 = 2000;
pub const YIELD_SHARE_THIRD_BPS: u64 = 1000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baits_scale_with_valid_sol_deposits() {
        assert_eq!(baits_per_session_for_lamports(500_000_000), Some(5));
        assert_eq!(baits_per_session_for_lamports(1_000_000_000), Some(10));
        assert_eq!(baits_per_session_for_lamports(1_500_000_000), Some(15));
        assert_eq!(baits_per_session_for_lamports(2_000_000_000), Some(20));
    }

    #[test]
    fn baits_reject_non_deposit_increments() {
        assert_eq!(baits_per_session_for_lamports(750_000_000), None);
        assert_eq!(baits_per_session_for_lamports(2_500_000_000), None);
    }

    #[test]
    fn bait_amounts_match_supported_deposit_tiers() {
        assert!(is_valid_bait_amount(5));
        assert!(is_valid_bait_amount(10));
        assert!(is_valid_bait_amount(15));
        assert!(is_valid_bait_amount(20));
        assert!(!is_valid_bait_amount(7));
        assert!(!is_valid_bait_amount(25));
    }
}
