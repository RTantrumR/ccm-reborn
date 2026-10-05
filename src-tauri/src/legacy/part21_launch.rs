// "Play": open StarCraft II itself, not just Battle.net. The game only gets its login
// through the Battle.net app, so starting SC2_x64/SC2Switcher directly fails ("Unable
// to launch game"). What works (verified 2026-09-27 in the SC2_M&M harness) is asking a
// running, logged-in Battle.net to `--exec="launch S2"`; on a cold start that command is
// dropped, so start Battle.net first and wait for it.

#[cfg(target_os = "windows")]
fn battle_net_executable() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = registry_install_location("Battle.net").into_iter().collect();
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(base).join("Battle.net"));
        }
    }
    candidates.into_iter().map(|folder| folder.join("Battle.net.exe")).find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn battle_net_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Battle.net.exe", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains("Battle.net.exe"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn launch_starcraft_desktop(reporter: &ProgressReporter) -> Result<(), String> {
    let executable = battle_net_executable()
        .ok_or("Battle.net wasn't found. Install it from blizzard.com, or open StarCraft II yourself.")?;
    if !battle_net_running() {
        reporter.status("starting-battle-net", "Starting Battle.net…");
        Command::new(&executable)
            .spawn()
            .map_err(|_| "Battle.net couldn't be started. Open it yourself and press Play.".to_string())?;
        let started = (0..90).any(|_| {
            std::thread::sleep(std::time::Duration::from_secs(1));
            battle_net_running()
        });
        if !started {
            return Err("Battle.net didn't start. Open it yourself and press Play.".into());
        }
        // Battle.net ignores the launch command until it has finished signing in.
        reporter.status("starting-battle-net", "Waiting for Battle.net to sign in…");
        std::thread::sleep(std::time::Duration::from_secs(12));
    }
    reporter.status("launching-game", "Launching StarCraft II…");
    Command::new(&executable)
        .arg("--exec=launch S2")
        .spawn()
        .map(|_| ())
        .map_err(|_| "StarCraft II couldn't be launched. Press Play in Battle.net.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn launch_starcraft_desktop(_reporter: &ProgressReporter) -> Result<(), String> {
    open_battle_net_desktop()
}

/// StarCraft II writes campaign banks and saves while it runs (and on exit), so
/// switching a campaign under it can mix two campaigns' progress.
const STARCRAFT_IMAGES: [&str; 2] = ["SC2_x64.exe", "SC2.exe"];

#[cfg(all(target_os = "windows", not(test)))]
fn starcraft_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    STARCRAFT_IMAGES.iter().any(|image| {
        Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(image))
            .unwrap_or(false)
    })
}

#[cfg(any(not(target_os = "windows"), test))]
fn starcraft_running() -> bool {
    false
}

fn refuse_while_starcraft_runs(root: &Path) -> Result<(), String> {
    if looks_like_starcraft(root) && starcraft_running() {
        return Err("StarCraft II is running. Close it completely, then switch again.".into());
    }
    Ok(())
}

/// The game's local client API (port 6119) lists the menu screens on show; a running
/// map (a mission) shows none. `None` when the API doesn't answer.
fn starcraft_in_mission() -> Option<bool> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .ok()?;
    let body = client.get("http://127.0.0.1:6119/ui").send().ok()?.text().ok()?;
    let ui: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(ui.get("activeScreens")?.as_array()?.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StarcraftStatus {
    running: bool,
    in_mission: Option<bool>,
}

#[tauri::command]
async fn starcraft_status() -> Result<StarcraftStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let running = starcraft_running();
        StarcraftStatus { running, in_mission: if running { starcraft_in_mission() } else { None } }
    })
    .await
    .map_err(|error| format!("Status worker failed: {error}"))
}

/// Cheap check for the Play button, polled while the app is visible.
#[tauri::command]
async fn starcraft_is_running() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(starcraft_running)
        .await
        .map_err(|error| format!("Status worker failed: {error}"))
}

#[tauri::command]
async fn launch_starcraft(window: tauri::Window) -> Result<(), String> {
    let reporter = ProgressReporter::new(window);
    tauri::async_runtime::spawn_blocking(move || launch_starcraft_desktop(&reporter))
        .await
        .map_err(|error| format!("Launcher worker failed: {error}"))?
}
