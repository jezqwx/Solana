use crate::{strategy::WEEK11_POOL, StrategyConfig, VaultConfig, VaultError};
use anchor_lang::{prelude::*, Discriminator};
use anchor_spl::{
    associated_token::AssociatedToken,
    memo::Memo,
    metadata::Metadata,
    token::{self, spl_token::instruction::AuthorityType, Mint, SetAuthority, Token, TokenAccount},
    token_2022::Token2022,
};
use raydium_clmm_cpi::{
    program::RaydiumClmm,
    states::{PersonalPositionState, PoolState, TickArrayBitmapExtension, TickArrayState},
};

pub fn valid_ticks(lower: i32, upper: i32, spacing: u16) -> bool {
    let s = i32::from(spacing);
    s > 0
        && lower >= -443636
        && upper <= 443636
        && lower < upper
        && lower % s == 0
        && upper % s == 0
}
// Keep these checks outside Anchor's generated try_accounts frame (SBF stack is 4 KiB).
#[inline(never)]
fn check_tokens<'info>(
    vault: Pubkey,
    pool: Pubkey,
    a: Pubkey,
    b: Pubkey,
    va: &Account<'info, TokenAccount>,
    vb: &Account<'info, TokenAccount>,
    pa: &Account<'info, TokenAccount>,
    pb: &Account<'info, TokenAccount>,
) -> Result<()> {
    for (mint, account, pool_account) in [(a, va, pa), (b, vb, pb)] {
        require!(
            account.mint == mint
                && account.owner == vault
                && account.key()
                    == anchor_spl::associated_token::get_associated_token_address(&vault, &mint),
            VaultError::InvalidClmmPosition
        );
        require!(
            pool_account.mint == mint && pool_account.owner == pool,
            VaultError::InvalidClmmPosition
        );
    }
    Ok(())
}
fn array_start(tick: i32, spacing: u16) -> Result<i32> {
    let width = i32::from(spacing)
        .checked_mul(60)
        .ok_or(VaultError::ArithmeticOverflow)?;
    require!(width > 0, VaultError::InvalidClmmTicks);
    tick.div_euclid(width)
        .checked_mul(width)
        .ok_or_else(|| error!(VaultError::ArithmeticOverflow))
}
fn check_arrays<'info>(
    pool: Pubkey,
    spacing: u16,
    lower: i32,
    upper: i32,
    a: &AccountInfo<'info>,
    b: &AccountInfo<'info>,
    bitmap: &AccountInfo<'info>,
    protocol: Pubkey,
) -> Result<()> {
    require!(
        valid_ticks(lower, upper, spacing),
        VaultError::InvalidClmmTicks
    );
    for (tick, info) in [(lower, a), (upper, b)] {
        let start = array_start(tick, spacing)?;
        let expected = Pubkey::find_program_address(
            &[b"tick_array", pool.as_ref(), &start.to_be_bytes()],
            &raydium_clmm_cpi::ID,
        )
        .0;
        require_keys_eq!(expected, info.key(), VaultError::InvalidRaydiumAccount);
        let d = info.try_borrow_data()?;
        require!(
            d.len() == 10240
                && d[..8] == *TickArrayState::DISCRIMINATOR
                && d[8..40] == pool.to_bytes()
                && d[40..44] == start.to_le_bytes(),
            VaultError::InvalidRaydiumAccount
        );
    }
    let expected = Pubkey::find_program_address(
        &[b"pool_tick_array_bitmap_extension", pool.as_ref()],
        &raydium_clmm_cpi::ID,
    )
    .0;
    require_keys_eq!(expected, bitmap.key(), VaultError::InvalidRaydiumAccount);
    let d = bitmap.try_borrow_data()?;
    require!(
        d.len() == 1832
            && d[..8] == *TickArrayBitmapExtension::DISCRIMINATOR
            && d[8..40] == pool.to_bytes(),
        VaultError::InvalidRaydiumAccount
    );
    let expected = Pubkey::find_program_address(
        &[
            b"position",
            pool.as_ref(),
            &lower.to_be_bytes(),
            &upper.to_be_bytes(),
        ],
        &raydium_clmm_cpi::ID,
    )
    .0;
    require_keys_eq!(expected, protocol, VaultError::InvalidClmmPosition);
    Ok(())
}
fn read_position(info: &AccountInfo) -> Result<PersonalPositionState> {
    require_keys_eq!(
        *info.owner,
        raydium_clmm_cpi::ID,
        VaultError::InvalidClmmPosition
    );
    let data = info.try_borrow_data()?;
    require!(
        data.len() == PersonalPositionState::LEN,
        VaultError::InvalidClmmPosition
    );
    PersonalPositionState::try_deserialize(&mut &data[..])
}
fn check_pool(p: &PoolState, a: Pubkey, b: Pubkey) -> Result<()> {
    require_keys_eq!(p.token_mint_0, a, VaultError::InvalidClmmPosition);
    require_keys_eq!(p.token_mint_1, b, VaultError::InvalidClmmPosition);
    // Reward campaigns need additional validated recipients; not supported in this lesson.
    require!(
        p.reward_infos
            .iter()
            .all(|r| r.token_mint == Pubkey::default()),
        VaultError::UnsupportedClmmRewards
    );
    Ok(())
}
pub fn open(ctx: Context<OpenClmmPosition>, lower: i32, upper: i32) -> Result<()> {
    check_tokens(
        ctx.accounts.vault.key(),
        ctx.accounts.pool.key(),
        ctx.accounts.asset_mint.key(),
        ctx.accounts.quote_mint.key(),
        &ctx.accounts.token_vault,
        &ctx.accounts.quote_vault,
        &ctx.accounts.pool_vault_a,
        &ctx.accounts.pool_vault_b,
    )?;
    require!(
        ctx.remaining_accounts.is_empty(),
        VaultError::InvalidRaydiumAccount
    );
    require!(
        !ctx.accounts.clmm_position.open,
        VaultError::ClmmPositionAlreadyOpen
    );
    require!(
        ctx.accounts.share_mint.supply > 0,
        VaultError::InvalidVaultState
    );
    let pool = ctx.accounts.pool.load()?;
    check_pool(
        &pool,
        ctx.accounts.asset_mint.key(),
        ctx.accounts.quote_mint.key(),
    )?;
    require!(
        valid_ticks(lower, upper, pool.tick_spacing)
            && lower < pool.tick_current
            && pool.tick_current < upper,
        VaultError::InvalidClmmTicks
    );
    check_arrays(
        ctx.accounts.pool.key(),
        pool.tick_spacing,
        lower,
        upper,
        &ctx.accounts.tick_lower,
        &ctx.accounts.tick_upper,
        &ctx.accounts.bitmap,
        ctx.accounts.protocol_position.key(),
    )?;
    let lower_start = array_start(lower, pool.tick_spacing)?;
    let upper_start = array_start(upper, pool.tick_spacing)?;
    drop(pool);
    let nft = ctx.accounts.nft_mint.key();
    let personal =
        Pubkey::find_program_address(&[b"position", nft.as_ref()], &raydium_clmm_cpi::ID).0;
    require_keys_eq!(
        personal,
        ctx.accounts.personal_position.key(),
        VaultError::InvalidClmmPosition
    );
    let ata =
        anchor_spl::associated_token::get_associated_token_address(&ctx.accounts.vault.key(), &nft);
    require_keys_eq!(
        ata,
        ctx.accounts.nft_account.key(),
        VaultError::InvalidClmmPosition
    );
    let metadata = Pubkey::find_program_address(
        &[b"metadata", anchor_spl::metadata::ID.as_ref(), nft.as_ref()],
        &anchor_spl::metadata::ID,
    )
    .0;
    require_keys_eq!(
        metadata,
        ctx.accounts.metadata.key(),
        VaultError::InvalidClmmPosition
    );
    let previous = if ctx.accounts.strategy.active {
        ctx.accounts.strategy.key()
    } else {
        ctx.accounts.vault.key()
    };
    require!(
        ctx.accounts.share_mint.mint_authority == Some(previous).into(),
        VaultError::InvalidStrategyLock
    );
    let asset = ctx.accounts.asset_mint.key();
    let vb = [ctx.accounts.vault.bump];
    let vault = ctx.accounts.vault.key();
    let sb = [ctx.accounts.strategy.bump];
    let vs: &[&[u8]] = &[b"vault", asset.as_ref(), &vb];
    let ss: &[&[u8]] = &[b"strategy", vault.as_ref(), &sb];
    let authority = if ctx.accounts.strategy.active {
        ctx.accounts.strategy.to_account_info()
    } else {
        ctx.accounts.vault.to_account_info()
    };
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: authority,
                account_or_mint: ctx.accounts.share_mint.to_account_info(),
            },
            &[if ctx.accounts.strategy.active { ss } else { vs }],
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.clmm_position.key()),
    )?;
    ctx.accounts.strategy.active = true;
    raydium_clmm_cpi::cpi::open_position_v2(
        CpiContext::new(
            ctx.accounts.raydium_program.to_account_info(),
            raydium_clmm_cpi::cpi::accounts::OpenPositionV2 {
                payer: ctx.accounts.admin.to_account_info(),
                position_nft_owner: ctx.accounts.vault.to_account_info(),
                position_nft_mint: ctx.accounts.nft_mint.to_account_info(),
                position_nft_account: ctx.accounts.nft_account.to_account_info(),
                metadata_account: ctx.accounts.metadata.to_account_info(),
                pool_state: ctx.accounts.pool.to_account_info(),
                protocol_position: ctx.accounts.protocol_position.to_account_info(),
                tick_array_lower: ctx.accounts.tick_lower.to_account_info(),
                tick_array_upper: ctx.accounts.tick_upper.to_account_info(),
                personal_position: ctx.accounts.personal_position.to_account_info(),
                token_account_0: ctx.accounts.token_vault.to_account_info(),
                token_account_1: ctx.accounts.quote_vault.to_account_info(),
                token_vault_0: ctx.accounts.pool_vault_a.to_account_info(),
                token_vault_1: ctx.accounts.pool_vault_b.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                metadata_program: ctx.accounts.metadata_program.to_account_info(),
                token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
                vault_0_mint: ctx.accounts.asset_mint.to_account_info(),
                vault_1_mint: ctx.accounts.quote_mint.to_account_info(),
            },
        ),
        lower,
        upper,
        lower_start,
        upper_start,
        0,
        0,
        0,
        false,
        None,
    )?;
    let p = read_position(&ctx.accounts.personal_position)?;
    require!(
        p.nft_mint == nft
            && p.pool_id == ctx.accounts.pool.key()
            && p.tick_lower_index == lower
            && p.tick_upper_index == upper
            && p.liquidity == 0,
        VaultError::InvalidClmmPosition
    );
    let d = ctx.accounts.nft_account.try_borrow_data()?;
    let n = TokenAccount::try_deserialize(&mut &d[..])?;
    require!(
        n.owner == vault && n.mint == nft && n.amount == 1,
        VaultError::InvalidClmmPosition
    );
    ctx.accounts.clmm_position.set_inner(ClmmPositionBinding {
        vault,
        pool: ctx.accounts.pool.key(),
        nft_mint: nft,
        personal_position: personal,
        tick_lower: lower,
        tick_upper: upper,
        open: true,
        bump: ctx.bumps.clmm_position,
    });
    Ok(())
}
fn validate(ctx: &Context<ManageClmmPosition>) -> Result<PersonalPositionState> {
    check_tokens(
        ctx.accounts.vault.key(),
        ctx.accounts.raydium.pool.key(),
        ctx.accounts.asset_mint.key(),
        ctx.accounts.quote_mint.key(),
        &ctx.accounts.token_vault,
        &ctx.accounts.quote_vault,
        &ctx.accounts.raydium.pool_vault_a,
        &ctx.accounts.raydium.pool_vault_b,
    )?;
    let n = &ctx.accounts.nft_account;
    require!(
        ctx.accounts.nft_mint.decimals == 0
            && ctx.accounts.nft_mint.supply == 1
            && n.amount == 1
            && n.owner == ctx.accounts.vault.key()
            && n.mint == ctx.accounts.nft_mint.key()
            && n.key()
                == anchor_spl::associated_token::get_associated_token_address(
                    &ctx.accounts.vault.key(),
                    &ctx.accounts.nft_mint.key()
                ),
        VaultError::InvalidClmmPosition
    );
    require!(
        ctx.remaining_accounts.is_empty(),
        VaultError::InvalidRaydiumAccount
    );
    require!(
        ctx.accounts.strategy.active
            && ctx.accounts.share_mint.mint_authority
                == Some(ctx.accounts.clmm_position.key()).into(),
        VaultError::InvalidStrategyLock
    );
    let b = &ctx.accounts.clmm_position;
    let pool = ctx.accounts.raydium.pool.load()?;
    check_pool(
        &pool,
        ctx.accounts.asset_mint.key(),
        ctx.accounts.quote_mint.key(),
    )?;
    check_arrays(
        ctx.accounts.raydium.pool.key(),
        pool.tick_spacing,
        b.tick_lower,
        b.tick_upper,
        &ctx.accounts.raydium.tick_lower,
        &ctx.accounts.raydium.tick_upper,
        &ctx.accounts.raydium.bitmap,
        ctx.accounts.raydium.protocol_position.key(),
    )?;
    let expected =
        Pubkey::find_program_address(&[b"position", b.nft_mint.as_ref()], &raydium_clmm_cpi::ID).0;
    require_keys_eq!(
        expected,
        ctx.accounts.personal_position.key(),
        VaultError::InvalidClmmPosition
    );
    let p = read_position(&ctx.accounts.personal_position)?;
    require!(
        p.nft_mint == b.nft_mint
            && p.pool_id == b.pool
            && p.tick_lower_index == b.tick_lower
            && p.tick_upper_index == b.tick_upper,
        VaultError::InvalidClmmPosition
    );
    Ok(p)
}
pub fn increase(
    ctx: Context<ManageClmmPosition>,
    liquidity: u128,
    max_a: u64,
    max_b: u64,
) -> Result<()> {
    let p = validate(&ctx)?;
    require!(
        liquidity > 0 && liquidity <= i128::MAX as u128 && max_a > 0 && max_b > 0,
        VaultError::InvalidClmmLiquidity
    );
    let expected = p
        .liquidity
        .checked_add(liquidity)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let before = (
        ctx.accounts.token_vault.amount,
        ctx.accounts.quote_vault.amount,
    );
    let asset = ctx.accounts.asset_mint.key();
    let bump = [ctx.accounts.vault.bump];
    let seeds: &[&[u8]] = &[b"vault", asset.as_ref(), &bump];
    raydium_clmm_cpi::cpi::increase_liquidity_v2(
        CpiContext::new_with_signer(
            ctx.accounts.raydium_program.to_account_info(),
            raydium_clmm_cpi::cpi::accounts::IncreaseLiquidityV2 {
                nft_owner: ctx.accounts.vault.to_account_info(),
                nft_account: ctx.accounts.nft_account.to_account_info(),
                pool_state: ctx.accounts.raydium.pool.to_account_info(),
                protocol_position: ctx.accounts.raydium.protocol_position.to_account_info(),
                personal_position: ctx.accounts.personal_position.to_account_info(),
                tick_array_lower: ctx.accounts.raydium.tick_lower.to_account_info(),
                tick_array_upper: ctx.accounts.raydium.tick_upper.to_account_info(),
                token_account_0: ctx.accounts.token_vault.to_account_info(),
                token_account_1: ctx.accounts.quote_vault.to_account_info(),
                token_vault_0: ctx.accounts.raydium.pool_vault_a.to_account_info(),
                token_vault_1: ctx.accounts.raydium.pool_vault_b.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
                vault_0_mint: ctx.accounts.asset_mint.to_account_info(),
                vault_1_mint: ctx.accounts.quote_mint.to_account_info(),
            },
            &[seeds],
        )
        .with_remaining_accounts(vec![ctx.accounts.raydium.bitmap.to_account_info()]),
        liquidity,
        max_a,
        max_b,
        None,
    )?;
    ctx.accounts.token_vault.reload()?;
    ctx.accounts.quote_vault.reload()?;
    let a = before
        .0
        .checked_sub(ctx.accounts.token_vault.amount)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let b = before
        .1
        .checked_sub(ctx.accounts.quote_vault.amount)
        .ok_or(VaultError::ArithmeticOverflow)?;
    require!(
        a > 0
            && b > 0
            && a <= max_a
            && b <= max_b
            && read_position(&ctx.accounts.personal_position)?.liquidity == expected,
        VaultError::InvalidClmmLiquidity
    );
    emit!(ClmmLiquidityChange {
        position: ctx.accounts.personal_position.key(),
        increase: true,
        liquidity,
        amount_a: a,
        amount_b: b
    });
    Ok(())
}
pub fn decrease(
    ctx: Context<ManageClmmPosition>,
    liquidity: u128,
    min_a: u64,
    min_b: u64,
    fees_only: bool,
) -> Result<()> {
    let p = validate(&ctx)?;
    require!(
        (fees_only && liquidity == 0)
            || (!fees_only
                && liquidity > 0
                && liquidity <= p.liquidity
                && liquidity <= i128::MAX as u128
                && (min_a > 0 || min_b > 0)),
        VaultError::InvalidClmmLiquidity
    );
    let expected = p
        .liquidity
        .checked_sub(liquidity)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let before = (
        ctx.accounts.token_vault.amount,
        ctx.accounts.quote_vault.amount,
    );
    let asset = ctx.accounts.asset_mint.key();
    let bump = [ctx.accounts.vault.bump];
    let seeds: &[&[u8]] = &[b"vault", asset.as_ref(), &bump];
    raydium_clmm_cpi::cpi::decrease_liquidity_v2(
        CpiContext::new_with_signer(
            ctx.accounts.raydium_program.to_account_info(),
            raydium_clmm_cpi::cpi::accounts::DecreaseLiquidityV2 {
                nft_owner: ctx.accounts.vault.to_account_info(),
                nft_account: ctx.accounts.nft_account.to_account_info(),
                personal_position: ctx.accounts.personal_position.to_account_info(),
                pool_state: ctx.accounts.raydium.pool.to_account_info(),
                protocol_position: ctx.accounts.raydium.protocol_position.to_account_info(),
                token_vault_0: ctx.accounts.raydium.pool_vault_a.to_account_info(),
                token_vault_1: ctx.accounts.raydium.pool_vault_b.to_account_info(),
                tick_array_lower: ctx.accounts.raydium.tick_lower.to_account_info(),
                tick_array_upper: ctx.accounts.raydium.tick_upper.to_account_info(),
                recipient_token_account_0: ctx.accounts.token_vault.to_account_info(),
                recipient_token_account_1: ctx.accounts.quote_vault.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
                memo_program: ctx.accounts.memo_program.to_account_info(),
                vault_0_mint: ctx.accounts.asset_mint.to_account_info(),
                vault_1_mint: ctx.accounts.quote_mint.to_account_info(),
            },
            &[seeds],
        )
        .with_remaining_accounts(vec![ctx.accounts.raydium.bitmap.to_account_info()]),
        liquidity,
        if fees_only { 0 } else { min_a },
        if fees_only { 0 } else { min_b },
    )?;
    ctx.accounts.token_vault.reload()?;
    ctx.accounts.quote_vault.reload()?;
    let a = ctx
        .accounts
        .token_vault
        .amount
        .checked_sub(before.0)
        .ok_or(VaultError::ArithmeticOverflow)?;
    let b = ctx
        .accounts
        .quote_vault
        .amount
        .checked_sub(before.1)
        .ok_or(VaultError::ArithmeticOverflow)?;
    require!(
        a >= min_a
            && b >= min_b
            && read_position(&ctx.accounts.personal_position)?.liquidity == expected,
        VaultError::InvalidClmmLiquidity
    );
    emit!(ClmmLiquidityChange {
        position: ctx.accounts.personal_position.key(),
        increase: false,
        liquidity,
        amount_a: a,
        amount_b: b
    });
    Ok(())
}
pub fn close(ctx: Context<ManageClmmPosition>) -> Result<()> {
    let p = validate(&ctx)?;
    require!(
        p.liquidity == 0
            && p.token_fees_owed_0 == 0
            && p.token_fees_owed_1 == 0
            && p.reward_infos.iter().all(|r| r.reward_amount_owed == 0),
        VaultError::ClmmPositionNotEmpty
    );
    let asset = ctx.accounts.asset_mint.key();
    let vb = [ctx.accounts.vault.bump];
    let vs: &[&[u8]] = &[b"vault", asset.as_ref(), &vb];
    raydium_clmm_cpi::cpi::close_position(
        CpiContext::new_with_signer(
            ctx.accounts.raydium_program.to_account_info(),
            raydium_clmm_cpi::cpi::accounts::ClosePosition {
                nft_owner: ctx.accounts.vault.to_account_info(),
                position_nft_mint: ctx.accounts.nft_mint.to_account_info(),
                position_nft_account: ctx.accounts.nft_account.to_account_info(),
                personal_position: ctx.accounts.personal_position.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[vs],
        )
        .with_remaining_accounts(vec![ctx.accounts.raydium.pool.to_account_info()]),
    )?;
    require!(
        ctx.accounts.personal_position.lamports() == 0
            && ctx.accounts.nft_account.to_account_info().lamports() == 0,
        VaultError::ClmmPositionNotEmpty
    );
    ctx.accounts.nft_mint.reload()?;
    require!(
        ctx.accounts.nft_mint.supply == 0,
        VaultError::InvalidClmmPosition
    );
    let vault = ctx.accounts.vault.key();
    let bump = [ctx.accounts.clmm_position.bump];
    let seeds: &[&[u8]] = &[b"clmm-position", vault.as_ref(), &bump];
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.clmm_position.to_account_info(),
                account_or_mint: ctx.accounts.share_mint.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.strategy.key()),
    )?;
    ctx.accounts.clmm_position.open = false;
    Ok(())
}
#[event]
pub struct ClmmLiquidityChange {
    pub position: Pubkey,
    pub increase: bool,
    pub liquidity: u128,
    pub amount_a: u64,
    pub amount_b: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tick_bounds_and_alignment() {
        assert!(valid_ticks(-600, 600, 60));
        for (a, b, s) in [
            (-601, 600, 60),
            (600, 600, 60),
            (660, 600, 60),
            (-443640, 0, 60),
            (0, 443640, 60),
            (-600, 600, 0),
        ] {
            assert!(!valid_ticks(a, b, s));
        }
    }
    #[test]
    fn negative_tick_array_floor() {
        assert_eq!(array_start(-1, 60).unwrap(), -3600);
        assert_eq!(array_start(0, 60).unwrap(), 0);
        assert_eq!(array_start(-3600, 60).unwrap(), -3600);
    }
    #[test]
    fn preserves_account_sizes() {
        assert_eq!(8 + ClmmPositionBinding::INIT_SPACE, 146);
        assert_eq!(8 + StrategyConfig::INIT_SPACE, 138);
        assert_eq!(8 + VaultConfig::INIT_SPACE, 145);
        assert_eq!(8 + crate::UserPosition::INIT_SPACE, 81);
    }
}

