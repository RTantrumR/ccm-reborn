// Deleting a mod from My Mods (owner rulings 2026-10-10). Always: the app's own copies
// (a mod added from the PC or kept for later, the cached Library download) and its install
// history. On request: the original files (the ZIP a mod was added from, or its folder in
// the original CCM's store) and its saves in CCM Reborn's save store. The mod playing in a
// campaign right now is refused: the player switches away first.

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DeleteModOptions {
    delete_original: bool,
    delete_saves: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteModResult {
    deleted_original: bool,
    deleted_saves: bool,
}

struct DeletePlaces<'a> {
    game: &'a Path,
    local: &'a Path,
    // The account's save store and the old, account-less one.
    save_stores: Vec<PathBuf>,
    cache: &'a dyn Fn(&str) -> Option<PathBuf>,
}

const SLOT_TARGETS: [&str; 4] = ["Maps/Campaign", "Maps/Campaign/swarm", "Maps/Campaign/void", "Maps/Campaign/nova"];

fn mod_is_playing(game: &Path, id: &str) -> Result<bool, String> {
    if read_managed_states(game)?.iter().any(|state| state.campaign_id == id) {
        return Ok(true);
    }
    // A mod the original CCM put in a slot CCM Reborn never managed.
    Ok(SLOT_TARGETS.iter().any(|target| adopted_ccm_store_mod(game, target).as_deref() == Some(id)))
}

fn remove_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) && fs::remove_file(path).is_ok()
}

fn remove_regular_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) && fs::remove_dir_all(path).is_ok()
}

fn delete_mod_at(places: &DeletePlaces, id: &str, options: DeleteModOptions) -> Result<DeleteModResult, String> {
    validate_campaign_id(id)?;
    // Blizzard's campaigns' saves, and the save store's own account folder, are not mods.
    if id.starts_with("vanilla-") || id == "accounts" {
        return Err("That isn't a mod CCM Reborn can delete.".into());
    }
    if mod_is_playing(places.game, id)? {
        return Err("That mod is playing right now. Switch its campaign to another mod or the original first.".into());
    }
    let mut result = DeleteModResult::default();
    let mut hashes = Vec::new();

    // Added from the PC, or a Library download kept for later.
    let mut local = read_local_mods_strict(places.local)?;
    if let Some(position) = local.iter().position(|record| record.id == id) {
        let record = local.remove(position);
        write_local_mods(places.local, &local)?;
        remove_regular_file(&local_mod_archive_directory(places.local).join(&record.archive_file));
        hashes.push(record.sha256.clone());
        if options.delete_original {
            if let Some(source) = record.source_path.as_deref().map(Path::new) {
                let zip = source.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
                result.deleted_original |= zip && remove_regular_file(source);
            }
        }
    }

    // Installed before: its retired install records, and the downloads cached for them.
    if let Ok(entries) = fs::read_dir(manager_root(places.game).join("installed").join("history")) {
        for path in entries.flatten().map(|entry| entry.path()) {
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            if let Ok(manifest) = profile_core::read_installed_manifest(&path) {
                if manifest.campaign_id == id && remove_regular_file(&path) {
                    hashes.push(manifest.package_sha256);
                }
            }
        }
    }
    for hash in hashes {
        if let Some(path) = (places.cache)(&hash) {
            remove_regular_file(&path);
        }
    }

    // The original CCM's folder for it.
    if options.delete_original {
        if let Some(store_mod) = list_ccm_store_at(places.game).into_iter().find(|store_mod| store_mod.id == id) {
            let folder = Path::new(&store_mod.folder);
            let single = folder.components().count() == 1 && matches!(folder.components().next(), Some(Component::Normal(_)));
            result.deleted_original |= single && remove_regular_dir(&places.game.join(CCM_STORE_DIRECTORY).join(folder));
        }
    }

    if options.delete_saves {
        for store in &places.save_stores {
            result.deleted_saves |= remove_regular_dir(&store.join(id));
        }
    }
    Ok(result)
}

#[tauri::command]
async fn delete_mod(
    game_dir: String,
    profile_dir: Option<String>,
    id: String,
    options: DeleteModOptions,
) -> Result<DeleteModResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let game = require_desktop_game_root(&game_dir)?;
        // Not while a switch is moving this mod's files or saves.
        let _operation_lock = acquire_operation_lock(&game)?;
        let local = local_mod_root()?;
        let mut save_stores = Vec::new();
        if options.delete_saves {
            let profile = select_starcraft_profile(profile_dir.as_deref())?
                .ok_or("Choose your StarCraft II account in Settings first.")?;
            save_stores.push(profile_store_base_for(&profile.path)?);
            save_stores.push(profile_store_base()?);
        }
        let cache = |hash: &str| if is_sha256_hex(hash) { archive_cache_path(hash).ok() } else { None };
        delete_mod_at(&DeletePlaces { game: &game, local: &local, save_stores, cache: &cache }, &id, options)
    })
    .await
    .map_err(|error| format!("Delete worker failed: {error}"))?
}
