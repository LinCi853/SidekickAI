use super::*;
use std::fs;

#[path = "../../test-fixtures.rs"]
mod edition_fixtures;

struct Fixture(PathBuf);
impl Fixture {
    fn new(edition: &str) -> Self {
        let root = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("startup-maintenance").unwrap());
        fs::create_dir_all(root.join("resources")).unwrap();
        let package = &product::product().editions[edition].package_name;
        fs::write(root.join("resources/app.asar"), edition_fixtures::archive_for(package, b"application")).unwrap();
        Self(root)
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn no_owned_task_never_requests_mutation() {
    let fixture = Fixture::new("community");
    let mut operations = Vec::new();
    let mut runner = |request: &Value| {
        operations.push(request["operation"].as_str().unwrap().to_owned());
        assert_eq!(request["executable"], json!(fixture.0.join("SidekickAI.exe")));
        assert_eq!(request.as_object().unwrap().len(), 2);
        Ok(json!({ "tasks": 0 }))
    };
    remove_with(&fixture.0, &mut runner).unwrap();
    assert_eq!(operations, ["inspect-installation"]);
}

#[test]
fn cleanup_uses_the_fixed_installation_operation() {
    let fixture = Fixture::new("community");
    let mut operations = Vec::new();
    let mut runner = |request: &Value| {
        let operation = request["operation"].as_str().unwrap();
        operations.push(operation.to_owned());
        Ok(if operation == "inspect-installation" { json!({ "tasks": 2 }) } else { json!({ "ok": true }) })
    };
    remove_with(&fixture.0, &mut runner).unwrap();
    assert_eq!(operations, ["inspect-installation", "remove-installation"]);
}

#[test]
fn foreign_or_unknown_installations_never_invoke_the_helper() {
    let fixture = Fixture::new("concept");
    let mut runner = |_request: &Value| -> Result<Value, String> { panic!("foreign installation"); };
    maintain_with(&fixture.0, &mut runner).unwrap();
    remove_with(&fixture.0, &mut runner).unwrap();
    remove_with(&fixture.0.join("missing"), &mut runner).unwrap();
}

#[test]
fn maintenance_is_read_only_and_reports_invalid_tasks() {
    let fixture = Fixture::new("community");
    let error = maintain_with(&fixture.0, &mut |request: &Value| {
        assert_eq!(request["operation"], "maintain");
        Err("task ownership validation failed".into())
    }).unwrap_err();
    assert!(error.contains("task ownership validation failed"));
    assert!(error.contains(fixture.0.to_string_lossy().as_ref()));
}

#[test]
fn invalid_probe_and_unconfirmed_cleanup_fail_closed() {
    let fixture = Fixture::new("community");
    for result in [json!({}), json!({ "tasks": -1 }), json!({ "tasks": "0" })] {
        assert!(remove_with(&fixture.0, &mut |_| Ok(result.clone())).is_err());
    }
    assert!(remove_with(&fixture.0, &mut |request| {
        Ok(if request["operation"] == "inspect-installation" { json!({ "tasks": 1 }) } else { json!({ "ok": false }) })
    }).is_err());
}

#[test]
fn empty_task_snapshot_does_not_need_a_system_operation() {
    let snapshot = TaskSnapshot::default();
    remove_snapshot(&snapshot).unwrap();
    restore_snapshot(&snapshot).unwrap();
}
