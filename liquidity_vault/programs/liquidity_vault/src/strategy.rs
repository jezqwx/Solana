use crate::{VaultConfig, VaultError};
use anchor_lang::{prelude::*, Discriminator};
use anchor_spl::{
    associated_token::AssociatedToken,
    memo::Memo,
    token::{self, spl_token::instruction::AuthorityType, Mint, SetAuthority, Token, TokenAccount},
    token_2022::Token2022,
};
use raydium_clmm_cpi::{
    program::RaydiumClmm,
    states::{AmmConfig, ObservationState, PoolState, TickArrayBitmapExtension, TickArrayState},
};

// The educational adapter is deliberately limited to our existing Devnet pool.
pub const WEEK11_POOL: Pubkey = pubkey!("gftP6PpRANU2cNY1aRXCGXv2gYjGgLYQLWuw41rbDrf");

#[account]
#[derive(InitSpace)]
pub struct StrategyConfig {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub quote_mint: Pubkey,
    pub quote_vault: Pubkey,
    pub active: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializeStrategy<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"vault", asset_mint.key().as_ref()], bump = vault.bump,
        has_one = admin @ VaultError::UnauthorizedAdmin, has_one = asset_mint,
        has_one = share_mint, has_one = token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    pub asset_mint: Box<Account<'info, Mint>>,
    #[account(seeds = [b"share-mint", vault.key().as_ref()], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(associated_token::mint = asset_mint, associated_token::authority = vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(address = WEEK11_POOL @ VaultError::InvalidStrategyAccount)]
    pub pool: AccountLoader<'info, PoolState>,
    #[account(init_if_needed, payer = admin, space = 8 + StrategyConfig::INIT_SPACE,
        seeds = [b"strategy", vault.key().as_ref()], bump)]
    pub strategy: Box<Account<'info, StrategyConfig>>,
    #[account(init_if_needed, payer = admin, associated_token::mint = quote_mint,
        associated_token::authority = vault, associated_token::token_program = token_program)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    pub raydium_program: Program<'info, RaydiumClmm>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<InitializeStrategy>) -> Result<()> {
    let p = ctx.accounts.pool.load()?;
    require_keys_eq!(
        p.token_mint_0,
        ctx.accounts.asset_mint.key(),
        VaultError::InvalidStrategyAccount
    );
    require_keys_eq!(
        p.token_mint_1,
        ctx.accounts.quote_mint.key(),
        VaultError::InvalidStrategyAccount
    );
    let s = &mut ctx.accounts.strategy;
    if s.vault == Pubkey::default() {
        require!(
            ctx.accounts.share_mint.mint_authority == Some(ctx.accounts.vault.key()).into(),
            VaultError::InvalidStrategyLock
        );
        s.set_inner(StrategyConfig {
            vault: ctx.accounts.vault.key(),
            pool: ctx.accounts.pool.key(),
            quote_mint: ctx.accounts.quote_mint.key(),
            quote_vault: ctx.accounts.quote_vault.key(),
            active: false,
            bump: ctx.bumps.strategy,
        });
    } else {
        // Idempotent initialization never resets an active lock or existing binding.
        require_keys_eq!(
            s.vault,
            ctx.accounts.vault.key(),
            VaultError::InvalidStrategyAccount
        );
        require_keys_eq!(
            s.pool,
            ctx.accounts.pool.key(),
            VaultError::InvalidStrategyAccount
        );
        require_keys_eq!(
            s.quote_mint,
            ctx.accounts.quote_mint.key(),
            VaultError::InvalidStrategyAccount
        );
        require_keys_eq!(
            s.quote_vault,
            ctx.accounts.quote_vault.key(),
            VaultError::InvalidStrategyAccount
        );
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"vault", asset_mint.key().as_ref()], bump = vault.bump,
        has_one = admin @ VaultError::UnauthorizedAdmin, has_one = asset_mint, has_one = share_mint, has_one = token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [b"strategy", vault.key().as_ref()], bump = strategy.bump,
        has_one = vault, has_one = pool, has_one = quote_mint, has_one = quote_vault)]
    pub strategy: Box<Account<'info, StrategyConfig>>,
    pub asset_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"share-mint", vault.key().as_ref()], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = asset_mint, associated_token::authority = vault, associated_token::token_program = token_program)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = vault, associated_token::token_program = token_program)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = WEEK11_POOL @ VaultError::InvalidStrategyAccount)]
    pub pool: AccountLoader<'info, PoolState>,
    #[account(address = pool.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,
    #[account(mut, address = pool.load()?.token_vault_0, token::mint = asset_mint, token::authority = pool)]
    pub pool_vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = pool.load()?.token_vault_1, token::mint = quote_mint, token::authority = pool)]
    pub pool_vault_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: Current observation layout is checked in validate_remaining. Do not deserialize the adapter's outdated layout.
    #[account(mut, address = pool.load()?.observation_key, owner = raydium_clmm_cpi::ID)]
    pub observation: UncheckedAccount<'info>,
    pub raydium_program: Program<'info, RaydiumClmm>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
}

