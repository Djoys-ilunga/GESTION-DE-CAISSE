use crate::{Result, StoreError};
use zeroize::Zeroizing;
pub trait KeyVault {
    fn load(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn store(&self, account: &str, key: &[u8]) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}
pub struct NativeKeyVault;
#[cfg(any(target_os = "windows", target_os = "macos"))]
impl KeyVault for NativeKeyVault {
    fn load(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let entry = keyring::Entry::new("CaissePro.LocalStore", account).map_err(|_|StoreError::KeyUnavailable)?;
        match entry.get_secret() { Ok(key)=>Ok(Some(Zeroizing::new(key))), Err(keyring::Error::NoEntry)=>Ok(None), Err(_)=>Err(StoreError::KeyUnavailable) }
    }
    fn store(&self, account:&str,key:&[u8])->Result<()> { keyring::Entry::new("CaissePro.LocalStore",account).and_then(|e|e.set_secret(key)).map_err(|_|StoreError::KeyUnavailable) }
    fn delete(&self, account:&str)->Result<()> {
        match keyring::Entry::new("CaissePro.LocalStore",account).and_then(|e|e.delete_credential()) {Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(_)=>Err(StoreError::KeyUnavailable)}
    }
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl KeyVault for NativeKeyVault {
    fn load(&self,_:&str)->Result<Option<Zeroizing<Vec<u8>>>> {Err(StoreError::KeyUnavailable)}
    fn store(&self,_:&str,_:&[u8])->Result<()> {Err(StoreError::KeyUnavailable)}
    fn delete(&self,_:&str)->Result<()> {Err(StoreError::KeyUnavailable)}
}
