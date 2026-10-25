mod auth_browser;
#[cfg(unix)]
mod control;
mod device_key;
#[cfg(unix)]
mod dialog;
#[cfg(unix)]
mod host;
mod keystore;
#[cfg(target_os = "macos")]
mod secret_store;
mod session;
#[cfg(target_os = "macos")]
mod vault;

pub use auth_browser::parlor_auth_browser_open;
pub use device_key::{parlor_device_key_public, parlor_device_key_sign};
#[cfg(unix)]
pub use host::{
    parlor_host_begin, parlor_host_bundled, parlor_host_finish, parlor_host_status, setup,
};
pub use session::{parlor_session_get, parlor_session_set};
