// Closing StarCraft II for a switch. Asked to quit mid-mission, the game only shows its
// own "Confirm Exit" box, so the app quick-saves the mission first (Ctrl+Q, the game's
// default), keeps that save under a readable name, puts the player's previous quick
// save back and then ends the process. In the menus nothing can be lost, so the game
// is asked to quit and ended if it still runs a few seconds later.

const QUICK_SAVE_FILE: &str = "Quick Save.SC2Save";

/// Reads Blizzard's tagged ("versioned") encoding used by `save.details`.
struct VersionedReader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> VersionedReader<'a> {
    fn byte(&mut self) -> Option<u8> {
        let value = *self.bytes.get(self.at)?;
        self.at += 1;
        Some(value)
    }

    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(count)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }

    /// Little-endian 7-bit groups; the lowest bit of the result is the sign.
    fn varint(&mut self) -> Option<i64> {
        let mut value: u64 = 0;
        let mut shift = 0;
        loop {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
        let magnitude = (value >> 1) as i64;
        Some(if value & 1 == 1 { -magnitude } else { magnitude })
    }

    fn count(&mut self) -> Option<usize> {
        usize::try_from(self.varint()?).ok()
    }

    fn skip_value(&mut self, depth: usize) -> Option<()> {
        if depth > 32 {
            return None;
        }
        match self.byte()? {
            0 => (0..self.count()?).try_for_each(|_| self.skip_value(depth + 1)),
            1 => {
                let bits = self.count()?;
                self.take(bits.div_ceil(8)).map(|_| ())
            }
            2 => {
                let length = self.count()?;
                self.take(length).map(|_| ())
            }
            3 => {
                self.varint()?;
                self.skip_value(depth + 1)
            }
            4 => match self.byte()? {
                0 => Some(()),
                _ => self.skip_value(depth + 1),
            },
            5 => (0..self.count()?).try_for_each(|_| {
                self.varint()?;
                self.skip_value(depth + 1)
            }),
            6 => self.take(1).map(|_| ()),
            7 => self.take(4).map(|_| ()),
            8 => self.take(8).map(|_| ()),
            9 => self.varint().map(|_| ()),
            _ => None,
        }
    }
}

/// The mission's title ("Liberation Day") is field 1 of the top-level struct.
fn mission_title_from_details(bytes: &[u8]) -> Option<String> {
    let mut reader = VersionedReader { bytes, at: 0 };
    if reader.byte()? != 5 {
        return None;
    }
    for _ in 0..reader.count()? {
        if reader.varint()? == 1 {
            if reader.byte()? != 2 {
                return None;
            }
            let length = reader.count()?;
            let title = String::from_utf8(reader.take(length)?.to_vec()).ok()?;
            return Some(title.trim().to_string()).filter(|title| !title.is_empty());
        }
        reader.skip_value(0)?;
    }
    None
}

/// Which slot a mission belongs to, from the folder of its map: Wings of Liberty maps
/// sit directly in `Campaign/`, the others in `Campaign/Swarm/`, `Campaign/Void/` and
/// `Campaign/Nova/`. Every campaign save lists Liberty, Swarm and Void as dependencies,
/// so those names can't tell the campaigns apart.
fn mission_slot(maps: &[String]) -> Option<&'static str> {
    let map = maps.first()?.to_ascii_lowercase();
    let folder = map.rsplit_once('/').map(|(folder, _)| folder).unwrap_or("");
    let mut parts = folder.split('/');
    if parts.next() != Some("campaign") {
        return None;
    }
    match parts.next() {
        None => Some("Maps/Campaign"),
        Some("swarm") => Some("Maps/Campaign/swarm"),
        Some("void") => Some("Maps/Campaign/void"),
        Some("nova") => Some("Maps/Campaign/nova"),
        _ => None,
    }
}

fn played_mod_title(root: &Path, target: &str) -> String {
    match current_managed_campaign(root, target) {
        Ok(Some(campaign)) => campaign.title,
        _ => campaign_display_for_target(target).unwrap_or("StarCraft II").to_string(),
    }
}

/// Windows file names can't hold `<>:"/\|?*`, control characters or trailing dots.
fn safe_save_stem(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|character| if character.is_control() || "<>:\"/\\|?*".contains(character) { ' ' } else { character })
        .collect();
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.trim_end_matches(['.', ' ']).to_string()
}

fn unused_save_path(folder: &Path, stem: &str) -> PathBuf {
    let first = folder.join(format!("{stem}.SC2Save"));
    if !first.exists() {
        return first;
    }
    (2..1000)
        .map(|number| folder.join(format!("{stem} ({number}).SC2Save")))
        .find(|path| !path.exists())
        .unwrap_or(first)
}

/// "Contingency Contracts - Liberation Day - 2026-10-05 15.44". `stamp` is the
/// player's local time, formatted by the app.
fn mission_save_stem(root: &Path, save: &Path, stamp: &str) -> String {
    let mission = read_save_details_bytes(save).ok().and_then(|bytes| mission_title_from_details(&bytes));
    let campaign = inspect_save_details(save)
        .ok()
        .and_then(|details| mission_slot(&details.maps))
        .map(|target| played_mod_title(root, target))
        .unwrap_or_else(|| "StarCraft II".into());
    let parts: Vec<&str> = [Some(campaign.as_str()), mission.as_deref(), Some(stamp.trim())]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect();
    safe_save_stem(&parts.join(" - "))
}

