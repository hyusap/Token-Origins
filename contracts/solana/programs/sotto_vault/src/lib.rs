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
//! * Report v3 adds a sweep: move a share of the vault's SOL to the reserve the
//!   owner fixed with `configure_reserve`, capped by `max_sweep_bps`, optionally
//!   pausing in the same delivery. v2 pause reports are still accepted, so a
//!   vault created before this upgrade keeps working unchanged.

#![allow(deprecated)] // anchor-lang 0.31 #[program] uses AccountInfo::realloc
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("8g87GMMGr4JrzJpfh8v9oxyy8mwDRGawBRFJR8c1hqYD");

/// Pause-only layout (114 bytes), accepted since the first release.
pub const PAUSE_REPORT_VERSION: u8 = 2;
/// Action layout (117 bytes): v2's fields, then flags and basis points.
pub const ACTION_REPORT_VERSION: u8 = 3;
pub const ACTION_PAUSE: u8 = 1;
pub const ACTION_SWEEP: u8 = 2;
pub const FLAG_PAUSE: u8 = 1;
pub const BPS: u64 = 10_000;
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

    /// Called by the keystone forwarder's CPI with a Borsh `PauseReport` (v2) or
    /// `ActionReport` (v3). A sweep also needs [treasury config PDA, reserve
    /// (writable)] after the vault, in that order.
    pub fn on_report<'info>(ctx: Context<'_, '_, 'info, 'info, OnReport<'info>>, _metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        verify_forwarder_cpi(&ctx.accounts.state, &ctx.accounts.forwarder_authority, ctx.accounts.vault.forwarder_program)?;
        let report = decode_report(&report)?;
        require_keys_eq!(report.vault, ctx.accounts.vault.key(), VaultError::WrongTarget);
        require!(report.run_id != [0; 32] && report.policy_hash != [0; 32] && report.revision > 0, VaultError::InvalidReport);

        {
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
            if report.action == ACTION_PAUSE || report.flags & FLAG_PAUSE != 0 {
                if vault.paused {
                    msg!("sotto_vault already paused; no second pause");
                } else {
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
                }
            }
        }
        if report.action == ACTION_SWEEP {
            sweep_to_reserve(&ctx.accounts.vault, ctx.remaining_accounts, &report)?;
        }
        Ok(())
    }

    /// Owner-only, once per vault: fixes where sweeps may send SOL and the
    /// largest share one report may move. Creates the PDA ["treasury", vault].
    pub fn configure_reserve(ctx: Context<ConfigureReserve>, reserve: Pubkey, max_sweep_bps: u16) -> Result<()> {
        require!(reserve != Pubkey::default(), VaultError::InvalidConfiguration);
        require!(max_sweep_bps > 0 && max_sweep_bps as u64 <= BPS, VaultError::InvalidConfiguration);
        let treasury = &mut ctx.accounts.treasury;
        treasury.vault = ctx.accounts.vault.key();
        treasury.reserve = reserve;
        treasury.max_sweep_bps = max_sweep_bps;
        treasury.bump = ctx.bumps.treasury;
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

/// Borsh v2 layout written by the CRE workflow (cre/solana-report.ts encodeSolanaPauseReport), 114 bytes.
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

/// Borsh v3 layout (cre/solana-report.ts encodeSolanaActionReport), 117 bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ActionReport {
    pub version: u8,
    pub vault: Pubkey,
    pub run_id: [u8; 32],
    pub revision: u64,
    pub policy_hash: [u8; 32],
    pub action: u8,
    pub decided_at: i64,
    pub flags: u8,
    pub bps: u16,
}

