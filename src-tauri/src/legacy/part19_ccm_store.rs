// Backwards compatibility with the original SC2 Custom Campaign Manager (SC2CCM,
// github.com/7thace/SC2CCM). It keeps every mod unpacked in
// `<game>/Maps/CustomCampaigns/<folder>/`; a mod is the directory holding its
// `metadata.txt` (searched recursively, first match wins). CCM Reborn reads that
// store in place and installs a mod by packing its folder into a temporary,
// uncompressed zip that goes through the regular transactional installer.

const CCM_STORE_DIRECTORY: &str = "Maps/CustomCampaigns";
const MAX_CCM_STORE_MODS: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcmStoreMod {
    /// `ccm-<slug of the store folder>`; stable while the folder keeps its name.
    id: String,
    title: String,
    author: String,
    version: String,
    description: String,
    /// Base campaign display name, e.g. "Heart of the Swarm".
    campaign: String,
    target_path: String,
    /// The folder's name directly under `Maps/CustomCampaigns`.
    folder: String,
    size: u64,
}

fn ccm_mod_id(folder: &str, used: &mut HashSet<String>) -> String {
    let mut slug = String::new();
    for character in folder.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(64).collect();
    let base = format!("ccm-{}", if slug.is_empty() { "mod" } else { slug.trim_end_matches('-') });
    let mut id = base.clone();
    let mut suffix = 2;
    while !used.insert(id.clone()) {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }
    id
}

/// The original CCM's rule: the first `metadata.txt` found under the folder.
/// Files of a directory come before its subdirectories; names are sorted so the
/// pick is stable.
fn find_ccm_metadata(directory: &Path) -> Option<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(directory).ok()?.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    let mut subdirectories = Vec::new();
    for entry in entries {
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_file() && entry.file_name().to_string_lossy().eq_ignore_ascii_case("metadata.txt") {
            return Some(entry.path());
        }
        if file_type.is_dir() {
            subdirectories.push(entry.path());
        }
    }
    subdirectories.iter().find_map(|subdirectory| find_ccm_metadata(subdirectory))
}

fn read_ccm_store_mod(folder_path: &Path, folder: &str, used_ids: &mut HashSet<String>) -> Option<CcmStoreMod> {
    let metadata_path = find_ccm_metadata(folder_path)?;
    if fs::metadata(&metadata_path).ok()?.len() > MAX_METADATA_BYTES {
        return None;
    }
    let metadata = decode_ccm_metadata(&fs::read(&metadata_path).ok()?).ok()?;
    let target_path = campaign_target_from_metadata(&metadata).ok()?;
    let campaign = campaign_display_for_target(&target_path).ok()?;
    let mod_root = metadata_path.parent()?;
    let size = collect_regular_files(mod_root)
        .ok()?
        .iter()
        .filter_map(|file| fs::metadata(file).ok())
        .map(|metadata| metadata.len())
        .sum();
    Some(CcmStoreMod {
        id: ccm_mod_id(folder, used_ids),
        title: metadata_field(&metadata, "title").unwrap_or_else(|| folder.to_string()),
        author: metadata_field(&metadata, "author").unwrap_or_default(),
        version: metadata_field(&metadata, "version").unwrap_or_default(),
        description: metadata_field(&metadata, "desc").unwrap_or_default(),
        campaign: campaign.to_string(),
        target_path,
        folder: folder.to_string(),
        size,
    })
}

/// Read-only. Folders without a usable metadata.txt are skipped, as the original
/// CCM does.
fn list_ccm_store_at(root: &Path) -> Vec<CcmStoreMod> {
    let Ok(entries) = fs::read_dir(root.join(CCM_STORE_DIRECTORY)) else {
        return Vec::new();
    };
    let mut folders: Vec<_> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|file_type| file_type.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect();
    folders.sort();
    let mut used_ids = HashSet::new();
    folders
        .iter()
        .filter_map(|folder| read_ccm_store_mod(&root.join(CCM_STORE_DIRECTORY).join(folder), folder, &mut used_ids))
        .take(MAX_CCM_STORE_MODS)
        .collect()
}

