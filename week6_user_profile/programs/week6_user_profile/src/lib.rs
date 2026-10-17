use anchor_lang::prelude::*;

declare_id!("BSqWeHUcXYLa8SAiViUAcST2ozVajKzcgko2R1EpFjzB");

pub const MAX_NAME_LEN: usize = 40;
pub const MAX_ABOUT_LEN: usize = 180;

#[program]
pub mod week6_user_profile {
    use super::*;

    pub fn create_profile(
        ctx: Context<CreateProfile>,
        display_name: String,
        about: String,
    ) -> Result<()> {
        require!(
            display_name.as_bytes().len() <= MAX_NAME_LEN,
            ProfileError::NameTooLong
        );
        require!(
            about.as_bytes().len() <= MAX_ABOUT_LEN,
            ProfileError::AboutTooLong
        );

        let profile = &mut ctx.accounts.profile;
        profile.authority = ctx.accounts.authority.key();
        profile.display_name = display_name;
        profile.about = about;
        profile.bump = ctx.bumps.profile;

        Ok(())
    }

    pub fn edit_profile(
        ctx: Context<EditProfile>,
        display_name: String,
        about: String,
    ) -> Result<()> {
        require!(
            display_name.as_bytes().len() <= MAX_NAME_LEN,
            ProfileError::NameTooLong
        );
        require!(
            about.as_bytes().len() <= MAX_ABOUT_LEN,
            ProfileError::AboutTooLong
        );

        let profile = &mut ctx.accounts.profile;
        profile.display_name = display_name;
        profile.about = about;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateProfile<'info> {
    #[account(
        init,
        payer = authority,
        space = UserProfile::SPACE,
        seeds = [b"user-profile", authority.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, UserProfile>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EditProfile<'info> {
    #[account(
        mut,
        seeds = [b"user-profile", authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority
    )]
    pub profile: Account<'info, UserProfile>,

    pub authority: Signer<'info>,
}

#[account]
pub struct UserProfile {
    pub authority: Pubkey,
    pub display_name: String,
    pub about: String,
    pub bump: u8,
}

impl UserProfile {
    pub const SPACE: usize = 8 + 32 + 4 + MAX_NAME_LEN + 4 + MAX_ABOUT_LEN + 1;
}

#[error_code]
pub enum ProfileError {
    #[msg("Display name is too long.")]
    NameTooLong,

    #[msg("Profile description is too long.")]
    AboutTooLong,
}
