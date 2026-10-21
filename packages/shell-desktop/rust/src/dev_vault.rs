//! Debug builds keep the device keys and the session in a 0600 file instead of the
//! Keychain: an ad hoc build's Keychain ACL is bound to its cdhash, so every rebuild
//! would ask for the login password.

use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE: &str = "parlor-dev-vault.json";

static WRITING: Mutex<()> = Mutex::new(());

fn file_in(home: &Path, identifier: &str) -> PathBuf {
    home.join("Library/Application Support")
        .join(identifier)
        .join(FILE)
}

fn file(identifier: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set.")?;
    Ok(file_in(Path::new(&home), identifier))
}

fn read(path: &Path) -> Result<BTreeMap<String, String>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write(path: &Path, entries: &BTreeMap<String, String>) -> Result<(), String> {
    let dir = path.parent().ok_or("The vault has no folder.")?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| e.to_string())?;
    let staged = dir.join(format!(".{FILE}.{}", std::process::id()));
    let mut out = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staged)
        .map_err(|e| e.to_string())?;
    out.write_all(&serde_json::to_vec(entries).map_err(|e| e.to_string())?)
        .and_then(|()| out.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&staged, path).map_err(|e| e.to_string())
}

fn get_at(path: &Path, entry: &str) -> Result<Option<String>, String> {
    Ok(read(path)?.remove(entry))
}

fn set_at(path: &Path, entry: &str, value: Option<&str>) -> Result<(), String> {
    let _writing = WRITING.lock().map_err(|e| e.to_string())?;
    let mut entries = read(path)?;
    match value {
        Some(value) => entries.insert(entry.to_string(), value.to_string()),
        None => entries.remove(entry),
    };
    write(path, &entries)
}

pub fn get(identifier: &str, entry: &str) -> Result<Option<String>, String> {
    get_at(&file(identifier)?, entry)
}

pub fn set(identifier: &str, entry: &str, value: Option<&str>) -> Result<(), String> {
    set_at(&file(identifier)?, entry, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "parlor-dev-vault-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        file_in(&dir, "dev.parlor.test")
    }

    #[test]
    fn an_entry_is_kept_until_it_is_cleared() {
        let path = scratch();
        assert_eq!(get_at(&path, "session").unwrap(), None);
        set_at(&path, "session", Some("token-1")).unwrap();
        set_at(&path, "signing", Some("key-1")).unwrap();
        assert_eq!(
            get_at(&path, "session").unwrap(),
            Some("token-1".to_string())
        );
        set_at(&path, "session", None).unwrap();
        assert_eq!(get_at(&path, "session").unwrap(), None);
        assert_eq!(get_at(&path, "signing").unwrap(), Some("key-1".to_string()));
    }

    #[test]
    fn only_the_user_can_read_the_vault() {
        let path = scratch();
        set_at(&path, "session", Some("token-1")).unwrap();
        let file = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let dir = fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file, 0o600);
        assert_eq!(dir, 0o700);
    }

    #[test]
    fn the_vault_lives_in_the_app_support_folder_of_the_app() {
        assert_eq!(
            file_in(Path::new("/Users/alice"), "dev.parlor.hello"),
            PathBuf::from(
                "/Users/alice/Library/Application Support/dev.parlor.hello/parlor-dev-vault.json"
            )
        );
    }
}
