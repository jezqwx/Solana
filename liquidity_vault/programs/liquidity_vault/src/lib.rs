use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked},
};

declare_id!("DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9");

#[program]
pub mod liquidity_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        require!(
            ctx.accounts.share_mint.freeze_authority.is_none(),
            VaultError::ShareMintFreezeAuthoritySet
        );

        ctx.accounts.vault.set_inner(VaultConfig {
            admin: ctx.accounts.admin.key(),
            asset_mint: ctx.accounts.asset_mint.key(),
            share_mint: ctx.accounts.share_mint.key(),
            token_vault: ctx.accounts.token_vault.key(),
            total_deposited: 0,
            bump: ctx.bumps.vault,
        });
        Ok(())
    }

    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        ctx.accounts.position.set_inner(UserPosition {
            owner: ctx.accounts.user.key(),
            vault: ctx.accounts.vault.key(),
            deposited_amount: 0,
            bump: ctx.bumps.position,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares_out: u64) -> Result<()> {
        // Price shares using the live balances BEFORE either CPI.
        let shares = calculate_shares(
            amount,
            min_shares_out,
            ctx.accounts.token_vault.amount,
            ctx.accounts.share_mint.supply,
        )?;
        require!(
            ctx.accounts.user_asset_account.amount >= amount,
            VaultError::InsufficientAssetBalance
        );

        // Validate every resulting u64 before moving tokens.
        let total_deposited = checked_add_amount(ctx.accounts.vault.total_deposited, amount)?;
        let deposited_amount = checked_add_amount(ctx.accounts.position.deposited_amount, amount)?;
        checked_add_amount(ctx.accounts.token_vault.amount, amount)?;
        checked_add_amount(ctx.accounts.share_mint.supply, shares)?;
        checked_add_amount(ctx.accounts.user_share_account.amount, shares)?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_asset_account.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.asset_mint.decimals,
        )?;

        let asset_mint_key = ctx.accounts.asset_mint.key();
        let bump = [ctx.accounts.vault.bump];
        let vault_seeds: &[&[u8]] = &[b"vault", asset_mint_key.as_ref(), &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            shares,
        )?;

        ctx.accounts.vault.total_deposited = total_deposited;
        ctx.accounts.position.deposited_amount = deposited_amount;
        Ok(())
    }
}

fn calculate_shares(amount: u64, min_shares_out: u64, assets: u64, supply: u64) -> Result<u64> {
    require!(amount > 0, VaultError::ZeroDeposit);
    let shares = match (assets, supply) {
        (0, 0) => amount,
        (0, _) | (_, 0) => return err!(VaultError::InvalidVaultState),
        _ => {
            let value = u128::from(amount)
                .checked_mul(u128::from(supply))
                .and_then(|product| product.checked_div(u128::from(assets)))
                .ok_or(VaultError::ArithmeticOverflow)?;
            u64::try_from(value).map_err(|_| error!(VaultError::ArithmeticOverflow))?
        }
    };
    require!(shares > 0, VaultError::ZeroShares);
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);
    Ok(shares)
}

