use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Rarity {
    Basic = 0,
    Rare = 1,
    Monster = 2,
    Legendary = 3,
    Apex = 4,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Zone {
    Shore = 0,
    Coastal = 1,
    OpenSea = 2,
    Abyss = 3,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Window {
    Day = 0,
    Night = 1,
}

impl TryFrom<u8> for Window {
    type Error = ();
    fn try_from(v: u8) -> core::result::Result<Self, ()> {
        match v {
            0 => Ok(Window::Day),
            1 => Ok(Window::Night),
            _ => Err(()),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Mechanic {
    TimingBar = 0,
    CircularTap = 1,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum DelegationState {
    None = 0,
    Delegated = 1,
}
