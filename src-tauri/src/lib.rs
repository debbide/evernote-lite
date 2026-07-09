use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use tauri::State;
use hmac::{Hmac, Mac};
use sha2::{Sha256, Digest};

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize, Deserialize, Debug)]
struct Note {
    id: i32,
    title: String,
    snippet: String,
    content: String,
    is_pinned: i32,
    tags: String,
    language: String,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct S3Config {
    endpoint: String,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
}

struct AppState {
    db: Mutex<Option<Connection>>,
    app_dir: PathBuf,
}

fn init_db(app_dir: &PathBuf) -> Result<Connection> {
    if !app_dir.exists() {
        fs::create_dir_all(app_dir).unwrap();
    }
    let db_path = app_dir.join("notes.db");
    let conn = Connection::open(db_path)?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            snippet TEXT NOT NULL,
            content TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    let _ = conn.execute("ALTER TABLE notes ADD COLUMN is_pinned INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT '[]'", []);
    let _ = conn.execute("ALTER TABLE notes ADD COLUMN language TEXT DEFAULT 'markdown'", []);

    Ok(conn)
}

fn query_notes(conn: &Connection, query: &Option<String>) -> Result<Vec<Note>, String> {
    let (sql, pattern) = match query {
        Some(q) if !q.is_empty() => (
            "SELECT id, title, snippet, content, is_pinned, tags, language, updated_at FROM notes WHERE title LIKE ?1 OR content LIKE ?1 OR tags LIKE ?1 ORDER BY is_pinned DESC, updated_at DESC",
            Some(format!("%{}%", q)),
        ),
        _ => (
            "SELECT id, title, snippet, content, is_pinned, tags, language, updated_at FROM notes ORDER BY is_pinned DESC, updated_at DESC",
            None,
        ),
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Note> {
        Ok(Note {
            id: row.get(0)?,
            title: row.get(1)?,
            snippet: row.get(2)?,
            content: row.get(3)?,
            is_pinned: row.get(4)?,
            tags: row.get(5)?,
            language: row.get(6)?,
            updated_at: row.get(7)?,
        })
    };

    let notes: Vec<Note> = if let Some(ref p) = pattern {
        stmt.query_map(params![p], map_row)
    } else {
        stmt.query_map([], map_row)
    }
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<Note>>>()
    .map_err(|e| e.to_string())?;

    Ok(notes)
}

#[tauri::command]
fn get_notes(state: State<AppState>, query: Option<String>) -> Result<Vec<Note>, String> {
    let guard = state.db.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not available")?;
    query_notes(conn, &query)
}

#[tauri::command]
fn save_note(state: State<AppState>, id: Option<i32>, title: String, content: String, is_pinned: i32, tags: String, language: String) -> Result<i32, String> {
    let guard = state.db.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not available")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;

    let snippet: String = content.chars().take(50).collect();
    let snippet = snippet.replace('\n', " ");

    if let Some(note_id) = id {
        conn.execute(
            "UPDATE notes SET title = ?1, snippet = ?2, content = ?3, is_pinned = ?4, tags = ?5, language = ?6, updated_at = ?7 WHERE id = ?8",
            params![title, snippet, content, is_pinned, tags, language, now, note_id],
        ).map_err(|e| e.to_string())?;
        Ok(note_id)
    } else {
        conn.execute(
            "INSERT INTO notes (title, snippet, content, is_pinned, tags, language, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![title, snippet, content, is_pinned, tags, language, now],
        ).map_err(|e| e.to_string())?;
        let new_id = conn.last_insert_rowid() as i32;
        Ok(new_id)
    }
}

#[tauri::command]
fn delete_note(state: State<AppState>, id: i32) -> Result<(), String> {
    let guard = state.db.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not available")?;
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_launch_file() -> Result<Option<(String, String)>, String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let file_path = &args[1];
        let path = std::path::Path::new(file_path);

        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(path) {
                let filename = path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                return Ok(Some((filename, content)));
            }
        }
    }
    Ok(None)
}

// --- S3 配置读写 ---

fn s3_config_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join("s3_config.json")
}

#[tauri::command]
fn get_s3_config(state: State<AppState>) -> Result<S3Config, String> {
    let path = s3_config_path(&state.app_dir);
    if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())
    } else {
        Ok(S3Config::default())
    }
}

