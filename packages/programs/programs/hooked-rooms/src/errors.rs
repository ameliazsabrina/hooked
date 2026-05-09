use anchor_lang::prelude::*;

#[error_code]
pub enum RoomError {
    #[msg("Unauthorized — signer does not match authority")]
    Unauthorized,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Room is not in Entry status — deposits closed")]
    RoomNotAcceptingDeposits,

    #[msg("Room entry window has closed")]
    RoomEntryWindowClosed,

    #[msg("Room is full — capacity reached")]
    RoomFull,

    #[msg("Room TVL cap would be exceeded by this deposit")]
    RoomCapacityExceeded,

    #[msg("Deposit below minimum (0.5 SOL)")]
    DepositBelowMinimum,

    #[msg("Deposit above maximum (2 SOL)")]
    DepositAboveMaximum,

    #[msg("Deposit must be one of 0.5, 1.0, 1.5, or 2.0 SOL")]
    InvalidDepositAmount,

    #[msg("Room has not reached its close timestamp")]
    RoomNotClosable,

    #[msg("Room is already closed")]
    RoomAlreadyClosed,

    #[msg("Room is not in Active status — LP cannot be deployed")]
    RoomNotActive,

    #[msg("Principal for this entry has already been returned")]
    PrincipalAlreadyReturned,

    #[msg("Insufficient vault balance to return principal")]
    VaultInsufficientFunds,

    #[msg("Room is not in Settling status")]
    RoomNotSettling,

    #[msg("Entry does not belong to the provided room")]
    EntryRoomMismatch,

    #[msg("Signer is not a whitelisted gateway/keeper key")]
    NotGateway,

    #[msg("Gateway registry is full — cannot add more keys")]
    GatewayRegistryFull,

    #[msg("Gateway key already present in the registry")]
    GatewayKeyAlreadyPresent,

    #[msg("Gateway key not found in the registry")]
    GatewayKeyNotFound,

    #[msg("Remaining-account top-3 entries do not match the ranked_entry argument")]
    RankedEntryMismatch,

    #[msg("LP principal has already been withdrawn for this room")]
    LpAlreadyDeployed,

    #[msg("LP deploy window is not open — too early or too late")]
    LpDeployWindowNotOpen,

    #[msg("LP withdraw amount exceeds room deposited principal")]
    LpAmountExceedsDeposited,

    #[msg("LP withdraw amount must be greater than zero")]
    LpAmountZero,

    #[msg("Treasury account does not match the canonical ProgramConfig.treasury")]
    TreasuryMismatch,

    #[msg("LP manager account does not match the canonical ProgramConfig.lp_manager")]
    LpManagerMismatch,
}
