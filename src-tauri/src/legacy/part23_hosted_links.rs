// Campaign Archive mods install straight from the link their author posted (MEGA, Google
// Drive). A MEGA link carries the file's key: the API gives a temporary download address,
// and the file arrives AES-128-CTR encrypted, the same length as the original. The archive
// bot (bot/src/hosts.ts) downloads it the same way and records the size and SHA-256 that
// the download is checked against.

type MegaCipher = ctr::Ctr128BE<aes::Aes128>;

struct HostedDownload {
    url: String,
    cipher: Option<MegaCipher>,
}

/// mega.nz/file/<id>#<key>, or the older mega.nz/#!<id>!<key>: the file id, AES key and counter start.
fn mega_file(link: &str) -> Option<(String, [u8; 16], [u8; 16])> {
    use base64::Engine;
    let url = reqwest::Url::parse(link).ok()?;
    let host = url.host_str()?.trim_start_matches("www.");
    if !matches!(host, "mega.nz" | "mega.io" | "mega.co.nz") {
        return None;
    }
    let fragment = url.fragment()?;
    let (id, key) = match url.path().strip_prefix("/file/") {
        Some(id) => (id.to_string(), fragment.to_string()),
        None => {
            let (id, key) = fragment.strip_prefix('!')?.split_once('!')?;
            (id.to_string(), key.to_string())
        }
    };
    let valid = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !valid(&id) || !valid(&key) {
        return None;
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(key).ok()?;
    if raw.len() != 32 {
        return None;
    }
    // The 256-bit link key folds into the AES key (halves XORed); bytes 16..24 start the counter.
    let mut aes_key = [0_u8; 16];
    for index in 0..16 {
        aes_key[index] = raw[index] ^ raw[index + 16];
    }
    let mut counter = [0_u8; 16];
    counter[..8].copy_from_slice(&raw[16..24]);
    Some((id, aes_key, counter))
}

/// drive.google.com/file/d/<id>/…, …/open?id=<id> or …/uc?id=<id>. Folder links aren't files.
fn drive_file_id(link: &str) -> Option<String> {
    let url = reqwest::Url::parse(link).ok()?;
    if !matches!(url.host_str()?, "drive.google.com" | "docs.google.com") {
        return None;
    }
    let id = match url.path().strip_prefix("/file/d/") {
        Some(rest) => rest.split('/').next()?.to_string(),
        None if matches!(url.path(), "/open" | "/uc") => url.query_pairs().find(|(name, _)| name == "id")?.1.into_owned(),
        None => return None,
    };
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')).then_some(id)
}

/// The hidden fields of Drive's "can't scan for viruses" page: sent back, they confirm the download.
fn drive_confirm_fields(page: &str) -> Vec<(String, String)> {
    page.split("<input type=\"hidden\" name=\"").skip(1).filter_map(|rest| {
        let (name, rest) = rest.split_once('"')?;
        let value = rest.strip_prefix(" value=\"")?.split('"').next()?;
        Some((name.to_string(), value.to_string()))
    }).collect()
}

const DRIVE_DOWNLOAD: &str = "https://drive.usercontent.google.com/download";

/// Drive sends a small file at once and answers a large one with its virus-scan page.
/// Either way the download address is returned; this request's body is never read past the page.
fn resolve_drive_download(id: &str) -> Result<String, CloudDownloadFailure> {
    let first = reqwest::Url::parse_with_params(DRIVE_DOWNLOAD, [("id", id), ("export", "download")])
        .map_err(|_| CloudDownloadFailure::Permanent("That Google Drive link isn't valid.".into()))?;
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .and_then(|client| client.get(first.clone()).send())
        .map_err(|error| CloudDownloadFailure::Retryable(format!("Could not reach Google Drive: {error}")))?;
    let is_page = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html"));
    if !is_page {
        return Ok(first.to_string());
    }
    let page = response.text().map_err(|error| CloudDownloadFailure::Retryable(format!("Could not read Google Drive's answer: {error}")))?;
    let fields = drive_confirm_fields(&page);
    if !fields.iter().any(|(name, _)| name == "confirm") {
        return Err(CloudDownloadFailure::Permanent(
            "Google Drive won't share this mod's file right now (it may be private, or over its download limit). No files were changed.".into(),
        ));
    }
    reqwest::Url::parse_with_params(DRIVE_DOWNLOAD, &fields)
        .map(String::from)
        .map_err(|_| CloudDownloadFailure::Permanent("Google Drive sent a download form CCM Reborn can't read.".into()))
}

/// Where to download `link` from. Links that aren't MEGA or Drive files are downloaded as they are.
fn resolve_hosted_download(link: &str) -> Result<HostedDownload, CloudDownloadFailure> {
    use ctr::cipher::KeyIvInit;
    if let Some(id) = drive_file_id(link) {
        return Ok(HostedDownload { url: resolve_drive_download(&id)?, cipher: None });
    }
    let Some((id, key, counter)) = mega_file(link) else {
        return Ok(HostedDownload { url: link.to_string(), cipher: None });
    };
    let answer: serde_json::Value = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .and_then(|client| client.post("https://g.api.mega.co.nz/cs").body(serde_json::json!([{ "a": "g", "g": 1, "ssl": 2, "p": id }]).to_string()).send())
        .and_then(|response| response.text())
        .map_err(|error| CloudDownloadFailure::Retryable(format!("Could not reach MEGA: {error}")))
        .and_then(|body| serde_json::from_str(&body)
            .map_err(|_| CloudDownloadFailure::Retryable("MEGA sent an answer CCM Reborn can't read.".into())))?;
    let file = &answer[0];
    if let Some(code) = file.as_i64() {
        // -9: no such file; -16: taken down; -17: download limit; -18: busy, try again.
        return Err(match code {
            -9 | -16 => CloudDownloadFailure::Permanent("This mod's file is no longer on MEGA. No files were changed.".into()),
            -17 => CloudDownloadFailure::Permanent("MEGA's download limit was reached. Try again later. No files were changed.".into()),
            -18 => CloudDownloadFailure::Retryable("MEGA is busy right now.".into()),
            _ => CloudDownloadFailure::Permanent(format!("MEGA refused the download (error {code}). No files were changed.")),
        });
    }
    let url = file["g"].as_str()
        .filter(|url| url.starts_with("https://"))
        .ok_or_else(|| CloudDownloadFailure::Retryable("MEGA didn't give a download address.".into()))?;
    Ok(HostedDownload { url: url.to_string(), cipher: Some(MegaCipher::new(&key.into(), &counter.into())) })
}

/// Downloads and checks a package into the download cache without installing it: a Library
/// mod kept in My Mods to switch to later. Returns the cached file.
#[tauri::command]
async fn download_package(window: tauri::Window, source: String, sha256: String, size: u64) -> Result<String, String> {
    let reporter = ProgressReporter::new(window);
    tauri::async_runtime::spawn_blocking(move || {
        if !source.trim().starts_with("https://") {
            return Err("Only a mod from the Library can be downloaded for later.".to_string());
        }
        let expected = normalize_sha256(&sha256)?;
        let archive = acquire_archive(&source, &expected, Some(size), Some(&reporter))?;
        Ok(path_string(&archive.path))
    })
    .await
    .map_err(|error| format!("Download worker failed: {error}"))?
}
