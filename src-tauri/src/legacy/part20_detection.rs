// Finding StarCraft II and the player's account the way Windows records them, so a
// non-technical player never has to browse for either.
// - The game: Blizzard's installer writes `InstallLocation` into the uninstall record.
// - Documents: may be redirected (OneDrive) and localised ("Документи"); only the
//   Known Folder API returns the real path.
// - Account names: SC2 keeps a `<Name>_<code>@<region>.lnk` shortcut per profile in
//   `Documents\StarCraft II`, pointing at `Accounts\<id>\<region>-S2-<realm>-<id>`.

#[cfg(target_os = "windows")]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `InstallLocation` of an uninstall entry such as "StarCraft II" or "Battle.net".
#[cfg(target_os = "windows")]
fn registry_install_location(product: &str) -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    for key in [
        format!(r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{product}"),
        format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{product}"),
    ] {
        let (key, value) = (wide(&key), wide("InstallLocation"));
        let mut buffer = vec![0_u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status == 0 {
            let length = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
            let path = PathBuf::from(String::from_utf16_lossy(&buffer[..length]));
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn registry_install_location(_product: &str) -> Option<PathBuf> {
    None
}

/// The user's real Documents folder (OneDrive-redirected or localised included).
#[cfg(target_os = "windows")]
fn known_documents_folder() -> Option<PathBuf> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Documents};
    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_Documents, 0, std::ptr::null_mut(), &mut raw) };
    if result != 0 || raw.is_null() {
        return None;
    }
    let path = unsafe {
        let length = (0..).take_while(|&index| *raw.add(index) != 0).count();
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(raw, length));
        CoTaskMemFree(raw.cast());
        text
    };
    Some(PathBuf::from(path))
}

#[cfg(not(target_os = "windows"))]
fn known_documents_folder() -> Option<PathBuf> {
    None
}

/// "1-S2-1-12188252" -> "Americas". Region ids as Battle.net numbers them.
fn profile_region(profile_folder: &str) -> Option<&'static str> {
    match profile_folder.split('-').next()? {
        "1" => Some("Americas"),
        "2" => Some("Europe"),
        "3" => Some("Korea"),
        "5" => Some("China"),
        "98" => Some("Test realm"),
        _ => None,
    }
}

/// "TantrumUA_830@1" -> "TantrumUA" (the code and region suffix are SC2's).
fn shortcut_player_name(stem: &str) -> &str {
    let without_region = stem.rsplit_once('@').map_or(stem, |(name, _)| name);
    match without_region.rsplit_once('_') {
        Some((name, code)) if !name.is_empty() && code.chars().all(|character| character.is_ascii_digit()) => name,
        _ => without_region,
    }
}

/// Whether a .lnk file's bytes mention `needle` (stored as ANSI or UTF-16LE).
fn shortcut_mentions(bytes: &[u8], needle: &str) -> bool {
    let ansi = needle.as_bytes();
    let utf16: Vec<u8> = needle.encode_utf16().flat_map(u16::to_le_bytes).collect();
    bytes.windows(ansi.len()).any(|window| window == ansi) || bytes.windows(utf16.len()).any(|window| window == utf16)
}

/// The player name SC2 shows for a profile folder, from the newest shortcut that
/// points at it. `sc2_documents` is `Documents\StarCraft II`.
fn profile_player_name(sc2_documents: &Path, profile_folder: &str) -> Option<String> {
    let mut best: Option<(SystemTime, String)> = None;
    for entry in fs::read_dir(sc2_documents).ok()?.flatten() {
        let path = entry.path();
        if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("lnk")) {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.len() > 64 * 1024 || !shortcut_mentions(&bytes, profile_folder) {
            continue;
        }
        let modified = entry.metadata().and_then(|metadata| metadata.modified()).unwrap_or(UNIX_EPOCH);
        let stem = path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default();
        if best.as_ref().is_none_or(|(time, _)| modified > *time) {
            best = Some((modified, shortcut_player_name(&stem).to_string()));
        }
    }
    best.map(|(_, name)| name)
}

/// "TantrumUA · Americas" for `...\StarCraft II\Accounts\<id>\1-S2-1-12188252`;
/// falls back to the region alone, then to the path.
fn profile_label(profile: &Path) -> String {
    let folder = profile.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let documents = profile.parent().and_then(Path::parent).and_then(Path::parent);
    let name = documents.and_then(|documents| profile_player_name(documents, &folder));
    match (name, profile_region(&folder)) {
        (Some(name), Some(region)) => format!("{name} · {region}"),
        (Some(name), None) => name,
        (None, Some(region)) => format!("Account {folder} · {region}"),
        (None, None) => display_profile_path(profile),
    }
}

#[cfg(test)]
mod detection_tests {
    use super::*;

    #[test]
    fn player_names_come_from_sc2_profile_shortcuts() {
        assert_eq!(shortcut_player_name("TantrumUA_830@1"), "TantrumUA");
        assert_eq!(shortcut_player_name("Smatter_382@1"), "Smatter");
        assert_eq!(shortcut_player_name("Under_score_12@2"), "Under_score");
        assert_eq!(shortcut_player_name("NoCode"), "NoCode");
        assert_eq!(profile_region("1-S2-1-12188252"), Some("Americas"));
        assert_eq!(profile_region("2-S2-2-1797368"), Some("Europe"));
        assert_eq!(profile_region("Hotkeys"), None);
    }

    #[test]
    fn labels_use_the_newest_shortcut_that_points_at_the_profile() {
        let documents = std::env::temp_dir().join(format!("ccm-sc2-docs-{}", Uuid::new_v4()));
        let profile = documents.join("Accounts/439835756/2-S2-2-1797368");
        fs::create_dir_all(&profile).unwrap();
        let target_utf16: Vec<u8> = profile.display().to_string().encode_utf16().flat_map(u16::to_le_bytes).collect();
        fs::write(documents.join("Tantrum_401@2.lnk"), [b"L\0\0\0".as_slice(), &target_utf16].concat()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(documents.join("TantrumUA_830@2.lnk"), [b"L\0\0\0".as_slice(), profile.display().to_string().as_bytes()].concat()).unwrap();
        fs::write(documents.join("Other_1@1.lnk"), b"L\0\0\0 points elsewhere").unwrap();
        let label = profile_label(&profile);
        let unnamed = documents.join("Accounts/439835756/1-S2-1-555");
        fs::create_dir_all(&unnamed).unwrap();
        let fallback = profile_label(&unnamed);
        fs::remove_dir_all(&documents).ok();
        assert_eq!(label, "TantrumUA · Europe");
        assert_eq!(fallback, "Account 1-S2-1-555 · Americas");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_documents_folder_is_resolved_through_windows() {
        let documents = known_documents_folder().expect("Known Folder API");
        assert!(documents.is_dir(), "{}", documents.display());
    }
}
