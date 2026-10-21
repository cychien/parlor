pub fn title(app_name: &str) -> String {
    format!("Connect this Mac to {app_name}")
}

pub fn message(app_name: &str, account: &str, matching_code: &str) -> String {
    format!(
        "Let {app_name} use the agents on this Mac as {account}?\n\nCode: {matching_code}\n\nContinue only if you started this in {app_name}."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dialog_names_the_app_the_account_and_the_code() {
        assert_eq!(title("Hello"), "Connect this Mac to Hello");
        let text = message("Hello", "alice@example.com", "ABC-234");
        assert!(text.contains("alice@example.com"));
        assert!(text.contains("ABC-234"));
    }
}
