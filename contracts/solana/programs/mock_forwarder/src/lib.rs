//! TEST-ONLY stand-in for Chainlink's keystone forwarder on a local validator.
//! It skips DON signature verification (like CRE's simulation forwarder) but
//! delivers reports the same way: a CPI into the receiver's `on_report`,
//! signed by the PDA ["forwarder", state, receiver_program] under this program,
//! passing [state, forwarder_authority, ...receiver accounts]. Never deploy it
//! anywhere that matters.

#![allow(deprecated)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hash, instruction::{AccountMeta, Instruction}, program::invoke_signed};

declare_id!("AmEfFHCeHPx5M1biYUQDs8ioR7C2b2AAqSs87dXUtfMA");

#[program]
pub mod mock_forwarder {
    use super::*;

    pub fn init_state(_ctx: Context<InitState>) -> Result<()> {
        Ok(())
    }

    pub fn report<'info>(ctx: Context<'_, '_, 'info, 'info, Report<'info>>, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        let receiver = ctx.accounts.receiver_program.key();
        let state = ctx.accounts.state.key();
        let (authority, bump) = Pubkey::find_program_address(&[b"forwarder", state.as_ref(), receiver.as_ref()], &crate::ID);
        require_keys_eq!(authority, ctx.accounts.forwarder_authority.key());
        let mut data = hash(b"global:on_report").to_bytes()[..8].to_vec();
        data.extend(metadata.try_to_vec()?);
        data.extend(report.try_to_vec()?);
        let mut accounts = vec![AccountMeta::new(state, false), AccountMeta::new_readonly(authority, true)];
        let mut infos = vec![ctx.accounts.state.to_account_info(), ctx.accounts.forwarder_authority.to_account_info()];
        for account in ctx.remaining_accounts {
            accounts.push(if account.is_writable { AccountMeta::new(account.key(), false) } else { AccountMeta::new_readonly(account.key(), false) });
            infos.push(account.clone());
        }
        infos.push(ctx.accounts.receiver_program.to_account_info());
        invoke_signed(&Instruction { program_id: receiver, accounts, data }, &infos, &[&[b"forwarder", state.as_ref(), receiver.as_ref(), &[bump]]])?;
        Ok(())
    }
}

#[account]
pub struct ForwarderState {
    pub created_by: Pubkey,
}

#[derive(Accounts)]
pub struct InitState<'info> {
    #[account(init, payer = payer, space = 8 + 32)]
    pub state: Account<'info, ForwarderState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Report<'info> {
    /// CHECK: forwarder state owned by this program.
    #[account(mut, owner = crate::ID)]
    pub state: UncheckedAccount<'info>,
    /// CHECK: PDA signer, verified above.
    pub forwarder_authority: UncheckedAccount<'info>,
    /// CHECK: receiver program to CPI into.
    pub receiver_program: UncheckedAccount<'info>,
}
