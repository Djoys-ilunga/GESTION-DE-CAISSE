mod broker;
mod model;
mod persistence;
mod state;
mod synchronization;
pub use broker::Broker;
pub use model::*;
type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("LOCAL_STORAGE_UNAVAILABLE")]
    LocalStorage,
    #[error("BCC_AUTHORIZATION_REQUIRED")]
    BccAuthorizationRequired,
    #[error("BCC_SOURCE_UNVERIFIED")]
    BccUnverified,
    #[error("BCC_RATE_UNAVAILABLE")]
    BccUnavailable,
    #[error("RATE_QUOTE_STALE")]
    RateStale,
    #[error("MANUAL_RATE_FORBIDDEN")]
    ManualRateForbidden,
    #[error("CURRENCY_INACTIVE")]
    CurrencyInactive,
    #[error("CURRENCY_IN_USE")]
    CurrencyInUse,
    #[error("CURRENCY_PRECISION")]
    CurrencyPrecision,
    #[error("SETTINGS_CONFLICT")]
    SettingsConflict,
    #[error("AGENCY_HAS_ACTIVE_CASH")]
    AgencyHasActiveCash,
    #[error("REPORT_TOO_LARGE")]
    ReportTooLarge,
    #[error("REPORT_DATES_INVALID")]
    ReportDates,
    #[error("CLOSURE_RESERVED_FUNDS")]
    ClosureReserved,
    #[error("CLOSURE_CONFLICT")]
    ClosureConflict,
    #[error("TRANSFER_CONFLICT")]
    TransferConflict,
    #[error("TRANSFER_DISTINCT_RECEIVER_REQUIRED")]
    TransferReceiver,
    #[error("SYNC_BUSY")]
    SyncBusy,
    #[error("EXPENSE_CONFLICT")]
    ExpenseConflict,
    #[error("EXPENSE_POLICY_REQUIRED")]
    ExpensePolicy,
    #[error("EXPENSE_LIMIT_EXCEEDED")]
    ExpenseLimit,
    #[error("INSUFFICIENT_FUNDS")]
    InsufficientFunds,
    #[error("EXPENSE_EVIDENCE_REQUIRED")]
    ExpenseEvidence,
    #[error("AUTH_REQUIRED")]
    AuthRequired,
    #[error("SESSION_EXPIRED")]
    Expired,
    #[error("SESSION_LOCKED")]
    Locked,
    #[error("PERMISSION_DENIED")]
    Forbidden,
    #[error("ONLINE_REQUIRED")]
    OnlineRequired,
    #[error("SERVER_IDENTITY_INVALID")]
    Identity,
    #[error("SERVER_UNAVAILABLE")]
    Unavailable,
    #[error("INVALID_CREDENTIALS")]
    Credentials,
    #[error("REQUEST_INVALID")]
    InvalidInput,
    #[error("SERVER_RESPONSE_INVALID")]
    InvalidResponse,
    #[error("SESSION_CHANGED")]
    SessionChanged,
    #[error("LOCAL_VERSION_CONFLICT")]
    Conflict,
    #[error("AUTH_THROTTLED")]
    Throttled,
    #[error("PASSWORD_CHANGE_REQUIRED")]
    PasswordChangeRequired,
}
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transport_tests;
