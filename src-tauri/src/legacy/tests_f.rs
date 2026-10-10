// Deleting a mod from My Mods (part27_delete_mod.rs).

struct Sandbox {
    root: PathBuf,
    game: PathBuf,
    local: PathBuf,
    saves: PathBuf,
    cache: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("ccm-delete-{name}-{}", Uuid::new_v4()));
        let sandbox = Sandbox {
            game: root.join("game"),
            local: root.join("local"),
            saves: root.join("saves"),
            cache: root.join("cache"),
            root,
        };
        for directory in [&sandbox.game, &sandbox.local, &sandbox.saves, &sandbox.cache] {
            fs::create_dir_all(directory).unwrap();
        }
        sandbox
    }

    fn delete(&self, id: &str, delete_original: bool, delete_saves: bool) -> Result<DeleteModResult, String> {
        let cache_dir = self.cache.clone();
        let cache = move |hash: &str| Some(cache_dir.join(format!("{hash}.zip")));
        let places = DeletePlaces { game: &self.game, local: &self.local, save_stores: vec![self.saves.clone()], cache: &cache };
        delete_mod_at(&places, id, DeleteModOptions { delete_original, delete_saves })
    }

    /// A mod added from the PC, from a ZIP in the player's "Downloads".
    fn add_local(&self, name: &str) -> (String, PathBuf) {
        let source = self.root.join("Downloads").join(format!("{name}.zip"));
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let mut archive = ZipWriter::new(File::create(&source).unwrap());
        let options = SimpleFileOptions::default();
        archive.start_file(format!("{name}/metadata.txt"), options).unwrap();
        archive.write_all(format!("title={name}\ncampaign=HotS\nversion=1\n").as_bytes()).unwrap();
        archive.start_file(format!("{name}/zlab01.SC2Map"), options).unwrap();
        archive.write_all(b"map").unwrap();
        archive.finish().unwrap();
        let entry = add_local_mod_at(&self.local, &source, &LocalModOverrides::default()).unwrap();
        (entry.record.id, source)
    }

    fn history(&self, id: &str, sha: &str) -> PathBuf {
        let path = manager_root(&self.game).join("installed/history").join(format!("{id}-{sha}.json"));
        let manifest = InstalledManifest {
            schema_version: INSTALLED_MANIFEST_SCHEMA_VERSION,
            campaign_id: id.into(), title: id.into(), author: String::new(), version: "1".into(),
            package_sha256: sha.into(), target_path: "Maps/Campaign/swarm".into(), installed_at: 1,
            files: vec![InstalledFile { destination: "Maps/Campaign/swarm/a.SC2Map".into(), source: "a.SC2Map".into(), size: 1, sha256: "a".repeat(64), kind: "file".into() }],
        };
        write_installed_manifest_atomic(&path, &manifest).unwrap();
        fs::write(self.cache.join(format!("{sha}.zip")), b"download").unwrap();
        path
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_mod_added_from_the_pc_keeps_its_original_unless_asked() {
    let sandbox = Sandbox::new("local");
    let (kept, kept_source) = sandbox.add_local("Kept");
    let (gone, gone_source) = sandbox.add_local("Gone");
    let copy = |id: &str| local_mod_archive_directory(&sandbox.local).join(format!("{id}.zip"));
    assert!(copy(&kept).is_file() && copy(&gone).is_file());

    assert!(!sandbox.delete(&kept, false, false).unwrap().deleted_original);
    assert!(!copy(&kept).exists(), "the app's own copy always goes");
    assert!(kept_source.is_file(), "the original stays unless asked");

    assert!(sandbox.delete(&gone, true, false).unwrap().deleted_original);
    assert!(!gone_source.exists());
    assert!(read_local_mods_strict(&sandbox.local).unwrap().is_empty());
}

#[test]
fn a_library_mod_loses_its_history_and_cached_download_only() {
    let sandbox = Sandbox::new("library");
    let mine = sandbox.history("archive-mine", &"b".repeat(64));
    let other = sandbox.history("archive-other", &"c".repeat(64));
    sandbox.delete("archive-mine", true, false).unwrap();
    assert!(!mine.exists() && !sandbox.cache.join(format!("{}.zip", "b".repeat(64))).exists());
    assert!(other.exists() && sandbox.cache.join(format!("{}.zip", "c".repeat(64))).exists());
}

#[test]
fn an_original_ccm_mod_folder_goes_only_when_asked() {
    let sandbox = Sandbox::new("store");
    let folder = sandbox.game.join("Maps/CustomCampaigns/Old Mod");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("metadata.txt"), "title=Old Mod\ncampaign=HotS\nversion=1\n").unwrap();
    fs::write(folder.join("zlab01.SC2Map"), b"map").unwrap();
    let id = list_ccm_store_at(&sandbox.game).pop().unwrap().id;

    assert!(!sandbox.delete(&id, false, false).unwrap().deleted_original);
    assert!(folder.is_dir());
    assert!(sandbox.delete(&id, true, false).unwrap().deleted_original);
    assert!(!folder.exists());
    assert!(sandbox.game.join("Maps/CustomCampaigns").is_dir(), "only that mod's folder goes");
}

#[test]
fn saves_go_only_when_asked_and_a_playing_mod_is_refused() {
    let sandbox = Sandbox::new("saves");
    let saves = sandbox.saves.join("archive-mine/Saves/Campaign");
    fs::create_dir_all(&saves).unwrap();
    fs::write(saves.join("Zerus.SC2Save"), b"save").unwrap();
    assert!(!sandbox.delete("archive-mine", false, false).unwrap().deleted_saves);
    assert!(saves.join("Zerus.SC2Save").is_file());
    assert!(sandbox.delete("archive-mine", false, true).unwrap().deleted_saves);
    assert!(!sandbox.saves.join("archive-mine").exists());

    assert!(sandbox.delete("vanilla-heart-of-the-swarm", false, true).is_err());
    assert!(sandbox.delete("accounts", false, true).is_err());

    // A mod the original CCM put in the slot is playing there.
    let slot = sandbox.game.join("Maps/Campaign/swarm");
    fs::create_dir_all(&slot).unwrap();
    let store = sandbox.game.join("Maps/CustomCampaigns/Playing");
    fs::create_dir_all(&store).unwrap();
    for folder in [&slot, &store] {
        fs::write(folder.join("metadata.txt"), "title=Playing\ncampaign=HotS\nversion=1\n").unwrap();
        fs::write(folder.join("zlab01.SC2Map"), b"map").unwrap();
    }
    let id = list_ccm_store_at(&sandbox.game).pop().unwrap().id;
    let refused = sandbox.delete(&id, true, true).unwrap_err();
    assert!(refused.contains("playing right now"), "{refused}");
    assert!(store.is_dir());
}
