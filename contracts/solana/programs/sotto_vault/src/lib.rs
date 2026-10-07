//! Sotto grant vault on Solana: a treasury that holds SOL, pays grants, and
//! can be paused by a Chainlink CRE report delivered through the keystone
//! forwarder. It mirrors contracts/src/GrantVault.sol (report v2):
//!
//! * Only the forwarder program recorded at `initialize` can deliver a report,
//!   proven by the forwarder-authority PDA it signs with (Chainlink's receiver
//!   pattern; the forwarder verifies DON signatures and the account hash).
//! * The report is bound to this vault account, report version and action,
//!   carries the run, revision and structural policy hash that CRE evaluated,
//!   and must be recent. A repeated run is a no-op.
//! * While paused, `pay_grant` refuses to move funds. Only the owner resumes.

#![allow(deprecated)] // anchor-lang 0.31 #[program] uses AccountInfo::realloc
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("8g87GMMGr4JrzJpfh8v9oxyy8mwDRGawBRFJR8c1hqYD");

pub const REPORT_VERSION: u8 = 2;
pub const ACTION_PAUSE: u8 = 1;
/// Tolerated disagreement between the workflow's clock and the cluster clock.
pub const MAX_CLOCK_SKEW: i64 = 60;

#[program]
pub mod sotto_vault {
    use super::*;

    /// Creates the vault. `forwarder_program` is the Chainlink keystone forwarder
    /// (or CRE's simulation forwarder) allowed to deliver reports.
    pub fn initialize(ctx: Context<Initialize>, forwarder_program: Pubkey, max_report_age: i64) -> Result<()> {
        require!(forwarder_program != Pubkey::default(), VaultError::InvalidForwarderProgram);
        require!(max_report_age > 0 && max_report_age <= 3600, VaultError::InvalidConfiguration);
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.forwarder_program = forwarder_program;
        vault.max_report_age = max_report_age;
        vault.paused = false;
        vault.last_run = [0; 32];
        vault.last_policy_hash = [0; 32];
        vault.last_revision = 0;
        vault.last_decided_at = 0;
        vault.pause_count = 0;
        Ok(())
    }

    /// Called by the keystone forwarder's CPI with a Borsh `PauseReport`.
    pub fn on_report(ctx: Context<OnReport>, _metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        verify_forwarder_cpi(&ctx.accounts.state, &ctx.accounts.forwarder_authority, ctx.accounts.vault.forwarder_program)?;
        // try_from_slice rejects trailing bytes: the layout is exact.
        let report = PauseReport::try_from_slice(&report).map_err(|_| error!(VaultError::UnsupportedReport))?;
        require!(report.version == REPORT_VERSION, VaultError::UnsupportedReport);
        require_keys_eq!(report.vault, ctx.accounts.vault.key(), VaultError::WrongTarget);
        require!(report.action == ACTION_PAUSE, VaultError::UnsupportedAction);
        require!(report.run_id != [0; 32] && report.policy_hash != [0; 32] && report.revision > 0, VaultError::InvalidReport);

        let vault = &mut ctx.accounts.vault;
        if report.run_id == vault.last_run {
            msg!("sotto_vault duplicate run; no-op");
            return Ok(());
        }
        let now = Clock::get()?.unix_timestamp;
        require!(
            report.decided_at <= now + MAX_CLOCK_SKEW && now - report.decided_at <= vault.max_report_age,
            VaultError::StaleReport
        );
        vault.last_run = report.run_id;
        if vault.paused {
            msg!("sotto_vault already paused; no second pause");
            return Ok(());
        }
        vault.paused = true;
        vault.last_policy_hash = report.policy_hash;
        vault.last_revision = report.revision;
        vault.last_decided_at = report.decided_at;
        vault.pause_count = vault.pause_count.saturating_add(1);
        emit!(SpendingPaused {
            vault: vault.key(),
            run_id: report.run_id,
            revision: report.revision,
            policy_hash: report.policy_hash,
            decided_at: report.decided_at,
        });
        Ok(())
    }

