use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use tauri::State;
use hmac::{Hmac, Mac};
use sha2::{Sha256, Digest};
use keyring::Entry;
use std::sync::atomic::{AtomicBool, Ordering};

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
    #[serde(default = "default_retention")]
    retention: u32,
}

fn default_retention() -> u32 {
    30
}

struct AppState {
    db: Mutex<Option<Connection>>,
    app_dir: PathBuf,
    op_busy: AtomicBool,
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

// --- S3 配置读写（secret_key 存系统钥匙串，s3_config.json 不再落明文） ---

const KEYRING_SERVICE: &str = "evernote-lite";
const KEYRING_USER: &str = "s3-secret-key";

fn s3_config_path(app_dir: &Path) -> PathBuf {
    app_dir.join("s3_config.json")
}

/// 读完整 S3 配置（含 secret）。自动把旧版明文 secret_key 迁移进钥匙串。
fn load_s3_config(app_dir: &Path) -> Result<S3Config, String> {
    let path = s3_config_path(app_dir);
    let mut cfg: S3Config = if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())?
    } else {
        S3Config::default()
    };

    // 迁移：旧版 s3_config.json 里的明文 secret_key → 钥匙串，迁移失败不阻断读取
    if !cfg.secret_key.is_empty() {
        if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USER) {
            if entry.set_password(&cfg.secret_key).is_ok() {
                cfg.secret_key = String::new();
                if let Ok(data) = serde_json::to_string_pretty(&cfg) {
                    let _ = fs::write(&path, data);
                }
            }
        }
    }

    // 从钥匙串取回 secret
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        if let Ok(pw) = entry.get_password() {
            cfg.secret_key = pw;
        }
    }
    Ok(cfg)
}

fn s3_configured(cfg: &S3Config) -> bool {
    !(cfg.endpoint.is_empty() || cfg.bucket.is_empty() || cfg.access_key.is_empty() || cfg.secret_key.is_empty())
}

#[tauri::command]
fn get_s3_config(state: State<AppState>) -> Result<S3Config, String> {
    load_s3_config(&state.app_dir)
}

#[tauri::command]
fn save_s3_config(state: State<AppState>, config: S3Config) -> Result<(), String> {
    // secret_key 为空表示用户没改，保留钥匙串里的旧值；写入失败必须报错，不能静默丢密钥
    if !config.secret_key.is_empty() {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
        entry.set_password(&config.secret_key).map_err(|e| e.to_string())?;
    }
    // 落盘不含明文 secret
    let mut disk_cfg = config;
    disk_cfg.secret_key = String::new();
    let path = s3_config_path(&state.app_dir);
    let data = serde_json::to_string_pretty(&disk_cfg).map_err(|e| e.to_string())?;
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
    s3_request_with_query(config, method, key, None, body).await
}

async fn s3_request_with_query(
    config: &S3Config,
    method: &str,
    key: &str,
    query: Option<&str>,
    body: &[u8],
) -> std::result::Result<reqwest::Response, String> {
    let base = build_s3_url(config, key);
    let url_str = match query {
        Some(q) => format!("{}?{}", base, q),
        None => base,
    };
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

// --- S3 备份历史（参照 browser-panel：key 带 UTC 时间戳，字典序即时间序） ---

#[derive(Debug, Deserialize)]
struct S3ListResult {
    #[serde(rename = "Contents", default)]
    contents: Vec<S3Object>,
}

#[derive(Debug, Deserialize)]
struct S3Object {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "LastModified")]
    last_modified: String,
    #[serde(rename = "Size")]
    size: u64,
}

#[derive(Debug, Serialize)]
struct BackupInfo {
    key: String,
    name: String,
    size: u64,
    last_modified: String,
    trigger: String,
}

/// 并发锁：一次只允许一个备份/恢复在跑（参照 browser-panel 的 busyOp）
struct OpGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

fn try_begin_op(state: &AppState) -> Result<OpGuard<'_>, String> {
    if state.op_busy.swap(true, Ordering::SeqCst) {
        return Err("已有备份/恢复操作在进行中，请稍候".into());
    }
    Ok(OpGuard { flag: &state.op_busy })
}

fn build_backup_key(trigger: &str) -> String {
    let t = if trigger == "manual" { "manual" } else { "auto" };
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    format!("backups/{}/notes-{}-{}.db", t, t, stamp)
}

async fn s3_list_backups(config: &S3Config) -> Result<Vec<S3Object>, String> {
    let resp = s3_request_with_query(
        config,
        "GET",
        "",
        Some("list-type=2&max-keys=100&prefix=backups"),
        &[],
    )
    .await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("列出备份失败，HTTP {} - {}", status, body));
    }
    let xml = resp.text().await.map_err(|e| e.to_string())?;
    let parsed: S3ListResult = quick_xml::de::from_str(&xml).map_err(|e| e.to_string())?;
    Ok(parsed
        .contents
        .into_iter()
        .filter(|o| o.key.ends_with(".db"))
        .collect())
}

fn to_backup_info(o: S3Object) -> BackupInfo {
    let name = o.key.rsplit('/').next().unwrap_or(&o.key).to_string();
    let trigger = if o.key.contains("/manual/") {
        "manual"
    } else {
        "auto"
    }
    .to_string();
    BackupInfo {
        key: o.key,
        name,
        size: o.size,
        last_modified: o.last_modified,
        trigger,
    }
}

