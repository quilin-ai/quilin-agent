uniffi::setup_scaffolding!();

mod supervisor;

#[derive(uniffi::Record)]
pub struct AgentStatus {
    pub is_running: bool,
    pub current_task: Option<String>,
}

#[uniffi::export]
pub fn get_status() -> AgentStatus {
    let running = supervisor::SUPERVISOR.is_running();
    AgentStatus {
        is_running: running,
        current_task: if running {
            Some("Agent core is running in background".to_string())
        } else {
            Some("Idle".to_string())
        },
    }
}

#[derive(uniffi::Error, thiserror::Error, Debug)]
pub enum AgentError {
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Starts the underlying Bun/TypeScript agent core.
/// `workspace_root` should be the absolute path to the `quilin-agent` repository.
#[uniffi::export]
pub fn start_agent(workspace_root: String) -> Result<(), AgentError> {
    supervisor::SUPERVISOR
        .start_core(&workspace_root)
        .map_err(|e| AgentError::Internal(format!("Failed to start agent: {}", e)))
}

/// Stops the underlying agent core if it is running.
#[uniffi::export]
pub fn stop_agent() -> Result<(), AgentError> {
    supervisor::SUPERVISOR
        .stop_core()
        .map_err(|e| AgentError::Internal(format!("Failed to stop agent: {}", e)))
}

/// Returns the dashboard HTTP port once agent-core has started and logged its URL.
/// Returns None if agent-core has not yet started or the port has not been detected.
#[uniffi::export]
pub fn get_dashboard_port() -> Option<u16> {
    supervisor::SUPERVISOR.get_dashboard_port()
}
