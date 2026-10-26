use axum::{extract::OriginalUri, http::HeaderMap, routing::post, Json, Router};
use std::path::PathBuf;
use tokio::process::Command;

#[tokio::test]
async fn openai_endpoint_and_credentials_follow_cli_and_environment() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/gateway/v1", listener.local_addr().unwrap());
    let (tx, mut requests) = tokio::sync::mpsc::channel(1);
    let app = Router::new().fallback(post(move |OriginalUri(uri): OriginalUri, headers: HeaderMap, Json(body): Json<serde_json::Value>| {
        let tx = tx.clone();
        async move {
            tx.send((uri, headers, body)).await.unwrap();
            Json(serde_json::json!({"choices": [{"message": {"content": "{\"groups\":[],\"summary\":\"Offline test summary\",\"concerns\":[]}"}}]}))
        }
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/logic_change_simple");
    let trailing_slash = format!("{base_url}/");

    // Each child has isolated, fake credentials; no test changes the test runner's environment.
    struct Case<'a> {
        args: &'a [&'a str],
        env: &'a [(&'a str, &'a str)],
        key: &'a str,
    }
    let cases = &[
        // Explicit provider wins over other provider credentials; its key can come from the environment.
        Case {
            args: &["--provider", "openai"],
            env: &[
                ("OPENAI_API_KEY", "openai-key"),
                ("ANTHROPIC_API_KEY", "unused"),
                ("ANTHROPIC_AUTH_TOKEN", "unused"),
                ("OPENAI_BASE_URL", &base_url),
            ],
            key: "openai-key",
        },
        // Automatic OpenAI detection also honors the endpoint, including a trailing slash.
        Case {
            args: &[],
            env: &[
                ("OPENAI_API_KEY", "openai-key"),
                ("OPENAI_BASE_URL", &trailing_slash),
            ],
            key: "openai-key",
        },
        // Perspica's environment-based selection uses the same endpoint.
        Case {
            args: &[],
            env: &[
                ("PERSPICA_PROVIDER", "openai"),
                ("PERSPICA_API_KEY", "perspica-key"),
                ("OPENAI_BASE_URL", &base_url),
            ],
            key: "perspica-key",
        },
        // Explicit provider overrides PERSPICA_PROVIDER and keeps the generic key's priority.
        Case {
            args: &["--provider", "openai"],
            env: &[
                ("PERSPICA_PROVIDER", "anthropic"),
                ("PERSPICA_API_KEY", "perspica-key"),
                ("OPENAI_API_KEY", "unused"),
                ("OPENAI_BASE_URL", &base_url),
            ],
            key: "perspica-key",
        },
        // CLI endpoint and key override their environment counterparts.
        Case {
            args: &[
                "--provider",
                "openai",
                "--api-key",
                "cli-key",
                "--base-url",
                &trailing_slash,
            ],
            env: &[
                ("OPENAI_API_KEY", "unused"),
                ("PERSPICA_API_KEY", "unused"),
                ("OPENAI_BASE_URL", "http://127.0.0.1:1/unused/v1"),
            ],
            key: "cli-key",
        },
    ];

    for Case { args, env, key } in cases {
        let mut command = Command::new(env!("CARGO_BIN_EXE_perspica"));
        for name in [
            "PERSPICA_API_KEY",
            "PERSPICA_PROVIDER",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
        ] {
            command.env_remove(name);
        }
        let output = command
            .arg(fixtures.join("before.ts"))
            .arg(fixtures.join("after.ts"))
            .args([
                "--json",
                "--summarize",
                "--fresh",
                "--no-sessions",
                "--model",
                "custom-model",
            ])
            .args(*args)
            .envs(env.iter().copied())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(std::time::Duration::from_secs(20), output)
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["llm_provider"], "OpenAI");
        assert_eq!(result["llm_model"], "custom-model");
        assert_eq!(result["summary"], "Offline test summary");
        assert!(result["llm_error"].is_null(), "{result}");

        let (uri, headers, body) = requests
            .try_recv()
            .expect("expected a local OpenAI request");
        assert_eq!(uri.path(), "/gateway/v1/chat/completions");
        assert_eq!(headers["authorization"], format!("Bearer {key}"));
        assert_eq!(headers["content-type"], "application/json");
        assert_eq!(body["model"], "custom-model");
        assert_eq!(body["max_tokens"], 16000);
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(!body["messages"][0]["content"].as_str().unwrap().is_empty());
    }
    server.abort();
}