#[tauri::command]
fn save_s3_config(state: State<AppState>, config: S3Config) -> Result<(), String> {
    let path = s3_config_path(&state.app_dir);
    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

// --- AWS V4 签名 (参考 one-mail 实现) ---

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn derive_signing_key(secret: &str, date_stamp: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{}", secret).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

fn build_s3_url(config: &S3Config, key: &str) -> String {
    let endpoint = config.endpoint.trim_end_matches('/');
    format!("{}/{}/{}", endpoint, config.bucket, key)
}

async fn s3_request(config: &S3Config, method: &str, key: &str, body: &[u8]) -> std::result::Result<reqwest::Response, String> {
    let url_str = build_s3_url(config, key);
    let url = reqwest::Url::parse(&url_str).map_err(|e| e.to_string())?;

    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let region = if config.region.is_empty() { "us-east-1" } else { &config.region };

    let host = url.host_str().ok_or("Invalid URL host")?.to_string();
    let host_header = if let Some(port) = url.port() {
        format!("{}:{}", host, port)
    } else {
        host.clone()
    };

    let payload_hash = sha256_hex(body);

    let canonical_uri = url.path().to_string();
    let canonical_querystring = url.query().unwrap_or("").to_string();

    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host_header, payload_hash, amz_date
    );

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method, canonical_uri, canonical_querystring, canonical_headers, signed_headers, payload_hash
    );

    let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date, credential_scope, sha256_hex(canonical_request.as_bytes())
    );

    let signing_key = derive_signing_key(&config.secret_key, &date_stamp, region);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key, credential_scope, signed_headers, signature
    );

    let client = reqwest::Client::new();
    let mut req = match method {
        "PUT" => client.put(&url_str),
        "GET" => client.get(&url_str),
        "DELETE" => client.delete(&url_str),
        _ => return Err(format!("Unsupported method: {}", method)),
    };

    req = req
        .header("host", &host_header)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("authorization", &authorization);

    if method == "PUT" {
        req = req
            .header("content-length", body.len().to_string())
            .body(body.to_vec());
    }

    req.send().await.map_err(|e| e.to_string())
}

// --- S3 备份/恢复 ---

#[tauri::command]
async fn backup_to_s3(state: State<'_, AppState>) -> Result<String, String> {
    let config = {
        let path = s3_config_path(&state.app_dir);
        if !path.exists() {
            return Err("请先配置 S3 信息".into());
        }
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<S3Config>(&data).map_err(|e| e.to_string())?
    };

    let db_path = state.app_dir.join("notes.db");
    let db_bytes = {
        let _guard = state.db.lock().unwrap();
        fs::read(&db_path).map_err(|e| e.to_string())?
    };

    let response = s3_request(&config, "PUT", "notes.db", &db_bytes).await?;
    let status = response.status().as_u16();

    if status >= 200 && status < 300 {
        Ok("备份成功".into())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("备份失败，HTTP {} - {}", status, body))
    }
}

#[tauri::command]
async fn restore_from_s3(state: State<'_, AppState>) -> Result<String, String> {
    let config = {
        let path = s3_config_path(&state.app_dir);
        if !path.exists() {
            return Err("请先配置 S3 信息".into());
        }
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<S3Config>(&data).map_err(|e| e.to_string())?
    };

    let response = s3_request(&config, "GET", "notes.db", &[]).await?;
    let status = response.status().as_u16();

    if status < 200 || status >= 300 {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("下载失败，HTTP {} - {}", status, body));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let db_path = state.app_dir.join("notes.db");

    {
        let mut guard = state.db.lock().unwrap();
        *guard = None;
    }

    fs::write(&db_path, &bytes).map_err(|e| e.to_string())?;

    let new_conn = init_db(&state.app_dir).map_err(|e| e.to_string())?;
    {
        let mut guard = state.db.lock().unwrap();
        *guard = Some(new_conn);
    }

    Ok("恢复成功".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            use tauri::Emitter;
            if argv.len() > 1 {
                let file_path = &argv[1];
                let path = std::path::Path::new(file_path);
                if path.is_file() {
                    if let Ok(content) = std::fs::read_to_string(path) {
                        let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        let _ = app.emit("import-external-file", (filename, content));
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            use tauri::Manager;
            let exe_path = std::env::current_exe().expect("Failed to get current exe path");
            let app_dir = exe_path.parent().expect("Failed to get exe parent dir").join("data");
            let db = init_db(&app_dir).expect("Failed to initialize database");
            app.manage(AppState {
                db: Mutex::new(Some(db)),
                app_dir,
            });

            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notes, save_note, delete_note, get_launch_file,
            get_s3_config, save_s3_config, backup_to_s3, restore_from_s3
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
