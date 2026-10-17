use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

const PROGRAM_MESSAGE: &str = "Hello from Gulya's Solana program!";

entrypoint!(process_message);

pub fn process_message(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    msg!("{}", PROGRAM_MESSAGE);
    Ok(())
}