/// Packs a store mod (the directory holding its metadata.txt) into an uncompressed
/// zip at `destination`. Returns its SHA-256 and size for the install request.
fn pack_ccm_store_mod(root: &Path, store_mod: &CcmStoreMod, destination: &Path) -> Result<(String, u64), String> {
    let folder_path = root.join(CCM_STORE_DIRECTORY).join(&store_mod.folder);
    let metadata_path = find_ccm_metadata(&folder_path)
        .ok_or_else(|| format!("{} no longer has a metadata.txt.", store_mod.folder))?;
    let mod_root = metadata_path.parent().ok_or("Invalid CCM mod folder.")?;
    let files = collect_regular_files(mod_root)?;
    validate_archive_entry_count(files.len())?;
    let outcome = (|| -> Result<(), String> {
        let mut writer = zip::ZipWriter::new(File::create(destination).map_err(io_error)?);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);
        for file in &files {
            let relative = file.strip_prefix(mod_root).map_err(|_| "CCM mod file escaped its folder.")?;
            writer.start_file(path_string(relative), options).map_err(|error| error.to_string())?;
            io::copy(&mut File::open(file).map_err(io_error)?, &mut writer).map_err(io_error)?;
        }
        writer.finish().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = outcome {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok((sha256_file(destination)?, fs::metadata(destination).map_err(io_error)?.len()))
}

/// The store mod a slot currently holds, if the slot's metadata.txt matches one
/// (same campaign, title and version), i.e. it was activated by the original CCM.
fn adopted_ccm_store_mod(root: &Path, target_path: &str) -> Option<String> {
    let bytes = fs::read(root.join(target_path).join("metadata.txt")).ok()?;
    let metadata = decode_ccm_metadata(&bytes).ok()?;
    if campaign_target_from_metadata(&metadata).ok()? != target_path {
        return None;
    }
    let title = metadata_field(&metadata, "title")?;
    let version = metadata_field(&metadata, "version").unwrap_or_default();
    list_ccm_store_at(root)
        .into_iter()
        .find(|store_mod| store_mod.target_path == target_path && store_mod.title == title && store_mod.version == version)
        .map(|store_mod| store_mod.id)
}

/// "Original <campaign>" on a slot the original CCM filled and CCM Reborn never
/// managed: record the slot's current files as that store mod's (exact hashes, no
/// copies) so the regular Restore can switch its saves away and empty the slot.
/// Returns false when the slot holds nothing recognisable from the store.
fn adopt_ccm_slot_in_place(root: &Path, target_path: &str) -> Result<bool, String> {
    if read_state_for_target(root, target_path)?.is_some() {
        return Ok(false);
    }
    let Some(id) = adopted_ccm_store_mod(root, target_path) else {
        return Ok(false);
    };
    let store_mod = list_ccm_store_at(root)
        .into_iter()
        .find(|store_mod| store_mod.id == id)
        .ok_or("The original CCM's mod disappeared while reading it.")?;
    let mut files = Vec::new();
    for file in collect_campaign_target_files(root, target_path)? {
        let relative = file.strip_prefix(root).map_err(|_| "Campaign file escaped the game folder.")?;
        files.push(ManagedFile {
            destination: path_string(relative),
            original_existed: false,
            backup_path: None,
            installed_sha256: Some(sha256_file(&file)?),
        });
    }
    let backup_dir = format!("backups/{id}-{}", Uuid::new_v4());
    fs::create_dir_all(manager_root(root).join(&backup_dir)).map_err(io_error)?;
    let state = ManagedState {
        format: 1,
        campaign_id: id.clone(),
        title: store_mod.title,
        author: store_mod.author,
        version: store_mod.version,
        target_path: target_path.to_string(),
        installed_at: unix_timestamp(),
        backup_dir,
        cleared_directories: vec![target_path.to_string()],
        files,
        adopted_from: Some(id),
    };
    validate_managed_state(&state)?;
    write_state_for_target(root, &state)?;
    Ok(true)
}

#[tauri::command]
async fn list_ccm_store(game_dir: String) -> Result<Vec<CcmStoreMod>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = require_desktop_game_root(&game_dir)?;
        Ok(list_ccm_store_at(&root))
    })
    .await
    .map_err(|error| format!("CCM store worker failed: {error}"))?
}

