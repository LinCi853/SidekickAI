use super::download::{parse_requested_binding,validate_download_response};
use std::io::{Read,Write};
use std::net::TcpListener;

fn ready_fixture() -> (super::ReadyDistribution,super::BodyDescriptor,std::path::PathBuf) {
    let directory = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("distribution-ready").unwrap());
    std::fs::create_dir(&directory).unwrap();
    let source = directory.join("application.zip"); std::fs::write(&source,b"pinned archive").unwrap();
    let body = serde_json::from_value(serde_json::json!({"protocolVersion":1,"productId":"sidekickai","edition":"community",
        "productVersion":"0.1.5","variant":"installed","platform":"windows","nativeArchitectures":["x64"],"maintenanceProtocolVersion":1,
        "recoveryProtocolVersion":1,"archive":null,"files":[],"components":[]})).unwrap();
    let value = super::PreparedDistribution {source_path:source.to_string_lossy().into_owned(),body_proof:String::new(),product_version:"0.1.5".into(),
        native_architecture:"x64".into(),release_id:String::new(),release_sha256:String::new(),release_proof:String::new()};
    (super::ReadyDistribution {value,directory:directory.clone(),_source:Some(super::pin_file(&source).unwrap())},body,directory)
}

#[test]
fn cancellation_and_ready_commit_cannot_leave_an_admitted_source() {
    use std::sync::{Arc,Barrier};
    use std::sync::atomic::Ordering;
    for _ in 0..16 {
        super::clear_ready();
        super::CURRENT_BODY.lock().unwrap().take();
        super::CANCELLED.store(false,Ordering::SeqCst); super::ACTIVE.store(true,Ordering::SeqCst);
        let (ready,body,directory) = ready_fixture();
        let barrier = Arc::new(Barrier::new(2));
        let cancel_barrier = barrier.clone();
        let cancel = std::thread::spawn(move || {cancel_barrier.wait(); assert!(super::cancel());});
        barrier.wait();
        let result = super::commit_ready(ready,body);
        cancel.join().unwrap();
        assert!(super::ready().unwrap().is_none());
        assert!(super::product_version().is_none());
        assert!(!directory.exists());
        assert!(result.is_ok() || result.unwrap_err().contains("已取消"));
    }
    let (ready,body,directory) = ready_fixture();
    super::CANCELLED.store(false,Ordering::SeqCst);
    super::commit_ready(ready,body).unwrap();
    super::ACTIVE.store(false,Ordering::SeqCst);
    assert!(super::cancel(),"completed preparation remains withdrawable before installation");
    assert!(super::ready().unwrap().is_none()); assert!(super::product_version().is_none()); assert!(!directory.exists());
    super::CANCELLED.store(false,Ordering::SeqCst);
}


fn response(status:&str,headers:&str)->reqwest::blocking::Response {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap(); let address=listener.local_addr().unwrap();
    let reply=format!("HTTP/1.1 {status}\r\n{headers}\r\nConnection: close\r\n\r\n");
    std::thread::spawn(move||{let(mut stream,_)=listener.accept().unwrap();let mut request=[0;4096];stream.read(&mut request).unwrap();stream.write_all(reply.as_bytes()).unwrap();});
    reqwest::blocking::Client::new().get(format!("http://{address}")).send().unwrap()
}

#[test]
fn precise_release_cli_requires_one_complete_binding() {
    let id="01950455-7587-4dd0-8d2f-5d8f5684b4bf"; let digest="a".repeat(64);
    assert!(parse_requested_binding(&[]).unwrap().is_none());
    assert!(parse_requested_binding(&["--release-id".into(),id.into()]).is_err());
    assert!(parse_requested_binding(&["--release-id".into(),id.into(),"--release-id".into(),id.into(),"--release-sha256".into(),digest.clone()]).is_err());
    assert_eq!(parse_requested_binding(&["--release-id".into(),id.into(),"--release-sha256".into(),digest.clone()]).unwrap(),Some((id.into(),digest)));
    assert!(super::validate_arguments(&["--release-id".into(),id.into(),"--release-sha256".into(),"a".repeat(64),"--release-proof".into(),"relative.json".into()]).is_err());
    assert!(super::validate_arguments(&["--release-id".into(),id.into(),"--release-sha256".into(),"a".repeat(64),"--uninstall".into(),"ignored".into()]).is_err());
}

#[test]
fn resume_requires_exact_etag_range_and_representation_size() {
    let digest="a".repeat(64); let tag=format!("ETag: \"{digest}\"\r\n");
    let valid=response("206 Partial Content",&format!("{tag}Content-Length: 4\r\nContent-Range: bytes 6-9/10\r\n"));
    assert!(validate_download_response(&valid,6,10,&digest).unwrap());
    let restart=response("200 OK",&format!("{tag}Content-Length: 10\r\n"));
    assert!(!validate_download_response(&restart,6,10,&digest).unwrap());
    for headers in [format!("{tag}Content-Length: 4\r\nContent-Range: bytes 0-3/10\r\n"),
        format!("ETag: W/\"{digest}\"\r\nContent-Length: 4\r\nContent-Range: bytes 6-9/10\r\n"),
        format!("{tag}Content-Length: 5\r\nContent-Range: bytes 6-9/10\r\n"),
        format!("{tag}Content-Length: 4\r\nContent-Range: bytes 6-9/10\r\nContent-Encoding: gzip\r\n")] {
        assert!(validate_download_response(&response("206 Partial Content",&headers),6,10,&digest).is_err());
    }
}
