mod broker;
mod model;
mod state;
pub use broker::Broker;
pub use model::*;
type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
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
