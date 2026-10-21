use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

pub const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

pub fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

pub fn socket_path(home: &std::path::Path) -> PathBuf {
    home.join(".parlor")
        .join("host")
        .join("run")
        .join("control.sock")
}

pub fn exchange(socket: &std::path::Path, request: &Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(REPLY_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let line = format!("{request}\n");
    stream
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut reply = String::new();
    BufReader::new(stream)
        .read_line(&mut reply)
        .map_err(|e| e.to_string())?;
    parse_reply(&reply)
}

pub fn parse_reply(line: &str) -> Result<Value, String> {
    if line.trim().is_empty() {
        return Err("Parlor Host closed the connection.".to_string());
    }
    serde_json::from_str(line).map_err(|e| e.to_string())
}

pub fn request(socket: &std::path::Path, request: Value) -> Result<Value, String> {
    let reply = exchange(socket, &request)?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(reply);
    }
    let error = reply
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Parlor Host refused the request.");
    Err(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::net::UnixListener;

    #[test]
    fn socket_lives_under_the_home_host_run_directory() {
        assert_eq!(
            socket_path(std::path::Path::new("/Users/a")),
            PathBuf::from("/Users/a/.parlor/host/run/control.sock")
        );
    }

    #[test]
    fn a_reply_is_one_json_line() {
        assert_eq!(parse_reply("{\"ok\":true}\n").unwrap(), json!({"ok": true}));
        assert!(parse_reply("").is_err());
        assert!(parse_reply("not json").is_err());
    }

    #[test]
    fn request_writes_one_line_and_surfaces_a_refusal() {
        let dir = std::env::temp_dir().join(format!("ps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap(),
                json!({"op": "status"})
            );
            stream
                .write_all(b"{\"ok\":false,\"error\":\"declined_locally\"}\n")
                .unwrap();
        });
        let outcome = request(&path, json!({"op": "status"}));
        server.join().unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(outcome, Err("declined_locally".to_string()));
    }
}