fn validate_remaining(ctx: &Context<Swap>) -> Result<()> {
    let pool = ctx.accounts.pool.key();
    let data = ctx.accounts.observation.try_borrow_data()?;
    // Current Raydium: discriminator, initialized:u8, epoch:u64, index:u16, pool:Pubkey.
    require!(
        data.len() == 4483
            && data[..8] == *ObservationState::DISCRIMINATOR
            && data[19..51] == pool.to_bytes(),
        VaultError::InvalidRaydiumAccount
    );
    drop(data);
    require!(
        !ctx.remaining_accounts.is_empty() && ctx.remaining_accounts.len() <= 10,
        VaultError::InvalidRaydiumAccount
    );
    let spacing = i32::from(ctx.accounts.pool.load()?.tick_spacing);
    let width = spacing
        .checked_mul(60)
        .ok_or(VaultError::ArithmeticOverflow)?;
    require!(width > 0, VaultError::InvalidRaydiumAccount);
    let mut ticks = 0;
    for (i, account) in ctx.remaining_accounts.iter().enumerate() {
        require_keys_eq!(
            *account.owner,
            raydium_clmm_cpi::ID,
            VaultError::InvalidRaydiumAccount
        );
        require!(
            account.is_writable && !account.is_signer,
            VaultError::InvalidRaydiumAccount
        );
        require!(
            !ctx.remaining_accounts[..i]
                .iter()
                .any(|a| a.key == account.key),
            VaultError::InvalidRaydiumAccount
        );
        let d = account.try_borrow_data()?;
        require!(
            d.len() >= 44 && d[8..40] == pool.to_bytes(),
            VaultError::InvalidRaydiumAccount
        );
        let derived = if d[..8] == *TickArrayState::DISCRIMINATOR {
            require!(d.len() == 10240, VaultError::InvalidRaydiumAccount);
            let start = i32::from_le_bytes(
                d[40..44]
                    .try_into()
                    .map_err(|_| VaultError::InvalidRaydiumAccount)?,
            );
            require!(start % width == 0, VaultError::InvalidRaydiumAccount);
            ticks += 1;
            Pubkey::find_program_address(
                &[b"tick_array", pool.as_ref(), &start.to_be_bytes()],
                &raydium_clmm_cpi::ID,
            )
            .0
        } else {
            require!(
                d.len() == 1832 && d[..8] == *TickArrayBitmapExtension::DISCRIMINATOR,
                VaultError::InvalidRaydiumAccount
            );
            Pubkey::find_program_address(
                &[b"pool_tick_array_bitmap_extension", pool.as_ref()],
                &raydium_clmm_cpi::ID,
            )
            .0
        };
        require_keys_eq!(derived, account.key(), VaultError::InvalidRaydiumAccount);
    }
    require!(ticks > 0, VaultError::InvalidRaydiumAccount);
    Ok(())
}

