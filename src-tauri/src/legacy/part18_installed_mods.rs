// My Mods: every mod CCM Reborn has installed into one game folder, current or
// since replaced. Installs keep the active manifest in `installed/<slot>.json`
// and retire the previous one to `installed/history/` (archive_installed_manifest),
// so together they are the player's install history. Read-only.

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModRecord {
    campaign_id: String,
    title: String,
    author: String,
    version: String,
    package_sha256: String,
    target_path: String,
    /// Base campaign display name, e.g. "Heart of the Swarm".
    campaign: String,
    installed_at: u64,
    /// Installed in its slot right now.
    current: bool,
    /// The verified download is still in the archive cache, so the mod can be
    /// reinstalled even if it has left the catalog.
    cached_archive: Option<String>,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn cached_archive_for(sha256: &str) -> Option<String> {
    if !is_sha256_hex(sha256) {
        return None;
    }
    archive_cache_path(sha256).ok().filter(|path| path.is_file()).map(|path| path_string(&path))
}

fn read_manifests_in(directory: &Path, current: bool, into: &mut Vec<(InstalledManifest, bool)>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        // A damaged or older-format manifest hides only that one entry.
        if let Ok(manifest) = profile_core::read_installed_manifest(&path) {
            into.push((manifest, current));
        }
    }
}

fn list_installed_mods_at(
    root: &Path,
    cache_lookup: impl Fn(&str) -> Option<String>,
) -> Vec<InstalledModRecord> {
    let installed = manager_root(root).join("installed");
    let mut manifests = Vec::new();
    read_manifests_in(&installed, true, &mut manifests);
    read_manifests_in(&installed.join("history"), false, &mut manifests);
    // One entry per mod id: the active install if there is one, otherwise the
    // newest retired one (repairs and updates retire the same id repeatedly).
    manifests.sort_by(|left, right| right.1.cmp(&left.1).then(right.0.installed_at.cmp(&left.0.installed_at)));
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    for (manifest, current) in manifests {
        if !seen.insert(manifest.campaign_id.clone()) {
            continue;
        }
        let Ok(campaign) = campaign_display_for_target(&manifest.target_path) else {
            continue;
        };
        records.push(InstalledModRecord {
            cached_archive: cache_lookup(&manifest.package_sha256),
            campaign: campaign.to_string(),
            campaign_id: manifest.campaign_id,
            title: manifest.title,
            author: manifest.author,
            version: manifest.version,
            package_sha256: manifest.package_sha256,
            target_path: manifest.target_path,
            installed_at: manifest.installed_at,
            current,
        });
    }
    records.sort_by(|left, right| right.installed_at.cmp(&left.installed_at));
    records
}

#[tauri::command]
async fn list_installed_mods(game_dir: String) -> Result<Vec<InstalledModRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = require_desktop_game_root(&game_dir)?;
        Ok(list_installed_mods_at(&root, cached_archive_for))
    })
    .await
    .map_err(|error| format!("Installed mods worker failed: {error}"))?
}

#[cfg(test)]
mod installed_mods_tests {
    use super::*;

    fn manifest(id: &str, target: &str, sha: &str, installed_at: u64) -> InstalledManifest {
        InstalledManifest {
            schema_version: INSTALLED_MANIFEST_SCHEMA_VERSION,
            campaign_id: id.into(),
            title: format!("{id} title"),
            author: "Author".into(),
            version: "1.0".into(),
            package_sha256: sha.into(),
            target_path: target.into(),
            installed_at,
            files: vec![InstalledFile {
                destination: format!("{target}/Map.SC2Map"),
                source: "Map.SC2Map".into(),
                size: 1,
                sha256: "a".repeat(64),
                kind: "file".into(),
            }],
        }
    }

    #[test]
    fn lists_current_and_retired_mods_once_each_newest_first() {
        let root = std::env::temp_dir().join(format!("ccm-installed-mods-{}", Uuid::new_v4()));
        let installed = manager_root(&root).join("installed");
        let history = installed.join("history");
        fs::create_dir_all(&history).unwrap();
        let cached = "c".repeat(64);
        // Current HotS mod, also retired once before (a repair): listed once, as current.
        write_installed_manifest_atomic(&installed.join("Maps_Campaign_swarm.json"), &manifest("yuri", "Maps/Campaign/swarm", &cached, 300)).unwrap();
        write_installed_manifest_atomic(&history.join("1-a.json"), &manifest("yuri", "Maps/Campaign/swarm", &cached, 100)).unwrap();
        // A HotS mod it replaced, retired twice: the newest copy wins.
        write_installed_manifest_atomic(&history.join("2-b.json"), &manifest("abathur", "Maps/Campaign/swarm", &"d".repeat(64), 150)).unwrap();
        write_installed_manifest_atomic(&history.join("3-c.json"), &manifest("abathur", "Maps/Campaign/swarm", &"e".repeat(64), 200)).unwrap();
        // Unreadable files are skipped, not fatal.
        fs::write(history.join("4-broken.json"), "{").unwrap();

        let records = list_installed_mods_at(&root, |sha| (sha == cached).then(|| format!("/cache/{sha}.zip")));
        fs::remove_dir_all(&root).ok();

        let ids: Vec<_> = records.iter().map(|record| record.campaign_id.as_str()).collect();
        assert_eq!(ids, ["yuri", "abathur"]);
        assert!(records[0].current);
        assert_eq!(records[0].campaign, "Heart of the Swarm");
        assert_eq!(records[0].cached_archive.as_deref(), Some(format!("/cache/{cached}.zip").as_str()));
        assert!(!records[1].current);
        assert_eq!(records[1].installed_at, 200);
        assert_eq!(records[1].package_sha256, "e".repeat(64));
        assert_eq!(records[1].cached_archive, None);
    }

    #[test]
    fn a_game_folder_without_history_lists_nothing() {
        let root = std::env::temp_dir().join(format!("ccm-installed-mods-empty-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let records = list_installed_mods_at(&root, |_| None);
        fs::remove_dir_all(&root).ok();
        assert!(records.is_empty());
    }

    #[test]
    fn cache_lookup_rejects_values_that_are_not_a_sha256() {
        assert_eq!(cached_archive_for("../../etc/passwd"), None);
        assert_eq!(cached_archive_for(""), None);
    }
}
