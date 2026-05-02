use quilin_mesh_sdk::{
    AgentCapability, AgentCard, AgentId, AgentIdentity, AuditFields, MeshDispatchPreflightReport,
    MeshError, MeshRequest, MeshResult,
};

fn audit(actor: &AgentId, action: &str, at_unix_ms: u64) -> AuditFields {
    AuditFields::new(actor.clone(), action, at_unix_ms).expect("audit fields should be valid")
}

fn capability(name: &str) -> AgentCapability {
    AgentCapability::new(name, "local test capability").expect("capability should be valid")
}

fn card(agent_id: &str) -> AgentCard {
    card_with_capabilities(agent_id, vec![capability("test.echo")])
}

fn card_with_capabilities(agent_id: &str, capabilities: Vec<AgentCapability>) -> AgentCard {
    let id = AgentId::new(agent_id).expect("agent id should be valid");
    let identity =
        AgentIdentity::new(id.clone(), "Local Test Agent").expect("identity should be valid");

    AgentCard::new(
        identity,
        capabilities,
        audit(&id, "publish_card", 1_777_676_400_000),
    )
    .expect("card should be valid")
}

fn assert_preflight_rejection<T: std::fmt::Debug>(
    result: MeshResult<T>,
    code: &str,
    message: &str,
) {
    let error = result.expect_err("preflight should reject");

    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), message);
    assert_eq!(
        error,
        MeshError::PreflightRejected {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    );
}

#[test]
fn agent_card_accepts_valid_identity_capabilities_and_audit() {
    let id = AgentId::new("worker-a").expect("agent id should be valid");
    let card = AgentCard::new(
        AgentIdentity::new(id.clone(), "Worker A").expect("identity should be valid"),
        vec![capability("test.echo"), capability("test.plan")],
        audit(&id, "publish_card", 1),
    )
    .expect("card should be valid");

    assert!(card.supports_capability("test.echo"));
    assert!(card.supports_capability("test.plan"));
    assert!(!card.supports_capability("test.missing"));
    assert_eq!(card.audit.actor.as_str(), "worker-a");
    assert_eq!(card.audit.action, "publish_card");
    assert_eq!(card.audit.at_unix_ms, 1);
}

#[test]
fn local_capability_discovery_reports_supported_and_missing_capabilities() {
    let card = card_with_capabilities(
        "worker-a",
        vec![capability("test.echo"), capability("test.plan")],
    );
    let discovery = card.capability_discovery();

    assert!(discovery.supports("test.echo"));
    assert!(card.supports_capability("test.plan"));
    assert_eq!(
        card.require_capability("test.echo")
            .map(|capability| capability.name.as_str()),
        Ok("test.echo")
    );
    assert_eq!(
        card.capability("test.plan")
            .map(|capability| capability.description.as_str()),
        Some("local test capability")
    );

    assert!(!discovery.supports("test.missing"));
    assert_eq!(
        discovery.require("test.missing"),
        Err(MeshError::UnsupportedCapability {
            capability: "test.missing".to_owned()
        })
    );
}

#[test]
fn local_capability_discovery_lists_capability_names_sorted_without_reordering_card() {
    let card = card_with_capabilities(
        "worker-a",
        vec![
            capability("test.plan"),
            capability("test.echo"),
            capability("test.review"),
        ],
    );

    assert_eq!(
        card.capability_names(),
        vec!["test.echo", "test.plan", "test.review"]
    );
    assert_eq!(
        card.capability_discovery().capability_names(),
        vec!["test.echo", "test.plan", "test.review"]
    );
    assert_eq!(card.capabilities[0].name, "test.plan");
}

#[test]
fn mesh_request_validate_for_card_accepts_supported_capability() {
    let local_card = card("worker-a");
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest::new(
        local_card.identity.id.clone(),
        "test.echo",
        Vec::new(),
        audit(&caller, "dispatch_start", 1),
    )
    .expect("request should be valid");

    assert_eq!(request.validate_for_card(&local_card), Ok(()));
}

#[test]
fn mesh_request_validate_for_card_rejects_unsupported_capability() {
    let local_card = card("worker-a");
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest::new(
        local_card.identity.id.clone(),
        "test.missing",
        Vec::new(),
        audit(&caller, "dispatch_start", 1),
    )
    .expect("request should be valid");

    assert_eq!(
        request.validate_for_card(&local_card),
        Err(MeshError::UnsupportedCapability {
            capability: "test.missing".to_owned()
        })
    );
}

#[test]
fn mesh_request_validate_for_card_reports_duplicate_card_before_unsupported_capability() {
    let id = AgentId::new("worker-a").expect("agent id should be valid");
    let duplicate_card = AgentCard {
        identity: AgentIdentity::new(id.clone(), "Local Test Agent")
            .expect("identity should be valid"),
        capabilities: vec![capability("test.echo"), capability("test.echo")],
        audit: audit(&id, "publish_card", 1),
    };
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest::new(
        duplicate_card.identity.id.clone(),
        "test.missing",
        Vec::new(),
        audit(&caller, "dispatch_start", 1),
    )
    .expect("request should be valid");

    assert_eq!(
        request.validate_for_card(&duplicate_card),
        Err(MeshError::DuplicateCapability {
            name: "test.echo".to_owned()
        })
    );
}

#[test]
fn mesh_request_validate_for_card_rejects_invalid_capability_string() {
    let local_card = card("worker-a");
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest {
        target: local_card.identity.id.clone(),
        capability: " ".to_owned(),
        payload: Vec::new(),
        audit: audit(&caller, "dispatch_start", 1),
    };

    assert_eq!(
        request.validate_for_card(&local_card),
        Err(MeshError::InvalidField {
            field: "capability"
        })
    );
}

