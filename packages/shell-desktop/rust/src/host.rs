use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::control::{self, home, socket_path};
use crate::dialog;

const SIDECAR: &str = "parlor-host";
const SIGNATURE: &str = "parlor-host.sig";
const ENSURE_WAIT: Duration = Duration::from_secs(20);

#[derive(Clone, Default)]
pub struct EnsureGate(Arc<(Mutex<bool>, Condvar)>);

impl EnsureGate {
    fn open(&self) {
        let (done, signal) = &*self.0;
        *done.lock().unwrap() = true;
        signal.notify_all();
    }

    fn wait(&self, timeout: Duration) {
        let (done, signal) = &*self.0;
        let guard = done.lock().unwrap();
        let _ = signal
            .wait_timeout_while(guard, timeout, |finished| !*finished)
            .unwrap();
    }
}

pub fn log_path(home: &Path, app_id: &str) -> PathBuf {
    home.join("Library")
        .join("Logs")
        .join(app_id)
        .join("parlor-host.log")
}

pub fn append_line(file: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    writeln!(out, "{}", line.trim_end())
}

pub fn is_ensure_line(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("event")
                .and_then(Value::as_str)
                .map(|e| e == "ensure")
        })
        .unwrap_or(false)
}

fn run_ensure(binary: &Path, signature: &Path, app_id: &str, log: &Path) {
    let spawned = Command::new(binary)
        .args(["daemon", "--ensure", "--app", app_id, "--binary"])
        .arg(binary)
        .arg("--signature")
        .arg(signature)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let failed = json!({"event": "ensure_failed", "error": error.to_string()});
            let _ = append_line(log, &failed.to_string());
            return;
        }
    };
    let mut recorded = false;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if is_ensure_line(&line) {
                let _ = append_line(log, &line);
                recorded = true;
                break;
            }
        }
    }
    let status = child.wait();
    if !recorded {
        let failed = json!({"event": "ensure_failed", "status": format!("{status:?}")});
        let _ = append_line(log, &failed.to_string());
    }
}

