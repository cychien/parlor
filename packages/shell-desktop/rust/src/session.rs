use tauri::AppHandle;

const ACCOUNT: &str = "parlor.session";

#[cfg(target_os = "macos")]
mod store {
    use super::ACCOUNT;
    use crate::secret_store::{Backend, backend};
    use crate::vault;

    pub fn get(service: &str) -> Result<Option<String>, String> {
        match backend() {
            Backend::Keychain => keychain::get(service),
            Backend::Vault => vault::get(service, ACCOUNT),
        }
    }

    pub fn set(service: &str, token: Option<&str>) -> Result<(), String> {
        match backend() {
            Backend::Keychain => keychain::set(service, token),
            Backend::Vault => vault::set(service, ACCOUNT, token),
        }
    }

    pub(super) mod keychain {
        use super::super::ACCOUNT;
        use security_framework::passwords::{
            delete_generic_password, get_generic_password, set_generic_password,
        };

        const ITEM_NOT_FOUND: i32 = -25300;

        pub fn get(service: &str) -> Result<Option<String>, String> {
            match get_generic_password(service, ACCOUNT) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|e| e.to_string()),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(error.to_string()),
            }
        }

        pub fn set(service: &str, token: Option<&str>) -> Result<(), String> {
            match token {
                Some(token) => set_generic_password(service, ACCOUNT, token.as_bytes())
                    .map_err(|e| e.to_string()),
                None => match delete_generic_password(service, ACCOUNT) {
                    Ok(()) => Ok(()),
                    Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
                    Err(error) => Err(error.to_string()),
                },
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod store {
    pub fn get(_service: &str) -> Result<Option<String>, String> {
        Err("unsupported".to_string())
    }

    pub fn set(_service: &str, _token: Option<&str>) -> Result<(), String> {
        Err("unsupported".to_string())
    }
}

#[tauri::command]
pub async fn parlor_session_get(app: AppHandle) -> Result<Option<String>, String> {
    let service = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || store::get(&service))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn parlor_session_set(app: AppHandle, token: Option<String>) -> Result<(), String> {
    let service = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || store::set(&service, token.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::store::keychain;

    #[test]
    fn the_keychain_keeps_a_session_until_it_is_cleared() {
        let service = format!("dev.parlor.test.session.{}", std::process::id());
        assert_eq!(keychain::get(&service).unwrap(), None);
        keychain::set(&service, Some("token-1")).unwrap();
        assert_eq!(
            keychain::get(&service).unwrap(),
            Some("token-1".to_string())
        );
        keychain::set(&service, None).unwrap();
        assert_eq!(keychain::get(&service).unwrap(), None);
    }
}
