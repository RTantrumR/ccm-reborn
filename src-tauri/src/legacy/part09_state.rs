fn read_state(root: &Path) -> Result<Option<ManagedState>, String> {
    validate_manager_root(root)?;
    let path = state_path(root);
    if !path.is_file() {
        return Ok(None);
    }
    read_state_file(&path).map(Some)
}

/// Return the record for one exact campaign target. Legacy state.json is
/// treated as the record for its own target only; it is never a predecessor
/// for another slot.
fn read_state_for_target(root: &Path, target: &str) -> Result<Option<ManagedState>, String> {
    let path = state_path_for_target(root, target)?;
    if path.is_file() {
        let state = read_state_file(&path)?;
        if state.target_path_or_first_clear() != target {
            return Err("Managed slot state does not match its target filename; no files were changed.".into());
        }
        return Ok(Some(state));
    }
    let legacy = read_state(root)?;
    Ok(legacy.filter(|state| state.target_path_or_first_clear() == target))
}

fn write_state_for_target(root: &Path, state: &ManagedState) -> Result<(), String> {
    ensure_manager_root(root)?;
    let target = state.target_path_or_first_clear();
    write_json_atomic(&state_path_for_target(root, &target)?, state)?;
    if read_state(root)?.is_some_and(|legacy| legacy.target_path_or_first_clear() == target) {
        fs::remove_file(state_path(root)).map_err(io_error)?;
    }
    Ok(())
}

fn remove_state_for_target(root: &Path, state: &ManagedState) -> Result<(), String> {
    validate_manager_root(root)?;
    let target = state.target_path_or_first_clear();
    let target_state_path = state_path_for_target(root, &target)?;
    if target_state_path.is_file() {
        fs::remove_file(target_state_path).map_err(io_error)?;
    }
    if read_state(root)?.is_some_and(|legacy| legacy.target_path_or_first_clear() == target) {
        fs::remove_file(state_path(root)).map_err(io_error)?;
    }
    Ok(())
}

fn read_managed_states(root: &Path) -> Result<Vec<ManagedState>, String> {
    validate_manager_root(root)?;
    let mut states = Vec::new();
    let mut targets = HashSet::new();
    let states_root = manager_root(root).join("states");
    if states_root.is_dir() {
        for entry in fs::read_dir(states_root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if entry.file_type().map_err(io_error)?.is_file()
                && entry.path().extension().and_then(|extension| extension.to_str()) == Some("json")
            {
                let state = read_state_file(&entry.path())?;
                let target = state.target_path_or_first_clear();
                if state_path_for_target(root, &target)? != entry.path() || !targets.insert(target) {
                    return Err("Managed slot states are ambiguous or do not match their filenames; no files were changed.".into());
                }
                states.push(state);
            }
        }
    }
    if let Some(legacy) = read_state(root)? {
        let legacy_target = legacy.target_path_or_first_clear();
        if !states.iter().any(|state| state.target_path_or_first_clear() == legacy_target) {
            states.push(legacy);
        }
    }
    states.sort_by(|left, right| left.target_path_or_first_clear().cmp(&right.target_path_or_first_clear()));
    Ok(states)
}

fn read_state_file(path: &Path) -> Result<ManagedState, String> {
    let json = fs::read_to_string(path).map_err(io_error)?;
    let mut state: ManagedState = serde_json::from_str(&json)
        .map_err(|_| "Managed installation state is corrupt; no files were changed.".to_string())?;
    validate_managed_state(&state)?;
    state.files = merge_case_duplicates(std::mem::take(&mut state.files));
    Ok(state)
}

/// The key two game paths share when they name the same file. Windows and
/// macOS file systems ignore letter case, so `BankList.xml` and `banklist.xml`
/// are one file there.
fn path_key(path: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

/// States written before installs compared paths by `path_key` can list one
/// file twice: the previous mod's copy (`BankList.xml`, backed up) and the
/// package's (`banklist.xml`). Fold each pair into one record, so the restore
/// check compares the file with what the package wrote, and a restore puts
/// the backup back instead of deleting it again as a package-only file.
fn merge_case_duplicates(files: Vec<ManagedFile>) -> Vec<ManagedFile> {
    let mut merged: Vec<ManagedFile> = Vec::with_capacity(files.len());
    let mut positions = HashMap::new();
    for file in files {
        let Some(&position) = positions.get(&path_key(&file.destination)) else {
            positions.insert(path_key(&file.destination), merged.len());
            merged.push(file);
            continue;
        };
        let kept: &mut ManagedFile = &mut merged[position];
        kept.original_existed |= file.original_existed;
        if kept.backup_path.is_none() {
            kept.backup_path = file.backup_path;
        }
        // The package copied its files last, so its name and hash are what's on disk.
        if file.installed_sha256.is_some() {
            kept.installed_sha256 = file.installed_sha256;
            kept.destination = file.destination;
        }
    }
    merged
}

fn validate_managed_state(state: &ManagedState) -> Result<(), String> {
    if state.format != 1 {
        return Err("Managed installation state has an unsupported format.".into());
    }
    validate_campaign_id(&state.campaign_id)?;
    let _ = safe_backup_path(&state.backup_dir)?;
    let target = state.target_path_or_first_clear();
    let target_path = safe_campaign_target(&target)?;
    let mut campaign_roots = vec![target_path.clone()];
    for file in &state.files {
        let destination = safe_relative_path(&file.destination)?;
        if destination.starts_with(MANAGER_DIRECTORY) {
            return Err("Managed installation state has an invalid destination.".into());
        }
        let is_target_file = destination.strip_prefix(&target_path).ok().is_some_and(|relative| {
            if target_path != Path::new("Maps/Campaign") { return true; }
            let mut components = relative.components();
            let first = components.next();
            components.next().is_none()
                || matches!(first, Some(Component::Normal(name)) if is_wol_owned_asset_directory(name))
        });
        if !is_target_file && !destination.starts_with("Mods") {
            let root = campaign_root_for_destination(&target_path, &destination)?;
            if !campaign_roots.contains(&root) {
                campaign_roots.push(root);
            }
        }
        if let Some(backup) = &file.backup_path {
            let _ = safe_backup_path(backup)?;
        }
    }
    let cleared_roots = state
        .cleared_directories
        .iter()
        .map(|directory| safe_campaign_root(directory))
        .collect::<Result<Vec<_>, _>>()?;
    if cleared_roots != campaign_roots {
        return Err("Managed installation state has invalid campaign roots.".into());
    }
    Ok(())
}