fn signature_path(app: &AppHandle, sidecar: &Path) -> PathBuf {
    let beside = sidecar.with_file_name(SIGNATURE);
    match app.path().resolve(SIGNATURE, BaseDirectory::Resource) {
        Ok(resolved) if resolved.exists() => resolved,
        _ if beside.exists() => beside,
        Ok(resolved) => resolved,
        Err(_) => beside,
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let gate = EnsureGate::default();
    app.manage(gate.clone());
    let handle = app.handle().clone();
    let app_id = app.config().identifier.clone();
    std::thread::spawn(move || {
        let outcome = (|| -> Result<(), String> {
            let sidecar = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .with_file_name(SIDECAR);
            let signature = signature_path(&handle, &sidecar);
            let log = log_path(&home()?, &app_id);
            run_ensure(&sidecar, &signature, &app_id, &log);
            Ok(())
        })();
        if let Err(error) = outcome {
            eprintln!("parlor-host ensure: {error}");
        }
        gate.open();
    });
    Ok(())
}

pub fn stopped() -> Value {
    json!({"state": "stopped"})
}

pub fn status_of(reply: &Value) -> Value {
    reply
        .get("status")
        .filter(|status| status.get("state").and_then(Value::as_str) == Some("running"))
        .cloned()
        .unwrap_or_else(stopped)
}

pub fn finish_result(connect: bool, reply: &Result<Value, String>) -> Value {
    match reply {
        Ok(_) if connect => json!({"connected": true}),
        Ok(_) => json!({"connected": false, "reason": "declined_locally"}),
        Err(error) if error == "declined_locally" => {
            json!({"connected": false, "reason": "declined_locally"})
        }
        Err(_) => json!({"connected": false, "reason": "failed"}),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn parlor_host_bundled() -> bool {
    true
}

#[tauri::command]
pub async fn parlor_host_status(gate: State<'_, EnsureGate>) -> Result<Value, String> {
    let gate = gate.inner().clone();
    blocking(move || {
        gate.wait(ENSURE_WAIT);
        let reply =
            home().and_then(|home| control::request(&socket_path(&home), json!({"op": "status"})));
        reply
            .map(|reply| status_of(&reply))
            .unwrap_or_else(|_| stopped())
    })
    .await
}

#[tauri::command]
pub async fn parlor_host_begin(
    gate: State<'_, EnsureGate>,
    app_origin: String,
) -> Result<Value, String> {
    let gate = gate.inner().clone();
    blocking(move || {
        gate.wait(ENSURE_WAIT);
        let reply = control::request(
            &socket_path(&home()?),
            json!({"op": "begin_local_pairing", "appOrigin": app_origin}),
        )?;
        reply
            .get("pairing")
            .cloned()
            .ok_or_else(|| "Parlor Host sent no pairing.".to_string())
    })
    .await?
}

fn text_of<'a>(reply: &'a Value, field: &str) -> Result<&'a str, String> {
    reply
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Parlor Host sent no {field}."))
}

#[tauri::command]
pub async fn parlor_host_finish(
    app: AppHandle,
    app_origin: String,
    code: String,
    device: Option<Value>,
) -> Result<Value, String> {
    let socket = socket_path(&home()?);
    let finishing = {
        let (socket, app_origin) = (socket.clone(), app_origin.clone());
        blocking(move || {
            control::request(
                &socket,
                json!({"op": "finish_local_pairing", "appOrigin": app_origin, "code": code}),
            )
        })
        .await?
    };
    let reply = match finishing {
        Ok(reply) => reply,
        Err(_) => return Ok(json!({"connected": false, "reason": "failed"})),
    };
    let (account, matching_code) =
        match (text_of(&reply, "account"), text_of(&reply, "matchingCode")) {
            (Ok(account), Ok(code)) => (account.to_string(), code.to_string()),
            _ => return Ok(json!({"connected": false, "reason": "failed"})),
        };
    let app_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.config().identifier.clone());
    let connect = {
        let (title, message) = (
            dialog::title(&app_name),
            dialog::message(&app_name, &account, &matching_code),
        );
        let app = app.clone();
        blocking(move || {
            app.dialog()
                .message(message)
                .title(title)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Connect".to_string(),
                    "Cancel".to_string(),
                ))
                .blocking_show()
        })
        .await?
    };
    let mut confirmation = json!({
        "op": "confirm_local_pairing",
        "appOrigin": app_origin,
        "connect": connect,
    });
    if let Some(device) = device {
        confirmation["device"] = device;
    }
    let confirmed = blocking(move || control::request(&socket, confirmation)).await?;
    Ok(finish_result(connect, &confirmed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_lives_under_the_apps_library_logs_directory() {
        assert_eq!(
            log_path(Path::new("/Users/a"), "dev.parlor.hello"),
            PathBuf::from("/Users/a/Library/Logs/dev.parlor.hello/parlor-host.log")
        );
    }

    #[test]
    fn append_line_creates_the_directory_and_keeps_earlier_lines() {
        let dir = std::env::temp_dir().join(format!("ps-log-{}", std::process::id()));
        let file = log_path(&dir, "dev.parlor.hello");
        append_line(&file, "{\"event\":\"ensure\",\"outcome\":\"using\"}\n").unwrap();
        append_line(&file, "{\"event\":\"ensure\",\"outcome\":\"installed\"}").unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            text,
            "{\"event\":\"ensure\",\"outcome\":\"using\"}\n{\"event\":\"ensure\",\"outcome\":\"installed\"}\n"
        );
    }

    #[test]
    fn only_the_ensure_event_is_logged() {
        assert!(is_ensure_line(
            "{\"event\":\"ensure\",\"outcome\":\"using\",\"ms\":3}"
        ));
        assert!(!is_ensure_line("{\"event\":\"daemon_started\"}"));
        assert!(!is_ensure_line("starting"));
    }

    #[test]
    fn status_maps_a_running_host_and_anything_else_to_stopped() {
        let running = json!({"ok": true, "status": {"state": "running", "version": "1.0.0", "apps": ["http://a"]}});
        assert_eq!(status_of(&running)["version"], "1.0.0");
        assert_eq!(status_of(&json!({"ok": true})), stopped());
        assert_eq!(
            status_of(&json!({"status": {"state": "stopped"}})),
            stopped()
        );
    }

    #[test]
    fn finish_maps_the_control_reply_to_the_capability_result() {
        let ok = Ok(json!({"ok": true}));
        assert_eq!(finish_result(true, &ok), json!({"connected": true}));
        assert_eq!(
            finish_result(false, &ok),
            json!({"connected": false, "reason": "declined_locally"})
        );
        assert_eq!(
            finish_result(false, &Err("declined_locally".to_string())),
            json!({"connected": false, "reason": "declined_locally"})
        );
        assert_eq!(
            finish_result(true, &Err("boom".to_string())),
            json!({"connected": false, "reason": "failed"})
        );
    }
}
