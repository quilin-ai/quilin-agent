#![forbid(unsafe_code)]

//! Minimal Agent Mesh (agent interconnection network) stub contract for
//! Iteration D (the Rust SDK stub iteration).
//!
//! 第 D 轮 Rust SDK stub（占位契约）使用的最小 Agent Mesh（Agent 互联网络）
//! 契约。
//!
//! This crate intentionally does not provide runtime dispatch, transport,
//! permission execution, or network behavior. Iteration F must add those
//! runtime pieces behind the project WriteAuthority (central write gate),
//! permission, trace, and audit contracts.
//!
//! 本 crate 有意不提供 runtime dispatch（运行时派发）、transport（传输）、
//! permission execution（权限执行）或网络行为。第 F 轮若要加入这些运行时
//! 能力，必须先接入项目 WriteAuthority（统一写入授权门）、权限、trace
//!（追踪）和 audit（审计）契约。

use std::error::Error;
use std::fmt;

/// Stable local Agent identifier.
///
/// 稳定的本机 Agent（智能体）标识符。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct AgentId(String);

impl AgentId {
    /// Builds an identifier after trimming and rejecting empty values.
    ///
    /// 构建标识符；会去掉首尾空白并拒绝空值。
    pub fn new(value: impl Into<String>) -> MeshResult<Self> {
        Ok(Self(required_text("agent_id", value.into())?))
    }

    /// Returns the identifier as text.
    ///
    /// 返回文本形式的标识符。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Human-readable identity attached to an Agent Card.
///
/// Agent Card（Agent 能力卡片）中的可读身份信息。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentIdentity {
    pub id: AgentId,
    pub display_name: String,
}

impl AgentIdentity {
    /// Creates an identity for card publication and audit trails.
    ///
    /// 创建用于能力卡片发布和审计链路的身份信息。
    pub fn new(id: AgentId, display_name: impl Into<String>) -> MeshResult<Self> {
        Ok(Self {
            id,
            display_name: required_text("display_name", display_name.into())?,
        })
    }

    /// Validates identity fields on values assembled outside constructors.
    ///
    /// 校验绕过构造函数组装出来的身份字段。
    pub fn validate(&self) -> MeshResult<()> {
        require_normalized_text("display_name", &self.display_name)
    }
}

/// Capability advertised by an Agent Card.
///
/// Agent Card（Agent 能力卡片）公开的一项能力。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCapability {
    pub name: String,
    pub description: String,
}

impl AgentCapability {
    /// Creates a named local capability.
    ///
    /// 创建一项具名本机能力。
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> MeshResult<Self> {
        Ok(Self {
            name: required_text("capability_name", name.into())?,
            description: required_text("capability_description", description.into())?,
        })
    }

    /// Validates capability fields on values assembled outside constructors.
    ///
    /// 校验绕过构造函数组装出来的能力字段。
    pub fn validate(&self) -> MeshResult<()> {
        require_normalized_text("capability_name", &self.name)?;
        require_normalized_text("capability_description", &self.description)
    }
}

/// Audit fields carried by cards and request envelopes.
///
/// 能力卡片和请求信封共同携带的审计字段。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditFields {
    pub actor: AgentId,
    pub action: String,
    pub at_unix_ms: u64,
}

impl AuditFields {
    /// Creates audit metadata with a caller-controlled timestamp.
    ///
    /// 创建审计元数据；时间戳由调用方提供，便于测试和跨运行时对齐。
    pub fn new(actor: AgentId, action: impl Into<String>, at_unix_ms: u64) -> MeshResult<Self> {
        let audit = Self {
            actor,
            action: required_text("audit_action", action.into())?,
            at_unix_ms,
        };

        audit.validate()?;

        Ok(audit)
    }

    /// Validates audit metadata before cards or request envelopes are published
    /// to a future runtime boundary.
    ///
    /// 在能力卡片或请求信封发布到未来运行时边界前校验审计元数据。
    pub fn validate(&self) -> MeshResult<()> {
        require_normalized_text("audit_action", &self.action)?;

        if self.at_unix_ms == 0 {
            return Err(MeshError::InvalidField {
                field: "audit_at_unix_ms",
            });
        }

        Ok(())
    }
}

/// Local Agent Card used for capability discovery.
///
/// 用于能力发现的本机 Agent Card（Agent 能力卡片）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCard {
    pub identity: AgentIdentity,
    pub capabilities: Vec<AgentCapability>,
    pub audit: AuditFields,
}

impl AgentCard {
    /// Creates a card and rejects empty capability lists.
    ///
    /// 创建能力卡片，并拒绝空能力列表。
    pub fn new(
        identity: AgentIdentity,
        capabilities: Vec<AgentCapability>,
        audit: AuditFields,
    ) -> MeshResult<Self> {
        let card = Self {
            identity,
            capabilities,
            audit,
        };

        card.validate()?;

        Ok(card)
    }

