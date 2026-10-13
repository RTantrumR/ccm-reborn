// A newer release of the app itself. Every start asks GitHub for the latest release (drafts
// and pre-releases are never "latest"). On Windows, Update downloads its setup.exe, checks it
// against the SHA-256 GitHub records for the file, starts the installer's wizard and closes
// the app so its files can be replaced. Elsewhere the release page opens instead.

const RELEASES_API: &str = "https://api.github.com/repos/RTantrumR/ccm-reborn/releases/latest";
const APP_UPDATE_EVENT: &str = "app-update-progress";
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AppUpdate {
    version: String,
    page_url: String,
    can_install: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    downloaded: u64,
    total: u64,
}

fn releases_api() -> String {
    // A debug build can be pointed at a test server.
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("CCM_RELEASES_API") {
        return url;
    }
    RELEASES_API.to_string()
}

/// "v1.2.3" or "1.2.3-beta.1" -> (1, 2, 3).
fn version_parts(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

fn is_newer(candidate: &str, current: &str) -> bool {
    matches!((version_parts(candidate), version_parts(current)), (Some(new), Some(old)) if new > old)
}

/// The release's Windows installer and its SHA-256, when GitHub recorded one.
fn windows_installer(release: &GithubRelease) -> Option<(&GithubAsset, String)> {
    let asset = release.assets.iter().find(|asset| asset.name.ends_with("-setup.exe"))?;
    let sha256 = normalize_sha256(asset.digest.as_deref()?.strip_prefix("sha256:")?).ok()?;
    Some((asset, sha256))
}

/// GitHub serves release files from its own hosts only.
fn is_github_host(url: &reqwest::Url) -> bool {
    // A debug build can download from a local test server.
    #[cfg(debug_assertions)]
    if std::env::var_os("CCM_UPDATE_ALLOW_LOCAL").is_some() && url.host_str() == Some("127.0.0.1") {
        return true;
    }
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| host == "github.com" || host.ends_with(".githubusercontent.com"))
}

fn github_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent(concat!("CCM-Reborn/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 || !is_github_host(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("Could not create the update client: {error}"))
}

/// None when the repository has no release yet.
fn fetch_latest_release() -> Result<Option<GithubRelease>, String> {
    let response = github_client(10)?
        .get(releases_api())
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .map_err(|error| format!("Could not reach GitHub: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let body = response
        .error_for_status()
        .map_err(|error| format!("GitHub answered {}", error.status().map(|status| status.to_string()).unwrap_or_default()))?
        .text()
        .map_err(|error| format!("Could not read GitHub's answer: {error}"))?;
    serde_json::from_str(&body).map(Some).map_err(|error| format!("Unexpected answer from GitHub: {error}"))
}

fn newer_release() -> Result<Option<GithubRelease>, String> {
    Ok(fetch_latest_release()?.filter(|release| is_newer(&release.tag_name, env!("CARGO_PKG_VERSION"))))
}

#[tauri::command]
async fn check_app_update() -> Result<Option<AppUpdate>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(newer_release()?.map(|release| AppUpdate {
            version: release.tag_name.trim_start_matches('v').to_string(),
            can_install: cfg!(target_os = "windows") && windows_installer(&release).is_some(),
            page_url: release.html_url,
        }))
    })
    .await
    .map_err(|error| format!("Update check failed: {error}"))?
}

/// Downloads the newer release's installer into the temp folder and checks it. The release is
/// looked up again here, so the page can't hand over some other file to run.
fn download_app_installer(window: &tauri::Window) -> Result<PathBuf, String> {
    let couldnt = "The update couldn't be downloaded. Check your connection and try again.";
    let release = newer_release().map_err(|error| {
        append_diagnostic_log(&format!("app update: {}", redact_diagnostic_value(&error)));
        couldnt.to_string()
    })?;
    let Some(release) = release else { return Err("This is already the newest version.".into()) };
    let Some((asset, expected_sha256)) = windows_installer(&release) else {
        return Err("This release has no installer the app can check.".into());
    };
    let url = reqwest::Url::parse(&asset.browser_download_url).map_err(|_| couldnt.to_string())?;
    if !is_github_host(&url) || asset.size > MAX_INSTALLER_BYTES || asset.name.contains(['/', '\\']) {
        return Err("This release has no installer the app can check.".into());
    }
    let directory = std::env::temp_dir().join("ccm-reborn-update");
    fs::create_dir_all(&directory).map_err(io_error)?;
    let path = directory.join(&asset.name);
    let temporary = directory.join(format!("{}.part", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut response = github_client(300)?
            .get(url)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| {
                append_diagnostic_log(&format!("app update download: {}", redact_diagnostic_value(&error.to_string())));
                couldnt.to_string()
            })?;
        let mut output = File::create(&temporary).map_err(io_error)?;
        let mut digest = Sha256::new();
        let (mut copied, mut last_event) = (0_u64, Instant::now());
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = response.read(&mut buffer).map_err(|_| couldnt.to_string())?;
            if read == 0 {
                break;
            }
            copied += read as u64;
            if copied > asset.size {
                return Err("The download didn't match the release. Nothing was installed.".into());
            }
            digest.update(&buffer[..read]);
            output.write_all(&buffer[..read]).map_err(io_error)?;
            if last_event.elapsed() >= Duration::from_millis(200) {
                last_event = Instant::now();
                let _ = window.emit(APP_UPDATE_EVENT, AppUpdateProgress { downloaded: copied, total: asset.size });
            }
        }
        output.sync_all().map_err(io_error)?;
        drop(output);
        if copied != asset.size || hex::encode(digest.finalize()) != expected_sha256 {
            return Err("The download didn't match the release. Nothing was installed.".into());
        }
        let _ = window.emit(APP_UPDATE_EVENT, AppUpdateProgress { downloaded: copied, total: asset.size });
        atomic_replace(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|()| path)
}

#[tauri::command]
async fn install_app_update(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Updates install from the release page on this system.".into());
    }
    let installer = tauri::async_runtime::spawn_blocking(move || download_app_installer(&window))
        .await
        .map_err(|error| format!("Update failed: {error}"))??;
    // Update mode: no wizard pages and no uninstall step (which fails when the publisher name
    // changed), only a progress window, and the installer restarts the app when done. The app
    // closes right away so its files can be replaced; the installer gets none of its handles.
    let null = std::process::Stdio::null;
    Command::new(&installer).args(["/P", "/R", "/UPDATE"]).stdin(null()).stdout(null()).stderr(null()).spawn().map_err(|error| {
        append_diagnostic_log(&format!("app update start: {error}"));
        "The installer couldn't be started.".to_string()
    })?;
    append_diagnostic_log(&format!("app update: started {}", installer.display()));
    app.exit(0);
    Ok(())
}
