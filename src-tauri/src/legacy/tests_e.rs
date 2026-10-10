// A switch away from a mod whose files the player changed, or whose backups of
// what was there before are gone (part25_slot_check.rs).

const HOTS: &str = "Maps/Campaign/swarm";

fn package(sandbox: &Path, name: &str, map: &[u8], dependency: &[u8]) -> (PathBuf, InstallRequest) {
    let archive_path = sandbox.join(format!("{name}.zip"));
    let mut archive = ZipWriter::new(File::create(&archive_path).unwrap());
    let options = SimpleFileOptions::default();
    archive.start_file(format!("{name}/metadata.txt"), options).unwrap();
    archive.write_all(format!("title={name}\nauthor=Test\ncampaign=HotS\nversion=1\n").as_bytes()).unwrap();
    archive.start_file(format!("{name}/zchar01.SC2Map"), options).unwrap();
    archive.write_all(map).unwrap();
    archive.start_file(format!("{name}/Dep.SC2Mod/GameData.xml"), options).unwrap();
    archive.write_all(dependency).unwrap();
    archive.finish().unwrap();
    let game_dir = sandbox.join("game");
    let request = InstallRequest {
        campaign_id: name.to_lowercase(), title: name.into(), author: "Test".into(), version: "1".into(),
        profile_dir: None, archive_source: archive_path.display().to_string(), sha256: sha256_file(&archive_path).unwrap(),
        package_size: None, game_dir: game_dir.display().to_string(),
    };
    (archive_path, request)
}

/// The slot had a mission and Mods had an older Dep.SC2Mod before "First" went in.
fn installed_first(sandbox: &Path) -> PathBuf {
    let game_dir = sandbox.join("game");
    fs::create_dir_all(game_dir.join(HOTS)).unwrap();
    fs::write(game_dir.join(HOTS).join("zchar01.SC2Map"), b"before-map").unwrap();
    fs::create_dir_all(game_dir.join("Mods/Dep.SC2Mod")).unwrap();
    fs::write(game_dir.join("Mods/Dep.SC2Mod/GameData.xml"), b"before-dep").unwrap();
    let (archive, request) = package(sandbox, "First", b"first-map", b"first-dep");
    install_archive(&game_dir, &request, &archive, &request.sha256, None).unwrap();
    game_dir
}

fn sandbox(name: &str) -> PathBuf {
    let sandbox = std::env::temp_dir().join(format!("ccm-slot-{name}-{}", Uuid::new_v4()));
    fs::create_dir_all(&sandbox).unwrap();
    sandbox
}

fn restore(game_dir: &Path, options: SwitchOptions) -> RestoreResult {
    restore_original_campaigns_with(game_dir.display().to_string(), None, HOTS.into(), options).unwrap()
}

#[test]
fn a_changed_file_stops_the_switch_until_the_player_keeps_a_copy() {
    let sandbox = sandbox("changed");
    let game_dir = installed_first(&sandbox);
    fs::write(game_dir.join("Mods/Dep.SC2Mod/GameData.xml"), b"players-edit").unwrap();
    let check = check_slot_switch_at(&game_dir, HOTS).unwrap();
    assert_eq!((check.title.as_str(), check.changed, check.missing_backups), ("First", 1, 0));

    let refused = restore(&game_dir, SwitchOptions::default());
    assert_eq!(refused.conflicts, vec!["Mods/Dep.SC2Mod/GameData.xml".to_string()]);
    assert_eq!(fs::read(game_dir.join("Mods/Dep.SC2Mod/GameData.xml")).unwrap(), b"players-edit");
    assert!(read_state_for_target(&game_dir, HOTS).unwrap().is_some(), "a refusal changes nothing");

    let restored = restore(&game_dir, SwitchOptions { keep_changed: true, ..SwitchOptions::default() });
    assert!(!restored.refused());
    let kept = PathBuf::from(restored.kept_files.expect("a kept folder"));
    assert_eq!(fs::read(kept.join("Mods/Dep.SC2Mod/GameData.xml")).unwrap(), b"players-edit");
    assert_eq!(kept.parent().unwrap(), kept_files_root(&game_dir));
    assert_eq!(fs::read(game_dir.join("Mods/Dep.SC2Mod/GameData.xml")).unwrap(), b"before-dep");
    assert_eq!(fs::read(game_dir.join(HOTS).join("zchar01.SC2Map")).unwrap(), b"before-map");
    let _ = fs::remove_dir_all(sandbox);
}

#[test]
fn a_lost_backup_stops_the_switch_until_the_player_allows_it() {
    let sandbox = sandbox("lost");
    let game_dir = installed_first(&sandbox);
    let state = read_state_for_target(&game_dir, HOTS).unwrap().unwrap();
    let map = state.files.iter().find(|file| file.destination.ends_with("zchar01.SC2Map")).unwrap();
    fs::remove_file(manager_root(&game_dir).join(map.backup_path.as_deref().unwrap())).unwrap();
    let check = check_slot_switch_at(&game_dir, HOTS).unwrap();
    assert_eq!((check.changed, check.missing_backups), (0, 1));

    let refused = restore(&game_dir, SwitchOptions::default());
    assert_eq!(refused.missing_backups, vec![format!("{HOTS}/zchar01.SC2Map")]);
    assert_eq!(fs::read(game_dir.join(HOTS).join("zchar01.SC2Map")).unwrap(), b"first-map");

    let restored = restore(&game_dir, SwitchOptions { allow_missing_backups: true, ..SwitchOptions::default() });
    assert!(!restored.refused());
    assert!(!game_dir.join(HOTS).join("zchar01.SC2Map").exists(), "what was there before can't come back");
    assert_eq!(fs::read(game_dir.join("Mods/Dep.SC2Mod/GameData.xml")).unwrap(), b"before-dep");
    assert!(read_state_for_target(&game_dir, HOTS).unwrap().is_none());
    let _ = fs::remove_dir_all(sandbox);
}

#[test]
fn switching_to_another_mod_keeps_a_copy_of_changed_files_when_asked() {
    let sandbox = sandbox("mod-to-mod");
    let game_dir = installed_first(&sandbox);
    fs::write(game_dir.join(HOTS).join("zchar01.SC2Map"), b"players-map").unwrap();
    let (archive, request) = package(&sandbox, "Second", b"second-map", b"second-dep");

    let refused = install_archive(&game_dir, &request, &archive, &request.sha256, None).unwrap_err();
    assert!(refused.contains("changed after it was installed"), "{refused}");
    assert_eq!(fs::read(game_dir.join(HOTS).join("zchar01.SC2Map")).unwrap(), b"players-map");

    let options = SwitchOptions { keep_changed: true, ..SwitchOptions::default() };
    let installed = install_archive_with(&game_dir, &request, &archive, &request.sha256, None, options).unwrap();
    let kept = PathBuf::from(installed.kept_files.expect("a kept folder"));
    assert_eq!(fs::read(kept.join(HOTS).join("zchar01.SC2Map")).unwrap(), b"players-map");
    assert_eq!(fs::read(game_dir.join(HOTS).join("zchar01.SC2Map")).unwrap(), b"second-map");
    // Second's own backup is what was there before First, not the player's edit.
    restore(&game_dir, SwitchOptions::default());
    assert_eq!(fs::read(game_dir.join(HOTS).join("zchar01.SC2Map")).unwrap(), b"before-map");
    let _ = fs::remove_dir_all(sandbox);
}
