use crate::{Result, StoreError};
use std::{fs, path::Path};

pub fn protect_directory(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(StoreError::AccessDenied);
    }
    protect(path, true)
}
pub fn protect_file(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(StoreError::AccessDenied);
    }
    protect(path, false)
}
fn protect(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(StoreError::AccessDenied);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if !directory && metadata.nlink() != 1 {
            return Err(StoreError::AccessDenied);
        }
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                },
                SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(StoreError::AccessDenied);
        }
        let sddl = if directory {
            "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        } else {
            "D:P(A;;FA;;;OW)(A;;FA;;;SY)(A;;FA;;;BA)"
        };
        let description: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        // The descriptor is allocated by Windows and freed exactly once after SetFileSecurityW.
        let success = unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                description.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(StoreError::AccessDenied);
            }
            let result = SetFileSecurityW(
                filename.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                descriptor,
            );
            LocalFree(descriptor);
            result != 0
        };
        if success {
            Ok(())
        } else {
            Err(StoreError::AccessDenied)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, directory);
        Err(StoreError::PlatformNotValidated)
    }
}
