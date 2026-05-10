/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/hooked_rooms.json`.
 */
export type HookedRooms = {
  "address": "4ERUTWVN3aJP5tghEcZNd555NGcK3Jr8B21mnBB8JSMg",
  "metadata": {
    "name": "hookedRooms",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Hooked rooms program — weekly LP rooms (PRD v2.2), SOL-native deposits + keeper-driven settlement"
  },
  "instructions": [
    {
      "name": "addGatewayKey",
      "discriminator": [
        173,
        179,
        219,
        116,
        125,
        182,
        12,
        206
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  116,
                  101,
                  119,
                  97,
                  121,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "key",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "closeRoom",
      "discriminator": [
        152,
        197,
        88,
        192,
        98,
        197,
        51,
        211
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "room.room_id",
                "account": "room"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "roomVault",
          "docs": [
            "Owned by System Program (created by depositors via system::transfer),",
            "so lamport withdrawals must go through a system_program::transfer",
            "CPI with the vault's PDA seeds for invoke_signed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "room"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "yieldLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createRoom",
      "discriminator": [
        130,
        166,
        32,
        2,
        247,
        120,
        178,
        53
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "arg",
                "path": "roomId"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "roomVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "room"
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roomId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositRoom",
      "discriminator": [
        115,
        68,
        86,
        65,
        55,
        130,
        202,
        23
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "room.room_id",
                "account": "room"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "roomVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "room"
              }
            ]
          }
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "room"
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "depositLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "finalizeRoom",
      "discriminator": [
        138,
        6,
        78,
        73,
        213,
        216,
        51,
        199
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "room.room_id",
                "account": "room"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "roomVault",
          "docs": [
            "Owned by System Program (created by depositors via system::transfer),",
            "so lamport withdrawals must go through a system_program::transfer",
            "CPI with the vault's PDA seeds for invoke_signed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "room"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initGatewayRegistry",
      "discriminator": [
        59,
        186,
        55,
        90,
        147,
        236,
        182,
        70
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  116,
                  101,
                  119,
                  97,
                  121,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "initialKeeper",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initProgramConfig",
      "discriminator": [
        185,
        54,
        237,
        229,
        219,
        179,
        109,
        20
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "treasury",
          "type": "pubkey"
        },
        {
          "name": "lpManager",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "removeGatewayKey",
      "discriminator": [
        156,
        42,
        146,
        40,
        196,
        25,
        60,
        153
      ],
      "accounts": [
        {
          "name": "registry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  116,
                  101,
                  119,
                  97,
                  121,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "key",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "returnPrincipal",
      "discriminator": [
        27,
        177,
        124,
        34,
        3,
        16,
        96,
        76
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "room.room_id",
                "account": "room"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "roomVault",
          "docs": [
            "Owned by System Program (created by depositors via system::transfer),",
            "so lamport withdrawals must go through a system_program::transfer",
            "CPI with the vault's PDA seeds for invoke_signed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "room"
              }
            ]
          }
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "room"
              },
              {
                "kind": "account",
                "path": "recipient"
              }
            ]
          }
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "yieldShareLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setLpManager",
      "discriminator": [
        197,
        249,
        1,
        150,
        211,
        172,
        233,
        5
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newLpManager",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPaused",
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setTreasury",
      "discriminator": [
        57,
        97,
        196,
        95,
        195,
        206,
        106,
        136
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newTreasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateRoomEntryScore",
      "discriminator": [
        16,
        56,
        121,
        156,
        240,
        49,
        103,
        13
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "room.room_id",
                "account": "room"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  101,
                  110,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "room"
              },
              {
                "kind": "account",
                "path": "entry.authority",
                "account": "roomEntry"
              }
            ]
          }
        },
        {
          "name": "registry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  116,
                  101,
                  119,
                  97,
                  121,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "keeper",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "scoreDelta",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawToLpManager",
      "discriminator": [
        33,
        167,
        51,
        58,
        24,
        101,
        74,
        62
      ],
      "accounts": [
        {
          "name": "room",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "room.room_id",
                "account": "room"
              }
            ]
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "roomVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  109,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "room"
              }
            ]
          }
        },
        {
          "name": "lpManager",
          "docs": [
            "LP cycle. Pinned to `config.lp_manager`; recorded on `room.lp_manager`",
            "for per-room auditability."
          ],
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "gatewayRegistry",
      "discriminator": [
        207,
        115,
        197,
        33,
        28,
        106,
        182,
        209
      ]
    },
    {
      "name": "programConfig",
      "discriminator": [
        196,
        210,
        90,
        231,
        144,
        149,
        140,
        63
      ]
    },
    {
      "name": "room",
      "discriminator": [
        156,
        199,
        67,
        27,
        222,
        23,
        185,
        94
      ]
    },
    {
      "name": "roomEntry",
      "discriminator": [
        174,
        36,
        23,
        226,
        207,
        56,
        245,
        129
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized — signer does not match authority"
    },
    {
      "code": 6001,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6002,
      "name": "roomNotAcceptingDeposits",
      "msg": "Room is not in Entry status — deposits closed"
    },
    {
      "code": 6003,
      "name": "roomEntryWindowClosed",
      "msg": "Room entry window has closed"
    },
    {
      "code": 6004,
      "name": "roomFull",
      "msg": "Room is full — capacity reached"
    },
    {
      "code": 6005,
      "name": "roomCapacityExceeded",
      "msg": "Room TVL cap would be exceeded by this deposit"
    },
    {
      "code": 6006,
      "name": "depositBelowMinimum",
      "msg": "Deposit below minimum (0.5 SOL)"
    },
    {
      "code": 6007,
      "name": "depositAboveMaximum",
      "msg": "Deposit above maximum (2 SOL)"
    },
    {
      "code": 6008,
      "name": "invalidDepositAmount",
      "msg": "Deposit must be one of 0.5, 1.0, 1.5, or 2.0 SOL"
    },
    {
      "code": 6009,
      "name": "roomNotClosable",
      "msg": "Room has not reached its close timestamp"
    },
    {
      "code": 6010,
      "name": "roomAlreadyClosed",
      "msg": "Room is already closed"
    },
    {
      "code": 6011,
      "name": "roomNotActive",
      "msg": "Room is not in Active status — LP cannot be deployed"
    },
    {
      "code": 6012,
      "name": "principalAlreadyReturned",
      "msg": "Principal for this entry has already been returned"
    },
    {
      "code": 6013,
      "name": "vaultInsufficientFunds",
      "msg": "Insufficient vault balance to return principal"
    },
    {
      "code": 6014,
      "name": "roomNotSettling",
      "msg": "Room is not in Settling status"
    },
    {
      "code": 6015,
      "name": "entryRoomMismatch",
      "msg": "Entry does not belong to the provided room"
    },
    {
      "code": 6016,
      "name": "notGateway",
      "msg": "Signer is not a whitelisted gateway/keeper key"
    },
    {
      "code": 6017,
      "name": "gatewayRegistryFull",
      "msg": "Gateway registry is full — cannot add more keys"
    },
    {
      "code": 6018,
      "name": "gatewayKeyAlreadyPresent",
      "msg": "Gateway key already present in the registry"
    },
    {
      "code": 6019,
      "name": "gatewayKeyNotFound",
      "msg": "Gateway key not found in the registry"
    },
    {
      "code": 6020,
      "name": "rankedEntryMismatch",
      "msg": "Remaining-account top-3 entries do not match the ranked_entry argument"
    },
    {
      "code": 6021,
      "name": "lpAlreadyDeployed",
      "msg": "LP principal has already been withdrawn for this room"
    },
    {
      "code": 6022,
      "name": "lpDeployWindowNotOpen",
      "msg": "LP deploy window is not open — too early or too late"
    },
    {
      "code": 6023,
      "name": "lpAmountExceedsDeposited",
      "msg": "LP withdraw amount exceeds room deposited principal"
    },
    {
      "code": 6024,
      "name": "lpAmountZero",
      "msg": "LP withdraw amount must be greater than zero"
    },
    {
      "code": 6025,
      "name": "treasuryMismatch",
      "msg": "Treasury account does not match the canonical ProgramConfig.treasury"
    },
    {
      "code": 6026,
      "name": "lpManagerMismatch",
      "msg": "LP manager account does not match the canonical ProgramConfig.lp_manager"
    },
    {
      "code": 6027,
      "name": "paused",
      "msg": "Program is paused — emergency switch is active"
    },
    {
      "code": 6028,
      "name": "unsupportedAccountVersion",
      "msg": "Account version is not supported by this program build"
    }
  ],
  "types": [
    {
      "name": "gatewayRegistry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "keyCount",
            "type": "u8"
          },
          {
            "name": "keys",
            "type": {
              "array": [
                "pubkey",
                8
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "programConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "lpManager",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Emergency switch. When true, every state-changing room ix returns",
              "`RoomError::Paused`. Admin-only ix (set_treasury, set_lp_manager,",
              "set_paused, gateway registry updates) remain callable so the admin",
              "can recover, rotate keys, and unpause."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "room",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "roomId",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "entryClosesAt",
            "type": "i64"
          },
          {
            "name": "lpDeployAt",
            "type": "i64"
          },
          {
            "name": "closesAt",
            "type": "i64"
          },
          {
            "name": "capacityLamports",
            "type": "u64"
          },
          {
            "name": "depositedLamports",
            "type": "u64"
          },
          {
            "name": "humanCount",
            "type": "u16"
          },
          {
            "name": "maxHumans",
            "type": "u16"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "lpPosition",
            "type": "pubkey"
          },
          {
            "name": "lpManager",
            "type": "pubkey"
          },
          {
            "name": "lpDeployedLamports",
            "type": "u64"
          },
          {
            "name": "yieldLamports",
            "type": "u64"
          },
          {
            "name": "firstPlace",
            "type": "pubkey"
          },
          {
            "name": "secondPlace",
            "type": "pubkey"
          },
          {
            "name": "thirdPlace",
            "type": "pubkey"
          },
          {
            "name": "firstPlaceScore",
            "type": "u64"
          },
          {
            "name": "secondPlaceScore",
            "type": "u64"
          },
          {
            "name": "thirdPlaceScore",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for forward-compatible field additions. Zeroed at init.",
              "Adding a field: shrink _reserved by sizeof(field), bump ROOM_VERSION,",
              "and gate reads on version."
            ],
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "roomEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "room",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "depositLamports",
            "type": "u64"
          },
          {
            "name": "finalScore",
            "type": "u64"
          },
          {
            "name": "finalRank",
            "type": "u16"
          },
          {
            "name": "yieldAwardedLamports",
            "type": "u64"
          },
          {
            "name": "joinedAt",
            "type": "i64"
          },
          {
            "name": "returned",
            "type": "bool"
          },
          {
            "name": "returnedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for forward-compatible field additions. Per-user account, so",
              "padding is conservative."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    }
  ]
};