fn checked_add_amount(balance: u64, amount: u64) -> Result<u64> {
    balance
        .checked_add(amount)
        .ok_or_else(|| error!(VaultError::ArithmeticOverflow))
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        constraint = asset_mint.key() != share_mint.key() @ VaultError::IdenticalMints
    )]
    pub asset_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [b"vault", asset_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultConfig>,
    #[account(
        init,
        payer = admin,
        seeds = [b"share-mint", vault.key().as_ref()],
        bump,
        mint::decimals = asset_mint.decimals,
        mint::authority = vault,
        mint::token_program = token_program
    )]
    // Omitting mint::freeze_authority initializes it to None in Anchor 0.31.1.
    pub share_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub token_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"vault", vault.asset_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, VaultConfig>,
    #[account(
        init,
        payer = user,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", asset_mint.key().as_ref()],
        bump = vault.bump,
        has_one = asset_mint @ VaultError::InvalidAssetMint,
        has_one = share_mint @ VaultError::InvalidShareMint,
        has_one = token_vault @ VaultError::InvalidTokenVault
    )]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ VaultError::InvalidPositionOwner,
        has_one = vault @ VaultError::InvalidPositionVault
    )]
    pub position: Box<Account<'info, UserPosition>>,
    pub asset_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [b"share-mint", vault.key().as_ref()],
        bump,
        mint::authority = vault,
        mint::decimals = asset_mint.decimals,
        mint::token_program = token_program,
        constraint = share_mint.freeze_authority.is_none() @ VaultError::ShareMintFreezeAuthoritySet
    )]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = asset_mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_asset_account: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user,
        token::token_program = token_program
    )]
    pub user_share_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub asset_mint: Pubkey,
    pub share_mint: Pubkey,
    pub token_vault: Pubkey,
    pub total_deposited: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub deposited_amount: u64,
    pub bump: u8,
}

#[error_code]
pub enum VaultError {
    #[msg("Asset mint and share mint must be different accounts.")]
    IdenticalMints,
    #[msg("Share mint must not have a freeze authority.")]
    ShareMintFreezeAuthoritySet,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDeposit,
    #[msg("Deposit would mint zero shares; increase the amount.")]
    ZeroShares,
    #[msg("Calculated shares are below min_shares_out.")]
    SlippageExceeded,
    #[msg("Vault assets and share supply must both be zero or both be nonzero.")]
    InvalidVaultState,
    #[msg("Deposit arithmetic exceeds the supported integer range.")]
    ArithmeticOverflow,
    #[msg("User asset account has insufficient tokens for this deposit.")]
    InsufficientAssetBalance,
    #[msg("Asset mint does not match the vault configuration.")]
    InvalidAssetMint,
    #[msg("Share mint does not match the vault configuration.")]
    InvalidShareMint,
    #[msg("Token vault does not match the vault configuration.")]
    InvalidTokenVault,
    #[msg("Position owner must be the signing user.")]
    InvalidPositionOwner,
    #[msg("Position belongs to a different vault.")]
    InvalidPositionVault,
}

#[cfg(test)]
mod deposit_math_tests {
    use super::*;

    fn assert_error(result: Result<u64>, expected: &str) {
        match result.unwrap_err() {
            anchor_lang::error::Error::AnchorError(error) => {
                assert_eq!(error.error_name, expected);
            }
            error => panic!("Unexpected error: {error}"),
        }
    }

    #[test]
    fn first_deposit_and_proportional_rounding() {
        assert_eq!(calculate_shares(100, 100, 0, 0).unwrap(), 100);
        assert_eq!(calculate_shares(51, 25, 200, 100).unwrap(), 25);
        assert_eq!(calculate_shares(50, 25, 200, 100).unwrap(), 25);
    }

    #[test]
    fn rejects_zero_slippage_and_inconsistent_state() {
        assert_error(calculate_shares(0, 0, 0, 0), "ZeroDeposit");
        assert_error(calculate_shares(1, 0, 200, 100), "ZeroShares");
        assert_error(calculate_shares(100, 101, 0, 0), "SlippageExceeded");
        assert_error(calculate_shares(51, 26, 200, 100), "SlippageExceeded");
        assert_error(calculate_shares(1, 0, 1, 0), "InvalidVaultState");
        assert_error(calculate_shares(1, 0, 0, 1), "InvalidVaultState");
    }

    #[test]
    fn handles_u128_product_and_u64_boundaries() {
        assert_eq!(
            calculate_shares(u64::MAX, u64::MAX, u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
        assert_error(
            calculate_shares(u64::MAX, 0, 1, u64::MAX),
            "ArithmeticOverflow",
        );
        assert_eq!(checked_add_amount(u64::MAX - 1, 1).unwrap(), u64::MAX);
        assert_error(checked_add_amount(u64::MAX, 1), "ArithmeticOverflow");
    }
}