fn modified_time(path: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(path).and_then(|metadata| metadata.modified()).ok()
}

/// Waits until the quick save is newer than `before` and has stopped growing.
fn wait_for_fresh_quick_save(path: &Path, before: Option<std::time::SystemTime>, seconds: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Some(modified) = modified_time(path) else { continue };
        if Some(modified) == before {
            continue;
        }
        let size = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
        std::thread::sleep(std::time::Duration::from_millis(500));
        let settled = modified_time(path) == Some(modified) && fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0) == size;
        if settled && size > 0 {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
mod starcraft_input {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_CONTROL, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
        GW_OWNER, SW_RESTORE,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn starcraft_pid() -> Option<u32> {
        super::STARCRAFT_IMAGES.iter().find_map(|image| {
            let output = Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {image}"), "/FO", "CSV", "/NH"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()?;
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| line.split(',').nth(1)?.trim_matches('"').parse().ok())
        })
    }

    struct Search {
        pid: u32,
        found: HWND,
    }

    unsafe extern "system" fn visit(window: HWND, data: LPARAM) -> BOOL {
        let search = &mut *(data as *mut Search);
        let mut owner_pid = 0;
        GetWindowThreadProcessId(window, &mut owner_pid);
        if owner_pid == search.pid && IsWindowVisible(window) != 0 && GetWindow(window, GW_OWNER).is_null() {
            search.found = window;
            return 0;
        }
        1
    }

    fn key(code: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: code,
                    wScan: unsafe { MapVirtualKeyW(u32::from(code), MAPVK_VK_TO_VSC) } as u16,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) {
        for input in inputs {
            unsafe { SendInput(1, input, std::mem::size_of::<INPUT>() as i32) };
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    }

    /// Brings the game's window to the front: key presses only reach the active window.
    pub fn focus_starcraft(pid: u32) -> bool {
        let mut search = Search { pid, found: std::ptr::null_mut() };
        unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
        let window = search.found;
        if window.is_null() {
            return false;
        }
        unsafe {
            if IsIconic(window) != 0 {
                ShowWindow(window, SW_RESTORE);
            }
            SetForegroundWindow(window);
            if GetForegroundWindow() != window {
                // Windows lets a window take the front after a key press.
                send(&[key(VK_MENU, false), key(VK_MENU, true)]);
                SetForegroundWindow(window);
            }
            GetForegroundWindow() == window
        }
    }

    pub fn press_quick_save() {
        let q = u16::from(b'Q');
        send(&[key(VK_CONTROL, false), key(q, false), key(q, true), key(VK_CONTROL, true)]);
    }
}

/// Quick-saves the running mission. Returns the parked copy of the player's previous
/// quick save (if there was one), or `None` when the game didn't save.
#[cfg(target_os = "windows")]
fn quick_save_mission(profile: &Path) -> Result<Option<Option<PathBuf>>, String> {
    let quick_save = profile.join("Saves").join("Campaign").join(QUICK_SAVE_FILE);
    let parked = if quick_save.is_file() {
        let parked = cloud_cache_directory("quick-save")?.join(format!("{}.SC2Save", uuid::Uuid::new_v4()));
        fs::copy(&quick_save, &parked).map_err(io_error)?;
        Some(parked)
    } else {
        None
    };
    let before = modified_time(&quick_save);
    let saved = starcraft_input::starcraft_pid().is_some_and(|pid| {
        if !starcraft_input::focus_starcraft(pid) {
            return false;
        }
        // A fullscreen game needs a moment to take over the screen again.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        starcraft_input::press_quick_save();
        wait_for_fresh_quick_save(&quick_save, before, 4) || {
            starcraft_input::press_quick_save();
            wait_for_fresh_quick_save(&quick_save, before, 6)
        }
    });
    if saved {
        return Ok(Some(parked));
    }
    if let Some(parked) = parked {
        let _ = fs::remove_file(parked);
    }
    Ok(None)
}

/// Gives the fresh quick save its name and puts the previous quick save back.
fn keep_mission_save(root: &Path, profile: &Path, stamp: &str, parked: Option<PathBuf>) -> Result<String, String> {
    let folder = profile.join("Saves").join("Campaign");
    let quick_save = folder.join(QUICK_SAVE_FILE);
    let stem = mission_save_stem(root, &quick_save, stamp);
    let named = unused_save_path(&folder, &stem);
    fs::rename(&quick_save, &named).map_err(io_error)?;
    if let Some(parked) = parked {
        fs::copy(&parked, &quick_save).map_err(io_error)?;
        let _ = fs::remove_file(parked);
    }
    Ok(named.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or(stem))
}

#[cfg(target_os = "windows")]
fn end_starcraft(gracefully_first: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let wait_closed = |seconds: u64| {
        (0..seconds * 2).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(500));
            !starcraft_running()
        })
    };
    if gracefully_first {
        for image in STARCRAFT_IMAGES {
            let _ = Command::new("taskkill").args(["/IM", image]).creation_flags(CREATE_NO_WINDOW).output();
        }
        if wait_closed(5) {
            return Ok(());
        }
    }
    for image in STARCRAFT_IMAGES {
        let _ = Command::new("taskkill").args(["/F", "/IM", image]).creation_flags(CREATE_NO_WINDOW).output();
    }
    if wait_closed(10) { Ok(()) } else { Err("StarCraft II didn't close. Close it yourself, then try again.".into()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseOutcome {
    closed: bool,
    saved_as: Option<String>,
}

#[cfg(target_os = "windows")]
fn close_starcraft_blocking(game_dir: &str, profile_dir: &str, stamp: &str, keep_mission: bool) -> Result<CloseOutcome, String> {
    if !starcraft_running() {
        return Ok(CloseOutcome { closed: true, saved_as: None });
    }
    let in_mission = starcraft_in_mission();
    if keep_mission && in_mission != Some(false) {
        let profile = PathBuf::from(profile_dir.trim());
        let Some(parked) = quick_save_mission(&profile)? else {
            return Ok(CloseOutcome { closed: false, saved_as: None });
        };
        let ended = end_starcraft(false);
        let saved_as = keep_mission_save(Path::new(game_dir.trim()), &profile, stamp, parked)?;
        ended?;
        return Ok(CloseOutcome { closed: true, saved_as: Some(saved_as) });
    }
    end_starcraft(in_mission == Some(false))?;
    Ok(CloseOutcome { closed: true, saved_as: None })
}

#[cfg(not(target_os = "windows"))]
fn close_starcraft_blocking(_game_dir: &str, _profile_dir: &str, _stamp: &str, _keep_mission: bool) -> Result<CloseOutcome, String> {
    Ok(CloseOutcome { closed: true, saved_as: None })
}

#[tauri::command]
async fn close_starcraft(
    window: tauri::Window,
    game_dir: String,
    profile_dir: String,
    stamp: String,
    keep_mission: bool,
) -> Result<CloseOutcome, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || close_starcraft_blocking(&game_dir, &profile_dir, &stamp, keep_mission))
        .await
        .map_err(|error| format!("Close worker failed: {error}"))?;
    // Saving brought the game to the front; the dialog carries on in the app.
    let _ = window.set_focus();
    outcome
}