#[tauri::command]
async fn list_backups(state: State<'_, AppState>) -> Result<Vec<BackupInfo>, String> {
    let config = load_s3_config(&state.app_dir)?;
    if !s3_configured(&config) {
        return Err("请先配置 S3 信息".into());
    }
    let mut out: Vec<BackupInfo> = s3_list_backups(&config)
        .await?
        .into_iter()
        .map(to_backup_info)
        .collect();
    out.sort_by(|a, b| b.key.cmp(&a.key)); // 新的在前（stamp 字典序即时间序）
    Ok(out)
}

#[tauri::command]
async fn delete_backup(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let config = load_s3_config(&state.app_dir)?;
    if !s3_configured(&config) {
        return Err("请先配置 S3 信息".into());
    }
    // 安全护栏：只允许删除 backups/ 下的 .db 文件
    if !key.starts_with("backups/") || !key.ends_with(".db") {
        return Err("非法的备份 key".into());
    }
    let resp = s3_request(&config, "DELETE", &key, &[]).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("删除失败，HTTP {}", status));
    }
    Ok(())
}

// --- S3 备份/恢复 ---

#[tauri::command]
async fn backup_to_s3(state: State<'_, AppState>, trigger: Option<String>) -> Result<String, String> {
    let _op = try_begin_op(&state)?;
    let config = load_s3_config(&state.app_dir)?;
    if !s3_configured(&config) {
        return Err("请先配置 S3 信息".into());
    }
    let trig = trigger.unwrap_or_else(|| "manual".into());

    // 用 VACUUM INTO 生成一致性快照：直接 fs::read 正在写入的 db 文件可能读到 torn 的坏库
    let snapshot_path = state.app_dir.join("notes_backup_snapshot.db");
    let _ = fs::remove_file(&snapshot_path);
    {
        let guard = state.db.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not available")?;
        let escaped = snapshot_path.to_string_lossy().replace('\'', "''");
        conn.execute(&format!("VACUUM INTO '{}'", escaped), [])
            .map_err(|e| e.to_string())?;
    }
    let db_bytes = fs::read(&snapshot_path).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&snapshot_path);

    let key = build_backup_key(&trig);
    let response = s3_request(&config, "PUT", &key, &db_bytes).await?;
    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("备份失败，HTTP {} - {}", status, body));
    }

    // 轮转：只保留最近 retention 个，删掉更旧的（轮转失败不影响本次备份结果）
    let retention = config.retention.clamp(1, 1000) as usize;
    if let Ok(mut objs) = s3_list_backups(&config).await {
        objs.sort_by(|a, b| a.key.cmp(&b.key));
        if objs.len() > retention {
            for old in objs.iter().take(objs.len() - retention) {
                let _ = s3_request(&config, "DELETE", &old.key, &[]).await;
            }
        }
    }

    Ok(format!(
        "备份成功：{}",
        key.rsplit('/').next().unwrap_or(&key)
    ))
}

#[tauri::command]
async fn restore_from_s3(state: State<'_, AppState>, key: String) -> Result<String, String> {
    let _op = try_begin_op(&state)?;
    let config = load_s3_config(&state.app_dir)?;
    if !s3_configured(&config) {
        return Err("请先配置 S3 信息".into());
    }
    // 安全护栏：只允许恢复 backups/ 下的 .db 文件
    if !key.starts_with("backups/") || !key.ends_with(".db") {
        return Err("非法的备份 key".into());
    }

    let response = s3_request(&config, "GET", &key, &[]).await?;
    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("下载失败，HTTP {} - {}", status, body));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let db_path = state.app_dir.join("notes.db");
    let tmp_path = state.app_dir.join("notes.db.tmp");

    // 1. 先写临时文件并验证：能打开、notes 表存在。此时旧连接不受任何影响
    fs::write(&tmp_path, &bytes).map_err(|e| e.to_string())?;
    let verify: Result<(), String> = (|| {
        let chk = Connection::open(&tmp_path).map_err(|e| e.to_string())?;
        chk.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = verify {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("备份文件校验失败: {}", e));
    }

    // 2. 关闭旧连接（Windows 下替换文件前必须先释放句柄）
    {
        let mut guard = state.db.lock().unwrap();
        *guard = None;
    }

    // 3. 原子替换；失败则重开旧文件恢复连接，不让应用处于无库状态
    if let Err(e) = fs::rename(&tmp_path, &db_path) {
        let _ = fs::remove_file(&tmp_path);
        let recovered = init_db(&state.app_dir);
        let mut guard = state.db.lock().unwrap();
        *guard = recovered.ok();
        return Err(format!("替换数据库文件失败，已恢复旧库: {}", e));
    }

    // 4. 重开连接；万一打不开，用刚下载的字节重写一次再试
    let new_conn = match init_db(&state.app_dir) {
        Ok(conn) => conn,
        Err(_) => {
            let _ = fs::write(&db_path, &bytes);
            init_db(&state.app_dir).map_err(|e| format!("恢复后数据库无法打开: {}", e))?
        }
    };
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
                op_busy: AtomicBool::new(false),
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
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notes, save_note, delete_note, get_launch_file,
            get_s3_config, save_s3_config, backup_to_s3, restore_from_s3,
            list_backups, delete_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