    /// Validates this card as a local capability publication contract.
    ///
    /// 将本卡片作为本机能力发布契约进行校验。
    pub fn validate(&self) -> MeshResult<()> {
        self.identity.validate()?;
        self.audit.validate()?;

        if self.audit.actor != self.identity.id {
            return Err(MeshError::AuditActorMismatch {
                expected: self.identity.id.clone(),
                actual: self.audit.actor.clone(),
            });
        }

        if self.capabilities.is_empty() {
            return Err(MeshError::InvalidField {
                field: "capabilities",
            });
        }

        let mut seen_names: Vec<&str> = Vec::with_capacity(self.capabilities.len());
        for capability in &self.capabilities {
            capability.validate()?;

            if seen_names.contains(&capability.name.as_str()) {
                return Err(MeshError::DuplicateCapability {
                    name: capability.name.clone(),
                });
            }

            seen_names.push(capability.name.as_str());
        }

        Ok(())
    }

    /// Returns a local capability discovery helper for dispatch preflight.
    ///
    /// 返回本机能力发现 helper，用于派发前预检查。
    pub fn capability_discovery(&self) -> LocalCapabilityDiscovery<'_> {
        LocalCapabilityDiscovery::new(self)
    }

    /// Returns advertised capability names in stable sorted order.
    ///
    /// 以稳定排序顺序返回已声明的能力名。
    pub fn capability_names(&self) -> Vec<&str> {
        self.capability_discovery().capability_names()
    }

    /// Finds an advertised capability by exact capability name.
    ///
    /// 按精确能力名查找已声明能力。
    pub fn capability(&self, capability: &str) -> Option<&AgentCapability> {
        self.capability_discovery().capability(capability)
    }

    /// Returns whether the card advertises a capability name.
    ///
    /// 返回能力卡片是否声明了指定能力名。
    pub fn supports_capability(&self, capability: &str) -> bool {
        self.capability_discovery().supports(capability)
    }

    /// Requires this card to advertise a capability before dispatch.
    ///
    /// 要求本卡片在派发前已声明指定能力。
    pub fn require_capability(&self, capability: &str) -> MeshResult<&AgentCapability> {
        self.capability_discovery().require(capability)
    }
}

/// Caller-facing report for Mesh dispatch preflight.
///
/// 面向调用方的 Mesh（Agent 互联网络）派发前预检查报告。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeshDispatchPreflightReport {
    pub supported: bool,
    pub target: AgentId,
    pub capability: String,
    pub available_capabilities: Vec<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl MeshDispatchPreflightReport {
    fn supported(target: AgentId, capability: String, available_capabilities: Vec<String>) -> Self {
        Self {
            supported: true,
            target,
            capability,
            available_capabilities,
            error_code: None,
            error_message: None,
        }
    }

    fn unsupported(
        target: AgentId,
        capability: String,
        available_capabilities: Vec<String>,
        error: MeshError,
    ) -> Self {
        Self {
            supported: false,
            target,
            capability,
            available_capabilities,
            error_code: Some(error.code().to_owned()),
            error_message: Some(error.to_string()),
        }
    }

    /// Returns Ok only when the stable preflight report supports dispatch.
    ///
    /// 仅当稳定预检查报告允许派发时返回 Ok。
    pub fn ensure_supported(&self) -> MeshResult<()> {
        if self.supported {
            return Ok(());
        }

        Err(MeshError::PreflightRejected {
            code: self
                .error_code
                .clone()
                .unwrap_or_else(|| "preflight_rejected".to_owned()),
            message: self
                .error_message
                .clone()
                .unwrap_or_else(|| "dispatch preflight rejected".to_owned()),
        })
    }
}

/// Borrowed helper for local Agent Card capability discovery.
///
/// 面向本机 Agent Card（Agent 能力卡片）能力发现的借用型 helper。
#[derive(Clone, Copy, Debug)]
pub struct LocalCapabilityDiscovery<'a> {
    card: &'a AgentCard,
}

impl<'a> LocalCapabilityDiscovery<'a> {
    /// Creates a helper over a published local Agent Card.
    ///
    /// 基于已发布的本机 Agent Card（Agent 能力卡片）创建 helper。
    pub fn new(card: &'a AgentCard) -> Self {
        Self { card }
    }

    /// Returns advertised capability names in stable sorted order.
    ///
    /// 以稳定排序顺序返回已声明的能力名。
    pub fn capability_names(&self) -> Vec<&'a str> {
        let mut names: Vec<&'a str> = self
            .card
            .capabilities
            .iter()
            .map(|capability| capability.name.as_str())
            .collect();
        names.sort_unstable();
        names
    }

    /// Finds an advertised capability by exact capability name.
    ///
    /// 按精确能力名查找已声明能力。
    pub fn capability(&self, capability: &str) -> Option<&'a AgentCapability> {
        self.card
            .capabilities
            .iter()
            .find(|candidate| candidate.name.as_str() == capability)
    }

    /// Returns whether the card advertises a capability name.
    ///
    /// 返回能力卡片是否声明了指定能力名。
    pub fn supports(&self, capability: &str) -> bool {
        self.capability(capability).is_some()
    }

    /// Returns the capability or an UnsupportedCapability preflight error.
    ///
    /// 返回能力；若缺失则给出派发前 UnsupportedCapability（不支持能力）错误。
    pub fn require(&self, capability: &str) -> MeshResult<&'a AgentCapability> {
        require_normalized_text("capability", capability)?;

        self.capability(capability)
            .ok_or_else(|| MeshError::UnsupportedCapability {
                capability: capability.to_owned(),
            })
    }
}

