use std::sync::OnceLock;

use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Keychain,
    Vault,
}

static BACKEND: OnceLock<Backend> = OnceLock::new();

/// The Keychain for a build signed by an Apple-issued certificate, whose items it partitions by Team ID; the vault for
/// any other build, see `crate::vault`.
pub fn backend() -> Backend {
    *BACKEND.get_or_init(|| {
        if signed_by_apple() {
            Backend::Keychain
        } else {
            Backend::Vault
        }
    })
}

fn signed_by_apple() -> bool {
    let Ok(requirement) = "anchor apple generic".parse::<SecRequirement>() else {
        return false;
    };
    SecCode::for_self(Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &requirement))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ad_hoc_build_keeps_its_secrets_in_the_vault() {
        assert_eq!(backend(), Backend::Vault);
    }
}
