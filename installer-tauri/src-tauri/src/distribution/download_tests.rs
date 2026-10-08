use super::*;
use std::net::TcpListener;
use std::sync::mpsc;
#[test]
fn periodic_chunks_outlive_the_read_timeout_without_truncation() {
    let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let headers = reply(&selection,"200 OK",10,None);
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap(); let mut request = [0;4096]; stream.read(&mut request).unwrap();
        stream.write_all(headers.as_bytes()).unwrap();
        for chunk in BYTES.chunks(2) {
            std::thread::sleep(Duration::from_millis(50));
            stream.write_all(chunk).unwrap();
        }
    });
    let client = Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_millis(150)).build().unwrap();
    let started = std::time::Instant::now();
    let path = download_asset_using(&client,&selection,origin,&fixture.0,&|_|{},&cancelled).unwrap();
    handle.join().unwrap();
    assert!(started.elapsed() > Duration::from_millis(200));
    assert_eq!(fs::read(path).unwrap(),BYTES);
}

#[test]
fn cancellation_of_a_stalled_read_returns_within_the_read_timeout() {
    let selection = selection(); let fixture = Fixture::new(); let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let headers = reply(&selection,"200 OK",10,None);
    let (received, receive) = mpsc::channel();
    let cancellation = cancelled.clone();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap(); let mut request = [0;4096]; stream.read(&mut request).unwrap();
        stream.write_all(headers.as_bytes()).unwrap(); received.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        cancellation.store(true,Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(300));
    });
    let client = Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_millis(100)).build().unwrap();
    let started = std::time::Instant::now();
    assert!(download_asset_using(&client,&selection,origin,&fixture.0,&|_|{},&cancelled).is_err());
    receive.recv().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    handle.join().unwrap();
    assert!(fixture.part(&selection).exists());
}


const BYTES: &[u8] = b"abcdefghij";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(sidekickai_uninstall_core::random_id("distribution-transfer").unwrap());
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn part(&self, selection: &Selection) -> PathBuf { self.0.join(format!("{}.part", selection.asset.asset_id)) }
    fn seed(&self, selection: &Selection, origin: &Url, bytes: &[u8]) {
        fs::write(self.part(selection), bytes).unwrap();
        save_json(&self.0.join(format!("{}.json", selection.asset.asset_id)), &DownloadIdentity::new(selection, origin).unwrap()).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

fn selection() -> Selection {
    let digest = format!("{:x}", Sha256::digest(BYTES));
    let asset: contract::ReleaseAsset = serde_json::from_value(serde_json::json!({
        "assetId":digest,"role":"application-payload","filename":"payload.zip","sizeBytes":BYTES.len(),"sha256":digest,
        "contentType":"application/zip","executableArchitecture":null,"supportedNativeArchitectures":["x64"],
        "bodyProofSha256":"b".repeat(64)
    })).unwrap();
    let release: contract::ReleaseDescriptor = serde_json::from_value(serde_json::json!({
        "protocolVersion":1,"productId":"sidekickai","edition":"community","productVersion":"0.1.5",
        "releaseId":"01950455-7587-4dd0-8d2f-5d8f5684b4bf","channel":"stable","platform":"windows",
        "maintenanceProtocolVersion":1,"recoveryProtocolVersion":1,"assets":[asset],"publicAssetIds":[],
        "architectureEvidence":[],"notes":"","createdAt":"2026-10-08T00:00:00Z"
    })).unwrap();
    Selection { release, envelope: contract::SignedEnvelope { payload:serde_json::json!({}), signature:String::new() }, digest:"c".repeat(64), asset }
}

fn server(replies: Vec<(String, Vec<u8>)>) -> (Url, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = Url::parse(&format!("http://{}/",listener.local_addr().unwrap())).unwrap();
    let (sender, requests) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        for (headers, bytes) in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0;1024];
            while !request.windows(4).any(|bytes|bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 { break; }
                request.extend_from_slice(&buffer[..count]);
            }
            sender.send(String::from_utf8(request).unwrap().to_ascii_lowercase()).unwrap();
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    (origin, requests, handle)
}

fn reply(selection: &Selection, status: &str, length: u64, range: Option<&str>) -> String {
    let range = range.map(|value|format!("Content-Range: {value}\r\n")).unwrap_or_default();
    format!("HTTP/1.1 {status}\r\nETag: \"{}\"\r\nContent-Length: {length}\r\n{range}Connection: close\r\n\r\n", selection.asset.sha256)
}