#[account]
#[derive(InitSpace)]
pub struct ClmmPositionBinding {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub personal_position: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub open: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct OpenClmmPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"vault", asset_mint.key().as_ref()], bump=vault.bump,
        has_one=admin @ VaultError::UnauthorizedAdmin, has_one=asset_mint, has_one=share_mint, has_one=token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds=[b"strategy", vault.key().as_ref()], bump=strategy.bump,
        has_one=vault, has_one=pool, has_one=quote_mint, has_one=quote_vault)]
    pub strategy: Box<Account<'info, StrategyConfig>>,
    pub asset_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds=[b"share-mint", vault.key().as_ref()], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address=WEEK11_POOL)]
    pub pool: AccountLoader<'info, PoolState>,
    #[account(mut, address=pool.load()?.token_vault_0)]
    pub pool_vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, address=pool.load()?.token_vault_1)]
    pub pool_vault_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: Validated by owner, discriminator, pool, length and canonical tick-array PDA.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub tick_lower: UncheckedAccount<'info>,
    /// CHECK: Same validation as lower array; existing arrays only.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub tick_upper: UncheckedAccount<'info>,
    /// CHECK: Validated canonical bitmap, owner, discriminator, length and pool.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub bitmap: UncheckedAccount<'info>,
    /// CHECK: Deprecated Raydium account, checked canonical PDA for the bound ticks.
    pub protocol_position: UncheckedAccount<'info>,
    pub raydium_program: Program<'info, RaydiumClmm>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,

    #[account(init_if_needed, payer=admin, space=8+ClmmPositionBinding::INIT_SPACE,
        seeds=[b"clmm-position", vault.key().as_ref()], bump)]
    pub clmm_position: Box<Account<'info, ClmmPositionBinding>>,
    #[account(mut)]
    pub nft_mint: Signer<'info>,
    /// CHECK: Canonical Vault NFT ATA, initialized and checked by Raydium CPI.
    #[account(mut)]
    pub nft_account: UncheckedAccount<'info>,
    /// CHECK: Canonical Raydium personal-position PDA; checked again after CPI.
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: Canonical Metaplex PDA; metadata creation is disabled.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub metadata_program: Program<'info, Metadata>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ManageClmmPosition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds=[b"vault", asset_mint.key().as_ref()], bump=vault.bump,
        has_one=admin @ VaultError::UnauthorizedAdmin, has_one=asset_mint, has_one=share_mint, has_one=token_vault)]
    pub vault: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds=[b"strategy", vault.key().as_ref()], bump=strategy.bump,
        has_one=vault, constraint=strategy.pool==raydium.pool.key(), has_one=quote_mint, has_one=quote_vault)]
    pub strategy: Box<Account<'info, StrategyConfig>>,
    pub asset_mint: Box<Account<'info, Mint>>,
    pub quote_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds=[b"share-mint", vault.key().as_ref()], bump)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub quote_vault: Box<Account<'info, TokenAccount>>,
    pub raydium: RaydiumPositionPool<'info>,
    pub raydium_program: Program<'info, RaydiumClmm>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,

    #[account(mut, seeds=[b"clmm-position", vault.key().as_ref()], bump=clmm_position.bump,
        has_one=vault, constraint=clmm_position.pool==raydium.pool.key(), has_one=nft_mint, has_one=personal_position,
        constraint=clmm_position.open @ VaultError::ClmmPositionClosed)]
    pub clmm_position: Box<Account<'info, ClmmPositionBinding>>,
    #[account(mut)]
    pub nft_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub nft_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Owner, discriminator, length, PDA and all position bindings checked before CPI.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub personal_position: UncheckedAccount<'info>,
    pub memo_program: Program<'info, Memo>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RaydiumPositionPool<'info> {
    #[account(mut, address=WEEK11_POOL)]
    pub pool: AccountLoader<'info, PoolState>,
    #[account(mut, address=pool.load()?.token_vault_0)]
    pub pool_vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut, address=pool.load()?.token_vault_1)]
    pub pool_vault_b: Box<Account<'info, TokenAccount>>,
    /// CHECK: Validated by owner, discriminator, pool, length and canonical tick-array PDA.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub tick_lower: UncheckedAccount<'info>,
    /// CHECK: Same validation as lower array; existing arrays only.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub tick_upper: UncheckedAccount<'info>,
    /// CHECK: Validated canonical bitmap, owner, discriminator, length and pool.
    #[account(mut, owner=raydium_clmm_cpi::ID)]
    pub bitmap: UncheckedAccount<'info>,
    /// CHECK: Deprecated Raydium account, checked canonical PDA for the bound ticks.
    pub protocol_position: UncheckedAccount<'info>,
}