/// Decodes either layout into v3 terms. try_from_slice rejects trailing bytes:
/// each layout is exact.
fn decode_report(bytes: &[u8]) -> Result<ActionReport> {
    match bytes.first() {
        Some(&PAUSE_REPORT_VERSION) => {
            let r = PauseReport::try_from_slice(bytes).map_err(|_| error!(VaultError::UnsupportedReport))?;
            require!(r.action == ACTION_PAUSE, VaultError::UnsupportedAction);
            Ok(ActionReport { version: r.version, vault: r.vault, run_id: r.run_id, revision: r.revision, policy_hash: r.policy_hash, action: r.action, decided_at: r.decided_at, flags: 0, bps: 0 })
        }
        Some(&ACTION_REPORT_VERSION) => {
            let r = ActionReport::try_from_slice(bytes).map_err(|_| error!(VaultError::UnsupportedReport))?;
            require!(r.action == ACTION_PAUSE || r.action == ACTION_SWEEP, VaultError::UnsupportedAction);
            require!(r.flags <= FLAG_PAUSE, VaultError::UnsupportedAction);
            Ok(r)
        }
        _ => err!(VaultError::UnsupportedReport),
    }
}

/// Moves `bps` of the vault's spendable SOL (above rent) to the configured reserve.
fn sweep_to_reserve<'info>(vault: &Account<'info, Vault>, remaining: &'info [AccountInfo<'info>], report: &ActionReport) -> Result<()> {
    require!(remaining.len() >= 2, VaultError::ReserveNotConfigured);
    let (config_info, reserve_info) = (&remaining[0], &remaining[1]);
    let (expected, _) = Pubkey::find_program_address(&[b"treasury", vault.key().as_ref()], &crate::ID);
    require_keys_eq!(config_info.key(), expected, VaultError::ReserveNotConfigured);
    let config: Account<'info, TreasuryConfig> = Account::try_from(config_info).map_err(|_| error!(VaultError::ReserveNotConfigured))?;
    require_keys_eq!(config.vault, vault.key(), VaultError::ReserveNotConfigured);
    require_keys_eq!(reserve_info.key(), config.reserve, VaultError::WrongReserve);
    require!(reserve_info.is_writable, VaultError::WrongReserve);
    require!(report.bps > 0 && report.bps <= config.max_sweep_bps, VaultError::InvalidAmount);

    let vault_info = vault.to_account_info();
    let rent = Rent::get()?.minimum_balance(vault_info.data_len());
    let spendable = vault_info.lamports().saturating_sub(rent);
    let amount = (spendable as u128 * report.bps as u128 / BPS as u128) as u64;
    require!(amount > 0, VaultError::NothingToMove);
    **vault_info.try_borrow_mut_lamports()? = vault_info.lamports().checked_sub(amount).ok_or(VaultError::InsufficientFunds)?;
    **reserve_info.try_borrow_mut_lamports()? = reserve_info.lamports().checked_add(amount).ok_or(VaultError::InvalidAmount)?;
    emit!(ReserveSwept {
        vault: vault.key(),
        run_id: report.run_id,
        revision: report.revision,
        policy_hash: report.policy_hash,
        reserve: reserve_info.key(),
        amount,
    });
    Ok(())
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
    #[msg("Report is not a v2 PauseReport or v3 ActionReport")]
    UnsupportedReport,
    #[msg("Report targets a different vault")]
    WrongTarget,
    #[msg("Report action is not pause or sweep")]
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
    #[msg("Sweep needs the vault's treasury config; run configure_reserve first")]
    ReserveNotConfigured,
    #[msg("Reserve account is not the configured, writable reserve")]
    WrongReserve,
    #[msg("Nothing to sweep above the rent reserve")]
    NothingToMove,
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
pub struct ReserveSwept {
    pub vault: Pubkey,
    pub run_id: [u8; 32],
    pub revision: u64,
    pub policy_hash: [u8; 32],
    pub reserve: Pubkey,
    pub amount: u64,
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

/// Where sweeps go, per vault: PDA ["treasury", vault].
#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub vault: Pubkey,
    pub reserve: Pubkey,
    pub max_sweep_bps: u16,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct ConfigureReserve<'info> {
    #[account(has_one = owner @ VaultError::InvalidReport)]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = owner, space = 8 + TreasuryConfig::INIT_SPACE, seeds = [b"treasury", vault.key().as_ref()], bump)]
    pub treasury: Account<'info, TreasuryConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
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