pub fn execute_swap<'info>(
    ctx: Context<'_, '_, '_, 'info, Swap<'info>>,
    amount: u64,
    minimum: u64,
    a_to_b: bool,
) -> Result<()> {
    require!(amount > 0 && minimum > 0, VaultError::InvalidSwapAmount);
    {
        let p = ctx.accounts.pool.load()?;
        require_keys_eq!(
            p.token_mint_0,
            ctx.accounts.asset_mint.key(),
            VaultError::InvalidStrategyAccount
        );
        require_keys_eq!(
            p.token_mint_1,
            ctx.accounts.quote_mint.key(),
            VaultError::InvalidStrategyAccount
        );
    }
    validate_remaining(&ctx)?;
    let before_a = ctx.accounts.token_vault.amount;
    let before_b = ctx.accounts.quote_vault.amount;
    require!(
        (if a_to_b { before_a } else { before_b }) >= amount,
        VaultError::InsufficientAssetBalance
    );
    let mint_key = ctx.accounts.asset_mint.key();
    let bump = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &bump];
    let expected_authority = if ctx.accounts.strategy.active {
        ctx.accounts.strategy.key()
    } else {
        ctx.accounts.vault.key()
    };
    require!(
        ctx.accounts.share_mint.mint_authority == Some(expected_authority).into(),
        VaultError::InvalidStrategyLock
    );
    if !ctx.accounts.strategy.active {
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.vault.to_account_info(),
                    account_or_mint: ctx.accounts.share_mint.to_account_info(),
                },
                &[vault_seeds],
            ),
            AuthorityType::MintTokens,
            Some(ctx.accounts.strategy.key()),
        )?;
        ctx.accounts.strategy.active = true;
    }
    let (source, destination, input_pool, output_pool, input_mint, output_mint) = if a_to_b {
        (
            &ctx.accounts.token_vault,
            &ctx.accounts.quote_vault,
            &ctx.accounts.pool_vault_a,
            &ctx.accounts.pool_vault_b,
            &ctx.accounts.asset_mint,
            &ctx.accounts.quote_mint,
        )
    } else {
        (
            &ctx.accounts.quote_vault,
            &ctx.accounts.token_vault,
            &ctx.accounts.pool_vault_b,
            &ctx.accounts.pool_vault_a,
            &ctx.accounts.quote_mint,
            &ctx.accounts.asset_mint,
        )
    };
    raydium_clmm_cpi::cpi::swap_v2(
        CpiContext::new_with_signer(
            ctx.accounts.raydium_program.to_account_info(),
            raydium_clmm_cpi::cpi::accounts::SwapSingleV2 {
                payer: ctx.accounts.vault.to_account_info(),
                amm_config: ctx.accounts.amm_config.to_account_info(),
                pool_state: ctx.accounts.pool.to_account_info(),
                input_token_account: source.to_account_info(),
                output_token_account: destination.to_account_info(),
                input_vault: input_pool.to_account_info(),
                output_vault: output_pool.to_account_info(),
                observation_state: ctx.accounts.observation.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
                memo_program: ctx.accounts.memo_program.to_account_info(),
                input_vault_mint: input_mint.to_account_info(),
                output_vault_mint: output_mint.to_account_info(),
            },
            &[vault_seeds],
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        amount,
        minimum,
        0,
        true,
    )?;
    ctx.accounts.token_vault.reload()?;
    ctx.accounts.quote_vault.reload()?;
    let (spent, received) = if a_to_b {
        (
            before_a.checked_sub(ctx.accounts.token_vault.amount),
            ctx.accounts.quote_vault.amount.checked_sub(before_b),
        )
    } else {
        (
            before_b.checked_sub(ctx.accounts.quote_vault.amount),
            ctx.accounts.token_vault.amount.checked_sub(before_a),
        )
    };
    require!(
        spent == Some(amount) && received.is_some_and(|n| n >= minimum),
        VaultError::InvalidSwapResult
    );
    emit!(VaultSwap {
        vault: ctx.accounts.vault.key(),
        amount_in: amount,
        amount_out: received.ok_or(VaultError::ArithmeticOverflow)?,
        a_to_b
    });
    Ok(())
}

#[event]
pub struct VaultSwap {
    pub vault: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub a_to_b: bool,
}

#[derive(Accounts)]
pub struct EndStrategy<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"vault", asset_mint.key().as_ref()], bump = vault.bump,
        has_one = admin @ VaultError::UnauthorizedAdmin, has_one = asset_mint, has_one = share_mint, has_one = token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    pub asset_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"strategy", vault.key().as_ref()], bump = strategy.bump, has_one = vault, has_one = quote_mint, has_one = quote_vault)]
    pub strategy: Box<Account<'info, StrategyConfig>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"share-mint", vault.key().as_ref()], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(associated_token::mint = asset_mint, associated_token::authority = vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(associated_token::mint = quote_mint, associated_token::authority = vault)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn can_settle(quote: u64, assets: u64, supply: u64) -> bool {
    quote == 0 && ((assets == 0 && supply == 0) || (assets > 0 && supply > 0))
}

pub fn end(ctx: Context<EndStrategy>) -> Result<()> {
    require!(
        ctx.accounts.quote_vault.amount == 0,
        VaultError::StrategyNotSettled
    );
    require!(
        can_settle(
            0,
            ctx.accounts.token_vault.amount,
            ctx.accounts.share_mint.supply
        ),
        VaultError::InvalidVaultState
    );
    if !ctx.accounts.strategy.active {
        require!(
            ctx.accounts.share_mint.mint_authority == Some(ctx.accounts.vault.key()).into(),
            VaultError::InvalidStrategyLock
        );
        return Ok(());
    }
    require!(
        ctx.accounts.share_mint.mint_authority == Some(ctx.accounts.strategy.key()).into(),
        VaultError::InvalidStrategyLock
    );
    let vault = ctx.accounts.vault.key();
    let bump = [ctx.accounts.strategy.bump];
    let seeds: &[&[u8]] = &[b"strategy", vault.as_ref(), &bump];
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.strategy.to_account_info(),
                account_or_mint: ctx.accounts.share_mint.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        Some(vault),
    )?;
    ctx.accounts.strategy.active = false;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settlement_requires_real_zero_quote_and_consistent_supply() {
        assert!(!can_settle(1, 100, 100));
        assert!(!can_settle(0, 0, 100));
        assert!(!can_settle(0, 100, 0));
        assert!(can_settle(0, 99, 100));
        assert!(can_settle(0, 0, 0));
    }
    #[test]
    fn account_sizes_are_compatible() {
        assert_eq!(8 + crate::VaultConfig::INIT_SPACE, 145);
        assert_eq!(8 + crate::UserPosition::INIT_SPACE, 81);
        assert_eq!(8 + StrategyConfig::INIT_SPACE, 138);
    }
}
