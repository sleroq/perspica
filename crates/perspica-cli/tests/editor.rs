#![cfg(unix)]

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "perspica-editor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn write(&self, name: &str, content: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    fn editor(&self, name: &str, script: &str) -> PathBuf {
        let path = self.write(name, script);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn git(&self, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(&self.0)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Server {
    child: Child,
    url: String,
    client: Client,
}

impl Server {
    async fn start(fixture: &Fixture, args: &[&str], env: &[(&str, &Path)]) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut command = Command::new(env!("CARGO_BIN_EXE_perspica"));
        command
            .current_dir(&fixture.0)
            .args(args)
            .args([
                "--web",
                "--no-open",
                "--no-sessions",
                "--fresh",
                "--port",
                &port.to_string(),
                "--provider",
                "openai",
                "--api-key",
                "offline-test-key",
            ])
            .env("HOME", &fixture.0)
            .env_remove("PERSPICA_EDITOR")
            .env_remove("VISUAL")
            .env_remove("EDITOR")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (name, value) in env {
            command.env(name, value);
        }
        let mut server = Self {
            child: command.spawn().unwrap(),
            url: format!("http://127.0.0.1:{port}"),
            client: Client::new(),
        };
        for _ in 0..250 {
            assert!(
                server.child.try_wait().unwrap().is_none(),
                "viewer exited before startup"
            );
            if server
                .client
                .get(format!("{}/api/diff", server.url))
                .send()
                .await
                .is_ok()
            {
                return server;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("viewer did not start");
    }

    async fn diff(&self) -> Value {
        self.client
            .get(format!("{}/api/diff", self.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn open(&self, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}/api/editor/open", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn launches_only_reviewed_files_with_zed_positions_and_local_request_protection() {
    let f = Fixture::new();
    let old_source: String = (1..=15)
        .map(|i| format!("const line{i} = {i};\n"))
        .collect();
    let new_source = old_source
        .replace("line2 = 2", "line2 = 20")
        .replace("line12 = 12", "line12 = 120");
    f.write("old.ts", &old_source);
    let new = f.write("-new λ file.ts", &new_source);
    let editor = f.editor(
        "zed",
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$EDITOR_CAPTURE\"\n",
    );
    let capture = f.0.join("capture");
    let server = Server::start(
        &f,
        &[
            "old.ts",
            "./-new λ file.ts",
            "--editor",
            editor.to_str().unwrap(),
        ],
        &[
            ("EDITOR_CAPTURE", &capture),
            ("PERSPICA_EDITOR", Path::new("not-used")),
            ("EDITOR", Path::new("nvim")),
        ],
    )
    .await;
    assert_eq!(server.diff().await["files"][0]["editor_error"], Value::Null);
    for (body, line) in [
        (json!({"file": 0}), 2),
        (json!({"file": 0, "hunk": 0}), 2),
        (json!({"file": 0, "hunk": 1}), 12),
    ] {
        assert_eq!(server.open(body).await.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(&capture).unwrap(),
            format!("{}:{line}:1\n", new.canonicalize().unwrap().display())
        );
    }
    std::fs::remove_file(&capture).unwrap();
    for body in [
        json!({"file": 99}),
        json!({"file": 0, "hunk": 99}),
        json!({"file": 0, "path": "/etc/passwd"}),
        json!({"file": 0, "command": "anything"}),
    ] {
        assert!(!server.open(body).await.status().is_success());
    }
    let endpoint = format!("{}/api/editor/open", server.url);
    assert_eq!(
        server
            .client
            .post(&endpoint)
            .header("Origin", "https://unrelated.example")
            .json(&json!({"file": 0}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .client
            .post(&endpoint)
            .header("Host", "unrelated.example")
            .json(&json!({"file": 0}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .client
            .post(&endpoint)
            .body("file=0")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert!(!capture.exists());

    std::fs::write(&new, "changed since review\n").unwrap();
    assert!(server.diff().await["files"][0]["editor_error"]
        .as_str()
        .unwrap()
        .contains("differs"));
    assert_eq!(
        server.open(json!({"file": 0})).await.status(),
        StatusCode::BAD_REQUEST
    );
    std::fs::remove_file(&new).unwrap();
    assert_eq!(
        server.open(json!({"file": 0})).await.status(),
        StatusCode::BAD_REQUEST
    );
    std::os::unix::fs::symlink(f.0.join("old.ts"), &new).unwrap();
    assert!(server
        .open(json!({"file": 0}))
        .await
        .json::<Value>()
        .await
        .unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("symbolic links"));
    assert!(!capture.exists());
}

#[tokio::test]
async fn editor_environment_precedence_generic_arguments_and_failures() {
    let f = Fixture::new();
    f.write("old.ts", "const a = 1;\n");
    let new = f.write("new.ts", "const a = 2;\n");
    let editor = f.editor(
        "gui editor",
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$EDITOR_CAPTURE\"\n",
    );
    let failing = f.editor("failing", "#!/bin/sh\nexit 7\n");
    let capture = f.0.join("capture");
    for settings in [
        vec![
            ("PERSPICA_EDITOR", editor.as_path()),
            ("VISUAL", Path::new("unused")),
            ("EDITOR", Path::new("nvim")),
        ],
        vec![("VISUAL", editor.as_path()), ("EDITOR", Path::new("nvim"))],
        vec![("EDITOR", editor.as_path())],
    ] {
        let mut settings = settings;
        settings.push(("EDITOR_CAPTURE", &capture));
        let server = Server::start(&f, &["old.ts", "new.ts"], &settings).await;
        assert_eq!(
            server.open(json!({"file": 0})).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            std::fs::read_to_string(&capture).unwrap(),
            format!("{}\n", new.canonicalize().unwrap().display())
        );
    }
    for (editor, expected) in [
        (Path::new("nvim"), "terminal"),
        (Path::new("/nonexistent/editor"), "Could not launch"),
        (failing.as_path(), "exited with"),
    ] {
        let server = Server::start(
            &f,
            &["old.ts", "new.ts", "--editor", editor.to_str().unwrap()],
            &[],
        )
        .await;
        let response = server.open(json!({"file": 0})).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains(expected));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_perspica"))
        .current_dir(&f.0)
        .args([
            "old.ts",
            "new.ts",
            "--format",
            "html",
            "--out",
            "export.html",
            "--no-sessions",
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let html = std::fs::read_to_string(f.0.join("export.html")).unwrap();
    let data = html
        .split("<script id=\"perspica-data\" type=\"application/json\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let data: Value = serde_json::from_str(data).unwrap();
    assert!(data["capabilities"].get("editor").is_none());
}

#[tokio::test]
async fn git_review_uses_repo_root_new_paths_and_rejects_historical_or_deleted_files() {
    let f = Fixture::new();
    f.git(&["init", "-q"]);
    f.git(&["config", "user.name", "Offline Test"]);
    f.git(&["config", "user.email", "offline@example.invalid"]);
    f.write("original.ts", "const a = 1;\n");
    f.write("deleted.ts", "const deleted = 1;\n");
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "base"]);
    f.git(&["mv", "original.ts", "renamed.ts"]);
    f.git(&["rm", "deleted.ts"]);
    let editor = f.editor(
        "zed",
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$EDITOR_CAPTURE\"\n",
    );
    let capture = f.0.join("capture");
    let nested = Fixture(f.0.join("nested"));
    std::fs::create_dir(&nested.0).unwrap();
    let server = Server::start(
        &nested,
        &["--staged", "--editor", editor.to_str().unwrap()],
        &[("EDITOR_CAPTURE", &capture)],
    )
    .await;
    let data = server.diff().await;
    let files = data["files"].as_array().unwrap();
    let renamed = files
        .iter()
        .position(|file| file["new_path"] == "renamed.ts")
        .unwrap();
    let deleted = files.iter().position(|file| file["status"] == "D").unwrap();
    assert_eq!(
        server.open(json!({"file": renamed})).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        std::fs::read_to_string(&capture).unwrap(),
        format!(
            "{}\n",
            f.0.join("renamed.ts").canonicalize().unwrap().display()
        )
    );
    assert_eq!(
        server.open(json!({"file": deleted})).await.status(),
        StatusCode::BAD_REQUEST
    );
    f.git(&["commit", "-qm", "rename and delete"]);
    f.write("renamed.ts", "const a = 9;\n");
    let historical = Server::start(
        &f,
        &[
            "--git",
            "HEAD~1..HEAD",
            "--editor",
            editor.to_str().unwrap(),
        ],
        &[],
    )
    .await;
    let data = historical.diff().await;
    let renamed = data["files"]
        .as_array()
        .unwrap()
        .iter()
        .position(|file| file["new_path"] == "renamed.ts")
        .unwrap();
    assert!(data["files"][renamed]["editor_error"]
        .as_str()
        .unwrap()
        .contains("differs"));
    assert_eq!(
        historical.open(json!({"file": renamed})).await.status(),
        StatusCode::BAD_REQUEST
    );
}