#[tauri::command]
async fn install_ccm_store_mod(
    window: tauri::Window,
    game_dir: String,
    profile_dir: Option<String>,
    id: String,
) -> Result<InstallResult, String> {
    let reporter = ProgressReporter::new(window);
    tauri::async_runtime::spawn_blocking(move || {
        let root = require_desktop_game_root(&game_dir)?;
        let store_mod = list_ccm_store_at(&root)
            .into_iter()
            .find(|candidate| candidate.id == id)
            .ok_or("That mod is no longer in the original CCM's folder.")?;
        reporter.status("packing", "Reading the mod from the original CCM's folder…");
        let temporary = std::env::temp_dir().join("ccm-reborn");
        fs::create_dir_all(&temporary).map_err(io_error)?;
        let archive = temporary.join(format!("ccm-store-{}.zip", Uuid::new_v4()));
        let (sha256, size) = pack_ccm_store_mod(&root, &store_mod, &archive)?;
        let request = InstallRequest {
            campaign_id: store_mod.id,
            title: store_mod.title,
            author: store_mod.author,
            version: store_mod.version,
            profile_dir,
            archive_source: path_string(&archive),
            sha256,
            package_size: Some(size),
            game_dir: root.display().to_string(),
        };
        let result = install_campaign_with_progress(request, Some(&reporter));
        let _ = fs::remove_file(&archive);
        result
    })
    .await
    .map_err(|error| format!("Installation worker failed: {error}"))?
}

#[cfg(test)]
mod ccm_store_tests {
    use super::*;

