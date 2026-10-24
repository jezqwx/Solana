use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
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
}