    /// Pays a grant from the vault's own SOL. Refused while paused.
    pub fn pay_grant(ctx: Context<PayGrant>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault.paused, VaultError::SpendingIsPaused);
        require!(amount > 0, VaultError::InvalidAmount);
        let vault_info = ctx.accounts.vault.to_account_info();
        let reserve = Rent::get()?.minimum_balance(vault_info.data_len());
        let remaining = vault_info.lamports().checked_sub(amount).ok_or(VaultError::InsufficientFunds)?;
        require!(remaining >= reserve, VaultError::InsufficientFunds);
        **vault_info.try_borrow_mut_lamports()? = remaining;
        let recipient = ctx.accounts.recipient.to_account_info();
        **recipient.try_borrow_mut_lamports()? = recipient.lamports().checked_add(amount).ok_or(VaultError::InvalidAmount)?;
        emit!(GrantPaid { vault: vault_info.key(), recipient: recipient.key(), amount });
        Ok(())
    }

    /// Owner-only: re-enable spending after a pause.
    pub fn resume(ctx: Context<Resume>) -> Result<()> {
        ctx.accounts.vault.paused = false;
        emit!(SpendingResumed { vault: ctx.accounts.vault.key() });
        Ok(())
    }
}

/// Borsh layout written by the CRE workflow (cre/graph.ts encodeSolanaPauseReport), 114 bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PauseReport {
    pub version: u8,
    pub vault: Pubkey,
    pub run_id: [u8; 32],
    pub revision: u64,
    pub policy_hash: [u8; 32],
    pub action: u8,
    pub decided_at: i64,
}

fn verify_forwarder_cpi(state: &UncheckedAccount, forwarder_authority: &Signer, forwarder_program: Pubkey) -> Result<()> {
    require!(forwarder_program != Pubkey::default(), VaultError::InvalidForwarderProgram);
    require_keys_eq!(*state.to_account_info().owner, forwarder_program, VaultError::MismatchedForwarderProgram);
    let state_key = state.key();
    let seeds: &[&[u8]] = &[b"forwarder", state_key.as_ref(), crate::ID.as_ref()];
    let (expected, _bump) = Pubkey::find_program_address(seeds, &forwarder_program);
    require_keys_eq!(expected, forwarder_authority.key(), VaultError::InvalidForwarderAuthority);
    Ok(())
}

#[error_code]
pub enum VaultError {
    #[msg("forwarder_program must be a non-default pubkey")]
    InvalidForwarderProgram,
    #[msg("max_report_age must be 1..=3600 seconds")]
    InvalidConfiguration,
    #[msg("Forwarder state account is not owned by the configured forwarder program")]
    MismatchedForwarderProgram,
    #[msg("forwarder_authority is not the PDA for this state, receiver and forwarder")]
    InvalidForwarderAuthority,
    #[msg("Report is not a v2 Borsh PauseReport")]
    UnsupportedReport,
    #[msg("Report targets a different vault")]
    WrongTarget,
    #[msg("Report action is not pause")]
    UnsupportedAction,
    #[msg("Report run, revision or policy hash is empty")]
    InvalidReport,
    #[msg("Report is too old or from the future")]
    StaleReport,
    #[msg("Spending is paused")]
    SpendingIsPaused,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Vault cannot pay that much and stay rent-exempt")]
    InsufficientFunds,
}

#[event]
pub struct SpendingPaused {
    pub vault: Pubkey,
    pub run_id: [u8; 32],
    pub revision: u64,
    pub policy_hash: [u8; 32],
    pub decided_at: i64,
}
#[event]
pub struct SpendingResumed {
    pub vault: Pubkey,
}
#[event]
pub struct GrantPaid {
    pub vault: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub forwarder_program: Pubkey,
    pub max_report_age: i64,
    pub paused: bool,
    pub last_run: [u8; 32],
    pub last_policy_hash: [u8; 32],
    pub last_revision: u64,
    pub last_decided_at: i64,
    pub pause_count: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OnReport<'info> {
    /// CHECK: forwarder state; its owner must be the configured forwarder program (verified).
    pub state: UncheckedAccount<'info>,
    /// PDA the forwarder signs with; verified against state and this program.
    pub forwarder_authority: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct PayGrant<'info> {
    #[account(mut, has_one = owner @ VaultError::InvalidReport)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    /// CHECK: any account may receive lamports.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Resume<'info> {
    #[account(mut, has_one = owner @ VaultError::InvalidReport)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}
