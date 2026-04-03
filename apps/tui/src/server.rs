use color_eyre::Result;
use std::path::PathBuf;
use std::process::Stdio;

/// Ensure the server is running. If not reachable, attempt to start it.
/// Returns Ok(true) if we spawned a new server, Ok(false) if already running.
pub async fn ensure_running(base_url: &str) -> Result<bool> {
    // Check if server is already up and healthy
    match health_check_detailed(base_url).await {
        HealthStatus::Healthy => return Ok(false),
        HealthStatus::Unhealthy(status) => {
            let port = extract_port(base_url);
            if restart_conflicting_server_enabled() {
                eprintln!("Port {port} responds with {status}. Attempting to restart...");
                kill_port_process(port);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            } else {
                return Err(color_eyre::eyre::eyre!(
                    "Port {port} is in use by a service that did not pass the 0x0 health check (status {status}). \
                     Refusing to kill it automatically. Set ZEROXZERO_TUI_RESTART_SERVER=1 to allow restart."
                ));
            }
        }
        HealthStatus::Unreachable => {
            // Nothing listening — proceed to spawn
        }
    }

    // Try to find the server entry point and bun binary
    let server_entry = find_server_entry()?;
    let bun = find_bun()?;
    let port = extract_port(base_url);

    eprintln!("Starting 0x0 server on port {port}...");

    // Spawn the server as a detached background process using std::process
    // so we can use process_group(0) to detach it from the TUI's process group.
    let mut cmd = std::process::Command::new(&bun);
    cmd.arg("run")
        .arg(&server_entry)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("ZEROXZERO_DAEMON", "1");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    cmd.spawn()
        .map_err(|e| color_eyre::eyre::eyre!("Failed to spawn server: {e}"))?;

    // Poll health check for up to 5 seconds
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if health_check(base_url).await {
            eprintln!("Server started.");
            return Ok(true);
        }
    }

    Err(color_eyre::eyre::eyre!(
        "Server did not become healthy within 5 seconds"
    ))
}

enum HealthStatus {
    Healthy,
    Unhealthy(u16),
    Unreachable,
}

async fn health_check_detailed(base_url: &str) -> HealthStatus {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return HealthStatus::Unreachable,
    };

    match client.get(format!("{base_url}/health")).send().await {
        Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
        Ok(resp) => HealthStatus::Unhealthy(resp.status().as_u16()),
        Err(_) => HealthStatus::Unreachable,
    }
}

async fn health_check(base_url: &str) -> bool {
    matches!(health_check_detailed(base_url).await, HealthStatus::Healthy)
}

fn restart_conflicting_server_enabled() -> bool {
    matches!(
        std::env::var("ZEROXZERO_TUI_RESTART_SERVER")
            .ok()
            .as_deref(),
        Some("1" | "true" | "yes")
    )
}

/// Kill the process listening on the given port (macOS/Linux).
fn kill_port_process(port: u16) {
    // Use lsof to find the PID, then kill it
    if let Ok(output) = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output()
    {
        if output.status.success() {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.trim().lines() {
                let pid = pid_str.trim();
                if !pid.is_empty() {
                    let _ = std::process::Command::new("kill")
                        .args(["-TERM", pid])
                        .output();
                }
            }
        }
    }
}

/// Find the server entry point relative to the TUI binary location.
/// Searches common monorepo layouts.
fn find_server_entry() -> Result<PathBuf> {
    // Strategy 1: relative to current exe (apps/tui/target/debug/tui → apps/server/src/index.ts)
    if let Ok(exe) = std::env::current_exe() {
        // Walk up from the exe to find the monorepo root
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            let candidate = d.join("apps").join("server").join("src").join("index.ts");
            if candidate.exists() {
                return Ok(candidate);
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }

    // Strategy 2: relative to cwd
    let cwd = std::env::current_dir()?;
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        let candidate = d.join("apps").join("server").join("src").join("index.ts");
        if candidate.exists() {
            return Ok(candidate);
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }

    // Strategy 3: check if 0x0 is installed globally
    if let Ok(output) = std::process::Command::new("which").arg("0x0").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }

    Err(color_eyre::eyre::eyre!(
        "Could not find server entry point. Set ZEROXZERO_URL to point to a running server."
    ))
}

/// Find the bun binary.
fn find_bun() -> Result<PathBuf> {
    // Check PATH
    if let Ok(output) = std::process::Command::new("which").arg("bun").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(PathBuf::from(path));
            }
        }
    }

    // Common locations
    for candidate in ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return Ok(p);
        }
    }

    // Check ~/.bun/bin/bun
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".bun").join("bin").join("bun");
        if p.exists() {
            return Ok(p);
        }
    }

    Err(color_eyre::eyre::eyre!(
        "Could not find bun. Install bun or start the server manually."
    ))
}

/// Extract port from a URL like "http://localhost:4096".
fn extract_port(url: &str) -> u16 {
    url.rsplit(':')
        .next()
        .and_then(|s| s.trim_end_matches('/').parse().ok())
        .unwrap_or(4096)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_port_from_url() {
        assert_eq!(extract_port("http://localhost:4096"), 4096);
        assert_eq!(extract_port("http://127.0.0.1:8080"), 8080);
        assert_eq!(extract_port("http://localhost:4096/"), 4096);
    }

    #[test]
    fn extract_port_default() {
        assert_eq!(extract_port("http://localhost"), 4096);
    }

    #[test]
    fn restart_conflicting_server_disabled_by_default() {
        unsafe {
            std::env::remove_var("ZEROXZERO_TUI_RESTART_SERVER");
        }
        assert!(!restart_conflicting_server_enabled());
    }

    #[test]
    fn restart_conflicting_server_can_be_enabled() {
        unsafe {
            std::env::set_var("ZEROXZERO_TUI_RESTART_SERVER", "1");
        }
        assert!(restart_conflicting_server_enabled());
        unsafe {
            std::env::remove_var("ZEROXZERO_TUI_RESTART_SERVER");
        }
    }
}
