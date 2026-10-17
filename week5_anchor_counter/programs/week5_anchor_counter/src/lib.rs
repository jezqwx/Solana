use anchor_lang::prelude::*;

declare_id!("2nrVfpUDfFBruTysag881LqmnCvs191QdHf35V9MHeN6");

#[program]
pub mod week5_anchor_counter {
    use super::*;

    pub fn initialize_counter(ctx: Context<InitializeCounter>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.authority.key();
        counter.value = 0;
        Ok(())
    }

    pub fn increase_counter(ctx: Context<IncreaseCounter>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.value = counter
            .value
            .checked_add(1)
            .ok_or(CounterError::CounterOverflow)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeCounter<'info> {
    #[account(init, payer = authority, space = 8 + 32 + 8)]
    pub counter: Account<'info, CounterState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IncreaseCounter<'info> {
    #[account(mut, has_one = authority)]
    pub counter: Account<'info, CounterState>,
    pub authority: Signer<'info>,
}

#[account]
pub struct CounterState {
    pub authority: Pubkey,
    pub value: u64,
}

#[error_code]
pub enum CounterError {
    #[msg("Counter value overflow.")]
    CounterOverflow,
}