    fn store_with(mods: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ccm-store-{}", Uuid::new_v4()));
        for (relative, contents) in mods {
            let path = root.join(CCM_STORE_DIRECTORY).join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        root
    }

    #[test]
    fn lists_store_mods_like_the_original_ccm() {
        let files = [
            ("RaynorRogue (2)/metadata.txt", "title=Raynor has Gone Rogue(like)!\nauthor=Redfrog\nversion=1.07\ncampaign=WoL\n"),
            ("RaynorRogue (2)/traynor01.SC2Map", "map"),
            // Nested like a Google Drive download; padded title like Contingency Contracts.
            ("Artanis-001/Artanis has Gone Rogue(like)/metadata.txt", "title= Artanis\r\ncampaign=LotV\r\n"),
            ("Artanis-001/Artanis has Gone Rogue(like)/apilot01.SC2Map", "map!"),
            ("Jogress challenges/economy.SC2Map", "no metadata"),
            ("Broken/metadata.txt", "title=Broken\ncampaign=Starcraft 3\n"),
            ("RaynorRogue  (2)/metadata.txt", "title=Twin\ncampaign=WoL\n"),
        ];
        let size_of = |folder: &str| files.iter().filter(|(path, _)| path.starts_with(folder)).map(|(_, text)| text.len() as u64).sum::<u64>();
        let root = store_with(&files);
        let mods = list_ccm_store_at(&root);
        fs::remove_dir_all(&root).ok();

        let summary: Vec<_> = mods.iter().map(|item| (item.id.as_str(), item.title.as_str(), item.campaign.as_str(), item.size)).collect();
        assert_eq!(summary, [
            ("ccm-artanis-001", "Artanis", "Legacy of the Void", size_of("Artanis-001/")),
            // "RaynorRogue  (2)" sorts before "RaynorRogue (2)" and takes the plain id.
            ("ccm-raynorrogue-2", "Twin", "Wings of Liberty", size_of("RaynorRogue  (2)/")),
            ("ccm-raynorrogue-2-2", "Raynor has Gone Rogue(like)!", "Wings of Liberty", size_of("RaynorRogue (2)/")),
        ]);
        assert_eq!(mods[2].author, "Redfrog");
        assert_eq!(mods[2].target_path, "Maps/Campaign");
    }

    /// Opt-in check against a real install, read-only on the store:
    /// `CCM_REAL_GAME_ROOT="E:/Games/SC2/StarCraft II" cargo test real_store -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_store_mods_pass_the_installers_package_checks() {
        let Some(root) = std::env::var_os("CCM_REAL_GAME_ROOT").map(PathBuf::from) else { return };
        let temporary = std::env::temp_dir().join(format!("ccm-real-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&temporary).unwrap();
        let mut failures = Vec::new();
        for store_mod in list_ccm_store_at(&root) {
            let archive = temporary.join(format!("{}.zip", store_mod.id));
            let checked = pack_ccm_store_mod(&root, &store_mod, &archive).and_then(|_| {
                let package = read_ccm_package(&archive)?;
                let files = inspect_ccm_package_files(&archive, &package)?;
                refuse_nested_wol_package(&package.target_path, &files)?;
                Ok(files.len())
            });
            let _ = fs::remove_file(&archive);
            match checked {
                Ok(count) => println!("ok   {} ({count} files)", store_mod.id),
                Err(error) => {
                    println!("FAIL {}: {error}", store_mod.id);
                    failures.push(store_mod.id);
                }
            }
        }
        fs::remove_dir_all(&temporary).ok();
        assert!(failures.is_empty(), "{failures:?}");
    }

    /// A game folder where the original CCM activated `KHGR` in the HotS slot,
    /// plus a new package to install over it.
    fn ccm_activated_game(slot_metadata: &str) -> (PathBuf, PathBuf) {
        let root = store_with(&[
            ("KHGR/metadata.txt", "title=Kerrigan Rogue\ncampaign=HotS\nversion=1.45.0\n"),
            ("KHGR/zchar01.SC2Map", "ccm mission"),
        ]);
        let slot = root.join("Maps/Campaign/swarm");
        fs::create_dir_all(&slot).unwrap();
        fs::write(slot.join("metadata.txt"), slot_metadata).unwrap();
        fs::write(slot.join("zchar01.SC2Map"), "ccm mission").unwrap();
        fs::write(slot.join("zchar02.SC2Map"), "ccm mission 2").unwrap();
        fs::create_dir_all(root.join("Mods")).unwrap();
        fs::write(root.join("Mods/Shared.SC2Mod"), "ccm dependency").unwrap();

        let archive = root.join("new.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, contents) in [
            ("New/metadata.txt", "title=New Mod\ncampaign=HotS\nversion=2\n"),
            ("New/zchar01.SC2Map", "new mission"),
            ("New/Shared.SC2Mod", "new dependency"),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        (root, archive)
    }

    fn install_new(root: &Path, archive: &Path) -> ManagedState {
        let request = InstallRequest {
            campaign_id: "new-mod".into(), title: "New Mod".into(), author: String::new(), version: "2".into(),
            profile_dir: None, archive_source: path_string(archive), sha256: sha256_file(archive).unwrap(),
            package_size: None, game_dir: path_string(root),
        };
        install_archive(root, &request, archive, &request.sha256, None).unwrap();
        read_state_for_target(root, "Maps/Campaign/swarm").unwrap().unwrap()
    }

    #[test]
    fn taking_over_a_ccm_activated_slot_restores_to_blizzards_campaign() {
        let (root, archive) = ccm_activated_game("title=Kerrigan Rogue\ncampaign=HotS\nversion=1.45.0\n");
        assert_eq!(adopted_ccm_store_mod(&root, "Maps/Campaign/swarm").as_deref(), Some("ccm-khgr"));
        let state = install_new(&root, &archive);
        assert_eq!(state.adopted_from.as_deref(), Some("ccm-khgr"));

        restore_original_campaigns_blocking(path_string(&root), None, "Maps/Campaign/swarm".into()).unwrap();
        let slot = root.join("Maps/Campaign/swarm");
        let left: Vec<_> = fs::read_dir(&slot).unwrap().flatten().map(|entry| entry.file_name()).collect();
        let dependency = fs::read_to_string(root.join("Mods/Shared.SC2Mod")).unwrap();
        let store_kept = root.join(CCM_STORE_DIRECTORY).join("KHGR/zchar01.SC2Map").is_file();
        fs::remove_dir_all(&root).ok();

        assert!(left.is_empty(), "slot should be empty (Blizzard's campaign), found {left:?}");
        assert_eq!(dependency, "ccm dependency", "Mods/ dependencies still get their previous version back");
        assert!(store_kept, "the original CCM's store is never touched");
    }

    #[test]
    fn original_on_a_slot_ccm_reborn_never_managed_empties_it() {
        let (root, _archive) = ccm_activated_game("title=Kerrigan Rogue\ncampaign=HotS\nversion=1.45.0\n");
        let restored = restore_original_campaigns_blocking(path_string(&root), None, "Maps/Campaign/swarm".into()).unwrap();
        let left: Vec<_> = fs::read_dir(root.join("Maps/Campaign/swarm")).unwrap().flatten().map(|entry| entry.file_name()).collect();
        let state_left = read_state_for_target(&root, "Maps/Campaign/swarm").unwrap().is_some();
        let store_kept = root.join(CCM_STORE_DIRECTORY).join("KHGR/zchar01.SC2Map").is_file();
        let dependency = fs::read_to_string(root.join("Mods/Shared.SC2Mod")).unwrap();
        fs::remove_dir_all(&root).ok();

        assert!(restored.conflicts.is_empty());
        assert!(left.is_empty(), "slot should be empty, found {left:?}");
        assert!(!state_left);
        assert!(store_kept);
        assert_eq!(dependency, "ccm dependency", "the old CCM's Mods/ dependency is left alone");
    }

    #[test]
    fn an_adopted_slots_empty_backup_still_yields_a_readable_journal() {
        // Regression (owner's machine, 2026-10-05): restore after adopting in place
        // failed with "Pending install journal is missing the previous-install backup".
        let (root, _archive) = ccm_activated_game("title=Kerrigan Rogue\ncampaign=HotS\nversion=1.45.0\n");
        assert!(adopt_ccm_slot_in_place(&root, "Maps/Campaign/swarm").unwrap());
        let staging = manager_root(&root).join("staging/restore-test");
        fs::create_dir_all(&staging).unwrap();
        let previous_install = snapshot_previous_install(&root, &staging, "Maps/Campaign/swarm").unwrap();
        write_pending_install_journal(&root, &PendingInstallJournal {
            format: 1,
            profile_transaction: ProfileTransaction { entries: Vec::new() },
            profile_roots: Vec::new(),
            previous_install,
            new_state: None,
            completed: false,
        }).unwrap();
        let read = read_pending_install_journal(&root);
        fs::remove_dir_all(&root).ok();
        assert!(read.is_ok(), "{read:?}");
    }

    #[test]
    fn original_does_nothing_to_an_unrecognised_unmanaged_slot() {
        let (root, _archive) = ccm_activated_game("title=Something Else\ncampaign=HotS\nversion=1\n");
        let restored = restore_original_campaigns_blocking(path_string(&root), None, "Maps/Campaign/swarm".into()).unwrap();
        let mission = fs::read_to_string(root.join("Maps/Campaign/swarm/zchar02.SC2Map")).ok();
        fs::remove_dir_all(&root).ok();
        assert_eq!(restored.restored_files, 0);
        assert_eq!(mission.as_deref(), Some("ccm mission 2"));
    }

    #[test]
    fn unrecognised_slot_content_is_still_restored_exactly() {
        // Not in the store (version differs), so it can't be recovered from there:
        // keep today's behaviour and bring it back.
        let (root, archive) = ccm_activated_game("title=Kerrigan Rogue\ncampaign=HotS\nversion=0.9\n");
        assert_eq!(adopted_ccm_store_mod(&root, "Maps/Campaign/swarm"), None);
        let state = install_new(&root, &archive);
        assert_eq!(state.adopted_from, None);

        restore_original_campaigns_blocking(path_string(&root), None, "Maps/Campaign/swarm".into()).unwrap();
        let slot = root.join("Maps/Campaign/swarm");
        let mission = fs::read_to_string(slot.join("zchar02.SC2Map")).ok();
        fs::remove_dir_all(&root).ok();
        assert_eq!(mission.as_deref(), Some("ccm mission 2"));
    }

    #[test]
    fn a_packed_store_mod_reads_as_a_regular_ccm_package() {
        let root = store_with(&[
            ("KHGR/metadata.txt", "title=Kerrigan\ncampaign=HotS\nversion=1.45.0\n"),
            ("KHGR/zchar01.SC2Map", "map"),
            ("KHGR/evolution/zevolution.SC2Map", "evo"),
        ]);
        let store_mod = list_ccm_store_at(&root).remove(0);
        let archive = root.join("packed.zip");
        let (sha256, size) = pack_ccm_store_mod(&root, &store_mod, &archive).unwrap();
        let package = read_ccm_package(&archive).unwrap();
        let files = inspect_ccm_package_files(&archive, &package).unwrap();
        let actual_hash = sha256_file(&archive).unwrap();
        fs::remove_dir_all(&root).ok();

        assert_eq!(package.target_path, "Maps/Campaign/swarm");
        let mut destinations: Vec<_> = files.iter().map(|file| file.destination.clone()).collect();
        destinations.sort();
        // metadata.txt travels too: it is how both CCMs tell which mod is active.
        assert_eq!(destinations, [
            "Maps/Campaign/swarm/evolution/zevolution.SC2Map",
            "Maps/Campaign/swarm/metadata.txt",
            "Maps/Campaign/swarm/zchar01.SC2Map",
        ]);
        assert_eq!(sha256, actual_hash);
        assert!(size > 0);
    }
}