/// Request envelope validated against an AgentCard before future dispatch.
///
/// 在未来派发前按 AgentCard（Agent 能力卡片）校验的请求信封。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeshRequest {
    pub target: AgentId,
    pub capability: String,
    pub payload: Vec<u8>,
    pub audit: AuditFields,
}

impl MeshRequest {
    /// Creates a request for a target capability.
    ///
    /// 创建发往目标能力的请求。
    pub fn new(
        target: AgentId,
        capability: impl Into<String>,
        payload: Vec<u8>,
        audit: AuditFields,
    ) -> MeshResult<Self> {
        let request = Self {
            target,
            capability: required_text("capability", capability.into())?,
            payload,
            audit,
        };

        request.validate()?;

        Ok(request)
    }

    /// Validates request fields independent of a target card.
    ///
    /// 校验请求自身字段，不依赖目标能力卡片。
    pub fn validate(&self) -> MeshResult<()> {
        require_normalized_text("capability", &self.capability)?;
        self.audit.validate()
    }

    /// Validates that this request can be dispatched to the given local card.
    ///
    /// 校验本请求能否派发到指定本机能力卡片。
    pub fn validate_for_card(&self, card: &AgentCard) -> MeshResult<()> {
        self.validate()?;
        card.validate()?;

        if self.target != card.identity.id {
            return Err(MeshError::TargetMismatch {
                expected: card.identity.id.clone(),
                actual: self.target.clone(),
            });
        }

        card.require_capability(&self.capability)?;

        Ok(())
    }

    /// Builds a caller-facing dispatch preflight report for a target card.
    ///
    /// 为目标能力卡片构建面向调用方的派发前预检查报告。
    pub fn dispatch_preflight_report(&self, card: &AgentCard) -> MeshDispatchPreflightReport {
        let available_capabilities = card
            .capability_names()
            .into_iter()
            .map(str::to_owned)
            .collect();

        match self.validate_for_card(card) {
            Ok(()) => MeshDispatchPreflightReport::supported(
                self.target.clone(),
                self.capability.clone(),
                available_capabilities,
            ),
            Err(error) => MeshDispatchPreflightReport::unsupported(
                self.target.clone(),
                self.capability.clone(),
                available_capabilities,
                error,
            ),
        }
    }
}

/// Compatibility marker for future mesh implementations.
///
/// 未来 Mesh（Agent 互联网络）实现的兼容性标记。
pub trait Mesh {}

impl<T> Mesh for T where T: ?Sized {}

/// Shared result type for the Mesh SDK.
///
/// Mesh SDK（Mesh 开发工具包）的共享结果类型。
pub type MeshResult<T> = Result<T, MeshError>;

/// Errors surfaced by the non-runtime stub contract.
///
/// 非运行时 stub（占位契约）暴露的错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeshError {
    InvalidField { field: &'static str },
    DuplicateCapability { name: String },
    AuditActorMismatch { expected: AgentId, actual: AgentId },
    TargetMismatch { expected: AgentId, actual: AgentId },
    UnsupportedCapability { capability: String },
    PreflightRejected { code: String, message: String },
}

impl MeshError {
    /// Returns a stable machine-readable error code.
    ///
    /// 返回稳定、机器可读的错误代码。
    pub fn code(&self) -> &str {
        match self {
            Self::InvalidField { .. } => "invalid_field",
            Self::DuplicateCapability { .. } => "duplicate_capability",
            Self::AuditActorMismatch { .. } => "audit_actor_mismatch",
            Self::TargetMismatch { .. } => "target_mismatch",
            Self::UnsupportedCapability { .. } => "unsupported_capability",
            Self::PreflightRejected { code, .. } => code.as_str(),
        }
    }
}

impl fmt::Display for MeshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidField { field } => write!(formatter, "invalid required field: {field}"),
            Self::DuplicateCapability { name } => {
                write!(formatter, "duplicate agent capability: {name}")
            }
            Self::AuditActorMismatch { expected, actual } => write!(
                formatter,
                "audit actor mismatch: expected {expected}, got {actual}"
            ),
            Self::TargetMismatch { expected, actual } => {
                write!(
                    formatter,
                    "target mismatch: expected {expected}, got {actual}"
                )
            }
            Self::UnsupportedCapability { capability } => {
                write!(formatter, "unsupported capability: {capability}")
            }
            Self::PreflightRejected { message, .. } => formatter.write_str(message),
        }
    }
}

impl Error for MeshError {}

fn required_text(field: &'static str, value: String) -> MeshResult<String> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(MeshError::InvalidField { field });
    }

    Ok(trimmed.to_owned())
}

fn require_normalized_text(field: &'static str, value: &str) -> MeshResult<()> {
    if value.trim().is_empty() || value.trim() != value {
        return Err(MeshError::InvalidField { field });
    }

    Ok(())
}
