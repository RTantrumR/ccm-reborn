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

#[tauri::command]
async fn launch_starcraft(window: tauri::Window) -> Result<(), String> {
    let reporter = ProgressReporter::new(window);
    tauri::async_runtime::spawn_blocking(move || launch_starcraft_desktop(&reporter))
        .await
        .map_err(|error| format!("Launcher worker failed: {error}"))?
}