#[test]
fn interrupted_transfer_resumes_exact_bytes_and_headers() {
    let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let (origin, requests, handle) = server(vec![
        (reply(&selection,"200 OK",10,None),BYTES[..6].to_vec()),
        (reply(&selection,"206 Partial Content",4,Some("bytes 6-9/10")),BYTES[6..].to_vec())
    ]);
    let path = download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).unwrap();
    handle.join().unwrap();
    assert_eq!(fs::read(path).unwrap(),BYTES);
    let first = requests.recv().unwrap(); let resumed = requests.recv().unwrap();
    for request in [&first,&resumed] {
        assert!(request.contains("cache-control: no-store\r\n"));
        assert!(request.contains("accept-encoding: identity\r\n"));
    }
    assert!(!first.contains("range:"));
    assert!(resumed.contains("range: bytes=6-\r\n"));
    assert!(resumed.contains(&format!("if-range: \"{}\"\r\n",selection.asset.sha256)));
}

#[test]
fn full_response_restarts_a_partial_instead_of_appending() {
    let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let (origin,requests,handle) = server(vec![(reply(&selection,"200 OK",10,None),BYTES.to_vec())]);
    fixture.seed(&selection,&origin,&BYTES[..6]);
    let path = download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).unwrap();
    handle.join().unwrap();
    assert!(requests.recv().unwrap().contains("range: bytes=6-\r\n"));
    assert_eq!(fs::read(path).unwrap(),BYTES);
}

#[test]
fn cancellation_retains_bound_fragments_for_a_new_attempt() {
    let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let (origin,requests,handle) = server(vec![
        (reply(&selection,"200 OK",10,None),BYTES[..6].to_vec()),
        (reply(&selection,"206 Partial Content",4,Some("bytes 6-9/10")),BYTES[6..].to_vec())
    ]);
    let error = download_asset_at(&selection,origin.clone(),&fixture.0,&|_|cancelled.store(true,Ordering::SeqCst),&cancelled).unwrap_err();
    assert!(error.contains("已取消"));
    assert_eq!(fs::read(fixture.part(&selection)).unwrap(),BYTES[..6]);
    cancelled.store(false,Ordering::SeqCst);
    let path = download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).unwrap();
    handle.join().unwrap();
    requests.recv().unwrap();
    assert!(requests.recv().unwrap().contains("range: bytes=6-\r\n"));
    assert_eq!(fs::read(path).unwrap(),BYTES);
}

#[test]
fn complete_fragment_is_promoted_without_a_range_request() {
    let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let origin = Url::parse("http://127.0.0.1:1/").unwrap();
    fixture.seed(&selection,&origin,BYTES);
    let path = download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).unwrap();
    assert_eq!(fs::read(path).unwrap(),BYTES);
    assert!(!fixture.part(&selection).exists());
}

#[test]
fn changed_release_binding_discards_the_previous_fragment() {
    let mut selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let (origin,requests,handle) = server(vec![(reply(&selection,"200 OK",10,None),BYTES.to_vec())]);
    fixture.seed(&selection,&origin,&BYTES[..6]);
    selection.digest = "d".repeat(64);
    let path = download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).unwrap();
    handle.join().unwrap();
    assert!(!requests.recv().unwrap().contains("range:"));
    assert_eq!(fs::read(path).unwrap(),BYTES);
}

#[test]
fn withdrawn_asset_and_invalid_representation_discard_partial_bytes() {
    for status in ["404 Not Found","416 Range Not Satisfiable"] {
        let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
        let (origin,requests,handle) = server(vec![(reply(&selection,status,0,None),Vec::new())]);
        fixture.seed(&selection,&origin,&BYTES[..6]);
        assert!(download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).is_err());
        handle.join().unwrap(); requests.recv().unwrap();
        assert!(!fixture.part(&selection).exists());
    }
    let selection = selection(); let fixture = Fixture::new(); let cancelled = AtomicBool::new(false);
    let invalid = reply(&selection,"200 OK",10,None).replace(&selection.asset.sha256,&"e".repeat(64));
    let (origin,requests,handle) = server(vec![(invalid,BYTES.to_vec())]);
    fixture.seed(&selection,&origin,&BYTES[..6]);
    assert!(download_asset_at(&selection,origin,&fixture.0,&|_|{},&cancelled).is_err());
    handle.join().unwrap(); requests.recv().unwrap();
    assert!(!fixture.part(&selection).exists());
}
