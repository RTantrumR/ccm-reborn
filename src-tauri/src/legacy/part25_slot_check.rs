// Before a switch retires a slot's mod, its files are compared with what was
// recorded at install: files the player changed since, and backups of what was
// there before that have gone missing. Either stops the switch until the player
// chooses: keep a copy of their changes, or switch without the lost backups.

/// What the player chose for the problems `check_slot_switch` reported.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SwitchOptions {
    keep_changed: bool,
    allow_missing_backups: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotCheck {
    title: String,
    changed: usize,
    missing_backups: usize,
}

#[derive(Debug, Default)]
struct SlotProblems {
    // Changed or removed since the install, compared with what it wrote (or,
    // for a file it didn't write, with the backup of what was there before).
    changed: Vec<String>,
    // Backups a restore would copy back that are gone.
    missing_backups: Vec<String>,
}

fn slot_problems(root: &Path, state: &ManagedState) -> Result<SlotProblems, String> {
    let mut problems = SlotProblems::default();
    let shared_roots = shared_dependency_roots(root, state)?;
    let mut baseline_roots = HashSet::new();
    for dependency_root in dependency_roots_from_managed_files(&state.files) {
        if read_shared_baseline(root, &dependency_root)?.is_some() {
            baseline_roots.insert(dependency_root);
        }
    }
    for file in &state.files {
        if destination_is_under_roots(&file.destination, &shared_roots) {
            continue;
        }
        let destination = safe_game_path(root, &safe_relative_path(&file.destination)?)?;
        let backup = match file.backup_path.as_deref() {
            Some(path) => Some(manager_root(root).join(safe_backup_path(path)?)).filter(|path| path.is_file()),
            None => None,
        };
        // As `force_restore` decides: an adopted slot is emptied, and a Mods
        // folder with a shared baseline comes back from that baseline.
        let adopted_slot_file = state.adopted_from.is_some()
            && dependency_root_from_destination(Path::new(&file.destination)).is_none();
        if file.original_existed && backup.is_none() && !adopted_slot_file
            && !destination_is_under_roots(&file.destination, &baseline_roots)
        {
            problems.missing_backups.push(file.destination.clone());
        }
        if !destination.is_file() {
            // A file that was there before may be gone because the package
            // replaced its folder; one the package wrote must still exist.
            if file.installed_sha256.is_some() {
                problems.changed.push(file.destination.clone());
            }
            continue;
        }
        let expected = match (&file.installed_sha256, &backup) {
            (Some(hash), _) => Some(hash.clone()),
            (None, Some(backup)) => sha256_file(backup).ok(),
            (None, None) => None,
        };
        if expected.is_some_and(|expected| sha256_file(&destination).ok() != Some(expected)) {
            problems.changed.push(file.destination.clone());
        }
    }
    Ok(problems)
}

/// Copies the player's changed files out of the game before a switch puts the
/// recorded ones back. Returns the folder, or None when nothing is left to keep.
fn keep_changed_files(root: &Path, state: &ManagedState, changed: &[String]) -> Result<Option<String>, String> {
    let mut folder = None;
    for destination in changed {
        let relative = safe_relative_path(destination)?;
        let current = safe_game_path(root, &relative)?;
        if !current.is_file() {
            continue;
        }
        let folder = folder.get_or_insert_with(|| {
            kept_files_root(root).join(format!("{}-{}", state.campaign_id, unix_timestamp()))
        });
        copy_file(&current, &folder.join(relative))?;
    }
    Ok(folder.map(|folder| folder.display().to_string()))
}

fn kept_files_root(root: &Path) -> PathBuf {
    manager_root(root).join("kept-files")
}

fn check_slot_switch_at(root: &Path, target_path: &str) -> Result<SlotCheck, String> {
    let target = path_string(&safe_campaign_target(target_path)?);
    let Some(state) = read_state_for_target(root, &target)? else {
        return Ok(SlotCheck::default());
    };
    let problems = slot_problems(root, &state)?;
    Ok(SlotCheck {
        title: state.title,
        changed: problems.changed.len(),
        missing_backups: problems.missing_backups.len(),
    })
}

/// Read-only: what a switch away from this slot's mod would find.
#[tauri::command]
async fn check_slot_switch(game_dir: String, target_path: String) -> Result<SlotCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = require_desktop_game_root(&game_dir)?;
        check_slot_switch_at(&root, &target_path)
    })
    .await
    .map_err(|error| format!("Slot check worker failed: {error}"))?
}

/// Opens a folder `keep_changed_files` made; nothing else.
#[tauri::command]
async fn open_kept_files(game_dir: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = require_desktop_game_root(&game_dir)?;
        let kept_root = fs::canonicalize(kept_files_root(&root)).map_err(io_error)?;
        let folder = fs::canonicalize(&path).map_err(io_error)?;
        if folder.parent() != Some(kept_root.as_path()) || !folder.is_dir() {
            return Err("That folder isn't one CCM Reborn kept files in.".into());
        }
        #[cfg(target_os = "windows")]
        let mut command = Command::new("explorer");
        #[cfg(target_os = "macos")]
        let mut command = Command::new("open");
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = Command::new("xdg-open");
        // The path as handed out; Explorer doesn't take canonical `\\?\` paths.
        command.arg(&path).spawn().map_err(|error| format!("Could not open the folder: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Folder worker failed: {error}"))?
}
