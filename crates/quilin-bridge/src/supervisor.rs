use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use anyhow::{Context, Result};
use once_cell::sync::Lazy;

pub struct ProcessSupervisor {
    bun_process: Mutex<Option<Child>>,
    /// agent-core 启动后解析 stdout 获得的 dashboard 端口
    dashboard_port: Mutex<Option<u16>>,
}

impl ProcessSupervisor {
    pub const fn new() -> Self {
        Self {
            bun_process: Mutex::new(None),
            dashboard_port: Mutex::new(None),
        }
    }

    pub fn get_dashboard_port(&self) -> Option<u16> {
        *self.dashboard_port.lock().unwrap()
    }

    pub fn start_core(&self, workspace_root: &str) -> Result<()> {
        let mut guard = self.bun_process.lock().unwrap();
        if guard.is_some() {
            // Check if it's still running
            let is_alive = {
                let child = guard.as_mut().unwrap();
                match child.try_wait() {
                    Ok(None) => true, // Still running
                    _ => false,       // Exited or error
                }
            };
            if is_alive {
                return Ok(()); // Already running
            }
        }

        println!("[Rust Supervisor] Starting Bun agent-core from {}", workspace_root);

        // Note: For a production app, we would use a more robust way to find the `bun` executable
        // and handle stdout/stderr (e.g., streaming logs to the Mac App UI).
        // macOS app 启动时 PATH 很精简，手动补充常见的包管理器路径
        let base_path = std::env::var("PATH").unwrap_or_default();
        let extended_path = format!(
            "{}:{}/.bun/bin:/usr/local/bin:/opt/homebrew/bin",
            base_path,
            std::env::var("HOME").unwrap_or_default()
        );

        // 重置端口，防止上次残留
        *self.dashboard_port.lock().unwrap() = None;

        let mut child = Command::new("bun")
            .current_dir(workspace_root)
            .env("PATH", extended_path)
            // stdout/stderr 被 pipe 后 isTTY=false，agent-core 会误判为 service 模式
            // 导致 dashboard 不启动。显式指定 repl 模式确保 dashboard 始终启动。
            .env("QUILIN_RUNTIME_MODE", "repl")
            .arg("packages/agent-core/src/index.ts")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Failed to spawn bun process. Is 'bun' in PATH?")?;

        // 后台线程读取 stdout，解析 dashboard 端口
        // agent-core 日志格式：{"url":"http://127.0.0.1:PORT",...}
        if let Some(stdout) = child.stdout.take() {
            // 使用 Arc<Mutex> 的引用通过 SUPERVISOR 静态变量写回端口
            // 这里用 std::thread 避免 tokio 依赖
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(|l| l.ok()) {
                    // 匹配 pino JSON 日志：{"url":"http://127.0.0.1:PORT",...}
                    // 或 plain 文本日志："Web dashboard started" 配合 url 字段
                    if line.contains("Web dashboard started") || line.contains("\"url\"") {
                        // 尝试从行中提取端口号
                        // 匹配 http://127.0.0.1:PORT 或 http://localhost:PORT
                        if let Some(port) = extract_port_from_log(&line) {
                            *SUPERVISOR.dashboard_port.lock().unwrap() = Some(port);
                            println!("[Rust Supervisor] Dashboard port detected: {}", port);
                        }
                    }
                }
            });
        }

        // pino dev 模式下所有日志（包括 "Web dashboard started"）都输出到 stderr。
        // 因此 stderr 既要持续排空（防止管道阻塞），也要解析端口。
        // pino-pretty 格式下 URL 可能在 "Web dashboard started" 的同一行或紧随的下几行。
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                // 检测到 "Web dashboard started" 后，在接下来最多 5 行内寻找 URL
                let mut lines_to_scan: u8 = 0;
                for line in reader.lines().map_while(|l| l.ok()) {
                    eprintln!("[agent-core stderr] {}", line);
                    // 同行含 URL 的情况（JSON 模式或 plain 模式）
                    if line.contains("Web dashboard started") || line.contains("\"url\"") {
                        if let Some(port) = extract_port_from_log(&line) {
                            *SUPERVISOR.dashboard_port.lock().unwrap() = Some(port);
                            println!("[Rust Supervisor] Dashboard port detected (stderr): {}", port);
                            lines_to_scan = 0;
                            continue;
                        }
                        // URL 不在同行，开启后续扫描窗口
                        if line.contains("Web dashboard started") {
                            lines_to_scan = 5;
                        }
                    }
                    // 扫描窗口内：每行都尝试提取 URL/端口
                    if lines_to_scan > 0 {
                        lines_to_scan -= 1;
                        if let Some(port) = extract_port_from_log(&line) {
                            *SUPERVISOR.dashboard_port.lock().unwrap() = Some(port);
                            println!("[Rust Supervisor] Dashboard port detected (stderr): {}", port);
                            lines_to_scan = 0;
                        }
                    }
                }
            });
        }

        *guard = Some(child);
        Ok(())
    }

    pub fn stop_core(&self) -> Result<()> {
        let mut guard = self.bun_process.lock().unwrap();
        if let Some(mut child) = guard.take() {
            println!("[Rust Supervisor] Stopping Bun agent-core...");
            let _ = child.kill();
            let _ = child.wait();
        }
        // 停止后清除端口
        *self.dashboard_port.lock().unwrap() = None;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let mut guard = self.bun_process.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    // Process exited
                    *guard = None;
                    false
                }
                Ok(None) => true, // Still running
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

pub static SUPERVISOR: Lazy<ProcessSupervisor> = Lazy::new(|| ProcessSupervisor::new());

/// 从日志行中提取端口号
/// 支持格式：
/// - http://127.0.0.1:PORT
/// - http://localhost:PORT
/// - "port":PORT (JSON)
fn extract_port_from_log(line: &str) -> Option<u16> {
    // 先尝试匹配 URL 格式
    for prefix in &["http://127.0.0.1:", "http://localhost:"] {
        if let Some(pos) = line.find(prefix) {
            let rest = &line[pos + prefix.len()..];
            let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(port) = port_str.parse::<u16>() {
                if port > 0 {
                    return Some(port);
                }
            }
        }
    }
    // 再尝试匹配 JSON "port": PORT 格式
    if let Some(pos) = line.find("\"port\":") {
        let rest = line[pos + 7..].trim_start();
        let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(port) = port_str.parse::<u16>() {
            if port > 0 {
                return Some(port);
            }
        }
    }
    None
}