#[cfg(test)]
mod mission_save_tests {
    use super::*;

    // The opening bytes of real save.details files (Liberation Day and Zero Hour saves).
    const LIBERATION_DAY: &[u8] = b"\x05\x24\x00\x04\x01\x00\x00\x02\x02\x1cLiberation Day\x04\x02\x0cBRUTAL";
    const ZERO_HOUR: &[u8] = b"\x05\x24\x00\x04\x01\x00\x00\x02\x02\x12Zero Hour\x04\x02\x0cBRUTAL";

    #[test]
    fn the_mission_title_is_read_from_save_details() {
        assert_eq!(mission_title_from_details(LIBERATION_DAY).as_deref(), Some("Liberation Day"));
        assert_eq!(mission_title_from_details(ZERO_HOUR).as_deref(), Some("Zero Hour"));
        assert_eq!(mission_title_from_details(b"\x05\x24\x00\x04\x01"), None);
        assert_eq!(mission_title_from_details(b""), None);
    }

    #[test]
    fn a_missions_slot_comes_from_its_map_folder() {
        let slot = |map: &str| mission_slot(&[map.to_string()]);
        assert_eq!(slot("Campaign/TRaynor01.SC2Map"), Some("Maps/Campaign"));
        assert_eq!(slot("Campaign/Swarm/Evolution/zEvo01.SC2Map"), Some("Maps/Campaign/swarm"));
        assert_eq!(slot("Campaign/Void/vPrologue.SC2Map"), Some("Maps/Campaign/void"));
        assert_eq!(slot("Campaign/voidprologue/a.SC2Map"), None);
        assert_eq!(slot("Campaign/Nova/n01.SC2Map"), Some("Maps/Campaign/nova"));
        assert_eq!(mission_slot(&[]), None);
    }

    #[test]
    fn save_names_are_safe_windows_file_names() {
        assert_eq!(safe_save_stem("Raynor: Rogue? - Liberation Day - 2026-10-05 15.44"), "Raynor Rogue - Liberation Day - 2026-10-05 15.44");
        assert_eq!(safe_save_stem("Mod.. "), "Mod");
    }

    #[test]
    fn a_taken_save_name_gets_a_number() {
        let folder = std::env::temp_dir().join(format!("ccm-save-name-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("A - B.SC2Save"), b"x").unwrap();
        assert_eq!(unused_save_path(&folder, "A - B"), folder.join("A - B (2).SC2Save"));
        assert_eq!(unused_save_path(&folder, "C"), folder.join("C.SC2Save"));
        fs::remove_dir_all(folder).unwrap();
    }
}