#[test]
fn dispatch_preflight_report_marks_supported_request() {
    let local_card = card("worker-a");
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest::new(
        local_card.identity.id.clone(),
        "test.echo",
        Vec::new(),
        audit(&caller, "dispatch_start", 1),
    )
    .expect("request should be valid");

    let report = request.dispatch_preflight_report(&local_card);

    assert_eq!(
        report,
        MeshDispatchPreflightReport {
            supported: true,
            target: local_card.identity.id.clone(),
            capability: "test.echo".to_owned(),
            available_capabilities: vec!["test.echo".to_owned()],
            error_code: None,
            error_message: None,
        }
    );
    assert_eq!(report.ensure_supported(), Ok(()));
}

#[test]
fn dispatch_preflight_report_marks_unsupported_capability() {
    let local_card = card_with_capabilities(
        "worker-a",
        vec![capability("test.plan"), capability("test.echo")],
    );
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest::new(
        local_card.identity.id.clone(),
        "test.missing",
        Vec::new(),
        audit(&caller, "dispatch_start", 1),
    )
    .expect("request should be valid");

    let report = request.dispatch_preflight_report(&local_card);

    assert_eq!(
        report,
        MeshDispatchPreflightReport {
            supported: false,
            target: local_card.identity.id.clone(),
            capability: "test.missing".to_owned(),
            available_capabilities: vec!["test.echo".to_owned(), "test.plan".to_owned()],
            error_code: Some("unsupported_capability".to_owned()),
            error_message: Some("unsupported capability: test.missing".to_owned()),
        }
    );
    assert_preflight_rejection(
        report.ensure_supported(),
        "unsupported_capability",
        "unsupported capability: test.missing",
    );
}

#[test]
fn dispatch_preflight_report_marks_invalid_request() {
    let local_card = card("worker-a");
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest {
        target: local_card.identity.id.clone(),
        capability: " ".to_owned(),
        payload: Vec::new(),
        audit: audit(&caller, "dispatch_start", 1),
    };

    let report = request.dispatch_preflight_report(&local_card);

    assert_eq!(
        report,
        MeshDispatchPreflightReport {
            supported: false,
            target: local_card.identity.id.clone(),
            capability: " ".to_owned(),
            available_capabilities: vec!["test.echo".to_owned()],
            error_code: Some("invalid_field".to_owned()),
            error_message: Some("invalid required field: capability".to_owned()),
        }
    );
    assert_preflight_rejection(
        report.ensure_supported(),
        "invalid_field",
        "invalid required field: capability",
    );
}

#[test]
fn dispatch_preflight_report_marks_duplicate_card() {
    let id = AgentId::new("worker-a").expect("agent id should be valid");
    let duplicate_card = AgentCard {
        identity: AgentIdentity::new(id.clone(), "Local Test Agent")
            .expect("identity should be valid"),
        capabilities: vec![capability("test.echo"), capability("test.echo")],
        audit: audit(&id, "publish_card", 1),
    };
    let caller = AgentId::new("supervisor").expect("caller id should be valid");
    let request = MeshRequest::new(
        duplicate_card.identity.id.clone(),
        "test.echo",
        Vec::new(),
        audit(&caller, "dispatch_start", 1),
    )
    .expect("request should be valid");

    let report = request.dispatch_preflight_report(&duplicate_card);

    assert_eq!(
        report,
        MeshDispatchPreflightReport {
            supported: false,
            target: duplicate_card.identity.id.clone(),
            capability: "test.echo".to_owned(),
            available_capabilities: vec!["test.echo".to_owned(), "test.echo".to_owned()],
            error_code: Some("duplicate_capability".to_owned()),
            error_message: Some("duplicate agent capability: test.echo".to_owned()),
        }
    );
    assert_preflight_rejection(
        report.ensure_supported(),
        "duplicate_capability",
        "duplicate agent capability: test.echo",
    );
}

#[test]
fn agent_card_rejects_empty_identity_and_capabilities() {
    assert_eq!(
        AgentId::new("   "),
        Err(MeshError::InvalidField { field: "agent_id" })
    );

    let id = AgentId::new("worker-a").expect("agent id should be valid");
    let identity = AgentIdentity::new(id.clone(), "Worker A").expect("identity should be valid");
    let audit = audit(&id, "publish_card", 1);

    assert_eq!(
        AgentCard::new(identity, vec![], audit),
        Err(MeshError::InvalidField {
            field: "capabilities"
        })
    );
}

#[test]
fn agent_card_rejects_duplicate_capabilities_and_audit_actor_mismatch() {
    let id = AgentId::new("worker-a").expect("agent id should be valid");
    let identity = AgentIdentity::new(id.clone(), "Worker A").expect("identity should be valid");
    let publish_audit = audit(&id, "publish_card", 1);

    assert_eq!(
        AgentCard::new(
            identity.clone(),
            vec![capability("test.echo"), capability("test.echo")],
            publish_audit
        ),
        Err(MeshError::DuplicateCapability {
            name: "test.echo".to_owned()
        })
    );

    let wrong_actor = AgentId::new("supervisor").expect("agent id should be valid");
    assert_eq!(
        AgentCard::new(
            identity,
            vec![capability("test.echo")],
            audit(&wrong_actor, "publish_card", 1)
        ),
        Err(MeshError::AuditActorMismatch {
            expected: id,
            actual: wrong_actor
        })
    );
}
