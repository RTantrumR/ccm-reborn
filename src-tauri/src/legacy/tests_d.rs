// Mission saves are MPQ archives whose `save.details` names the campaign maps.
// The `mpq` crate only reads, so tests build a minimal valid archive here:
// one uncompressed single-unit file plus the encrypted hash and block tables.

fn mpq_crypt_table() -> Vec<u32> {
    let mut table = vec![0_u32; 0x500];
    let mut seed: u32 = 0x0010_0001;
    for index in 0..0x100 {
        let mut slot = index;
        for _ in 0..5 {
            seed = (seed * 125 + 3) % 0x2A_AAAB;
            let high = (seed & 0xFFFF) << 16;
            seed = (seed * 125 + 3) % 0x2A_AAAB;
            table[slot] = high | (seed & 0xFFFF);
            slot += 0x100;
        }
    }
    table
}

fn mpq_hash(table: &[u32], key: &str, offset: u32) -> u32 {
    let (mut seed1, mut seed2) = (0x7FED_7FED_u32, 0xEEEE_EEEE_u32);
    for character in key.replace('/', "\\").to_uppercase().chars() {
        let value = character as u32;
        seed1 = table[(offset + value) as usize] ^ seed1.wrapping_add(seed2);
        seed2 = value.wrapping_add(seed1).wrapping_add(seed2).wrapping_add(seed2 << 5).wrapping_add(3);
    }
    seed1
}

fn mpq_encrypt(table: &[u32], data: &mut [u8], mut seed: u32) {
    let mut seed2 = 0xEEEE_EEEE_u32;
    for chunk in data.chunks_exact_mut(4) {
        let plain = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        seed2 = seed2.wrapping_add(table[(0x400 + (seed & 0xFF)) as usize]);
        chunk.copy_from_slice(&(plain ^ seed.wrapping_add(seed2)).to_le_bytes());
        seed = ((!seed << 0x15).wrapping_add(0x1111_1111)) | (seed >> 0x0B);
        seed2 = plain.wrapping_add(seed2).wrapping_add(seed2 << 5).wrapping_add(3);
    }
}

/// Writes a `.SC2Save` stand-in whose `save.details` holds `details`.
fn write_test_save(path: &Path, details: &[u8]) {
    const HEADER: u32 = 0x20;
    const HASH_COUNT: u32 = 4;
    let table = mpq_crypt_table();
    let data_size = details.len() as u32;
    let hash_offset = HEADER + data_size;
    let block_offset = hash_offset + HASH_COUNT * 16;
    let total = block_offset + 16;

    let mut hashes = Vec::new();
    let home = mpq_hash(&table, "save.details", 0) & (HASH_COUNT - 1);
    for index in 0..HASH_COUNT {
        if index == home {
            hashes.extend(mpq_hash(&table, "save.details", 0x100).to_le_bytes());
            hashes.extend(mpq_hash(&table, "save.details", 0x200).to_le_bytes());
            hashes.extend(0_u16.to_le_bytes());
            hashes.extend(0_u16.to_le_bytes());
            hashes.extend(0_u32.to_le_bytes());
        } else {
            hashes.extend([0xFF; 16]);
        }
    }
    mpq_encrypt(&table, &mut hashes, mpq_hash(&table, "(hash table)", 0x300));
    let mut blocks = Vec::new();
    blocks.extend(HEADER.to_le_bytes());
    blocks.extend(data_size.to_le_bytes());
    blocks.extend(data_size.to_le_bytes());
    blocks.extend((0x8000_0000_u32 | 0x0100_0000).to_le_bytes()); // exists | single unit
    mpq_encrypt(&table, &mut blocks, mpq_hash(&table, "(block table)", 0x300));

    let mut archive = Vec::new();
    archive.extend(b"MPQ\x1A");
    archive.extend(HEADER.to_le_bytes());
    archive.extend(total.to_le_bytes());
    archive.extend(0_u16.to_le_bytes());
    archive.extend(3_u16.to_le_bytes());
    archive.extend(hash_offset.to_le_bytes());
    archive.extend(block_offset.to_le_bytes());
    archive.extend(HASH_COUNT.to_le_bytes());
    archive.extend(1_u32.to_le_bytes());
    archive.extend(details);
    archive.extend(hashes);
    archive.extend(blocks);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, archive).unwrap();
}

#[test]
fn test_save_writer_round_trips_through_the_save_inspector() {
    let sandbox = std::env::temp_dir().join(format!("ccm-mpq-writer-{}", Uuid::new_v4()));
    let save = sandbox.join("Mission.SC2Save");
    write_test_save(&save, b"Campaign/Swarm/ZChar02.SC2Map\0");
    let details = inspect_save_details(&save).unwrap();
    let _ = fs::remove_dir_all(&sandbox);
    assert_eq!(details.maps, vec!["Campaign/Swarm/ZChar02.SC2Map"]);
}

struct ProfileSandbox {
    root: PathBuf,
    profile: PathBuf,
    profile_base: PathBuf,
    staging: PathBuf,
}

impl ProfileSandbox {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("ccm-{name}-{}", Uuid::new_v4()));
        let sandbox = Self {
            profile: root.join("profile"),
            profile_base: root.join("profiles"),
            staging: root.join("staging"),
            root,
        };
        fs::create_dir_all(sandbox.profile.join("Saves")).unwrap();
        fs::create_dir_all(&sandbox.staging).unwrap();
        sandbox
    }

    fn mission_save(&self, name: &str) -> PathBuf {
        self.mission_save_of(name, b"Campaign/Swarm/ZChar02.SC2Map\0")
    }

    fn mission_save_of(&self, name: &str, details: &[u8]) -> PathBuf {
        let save = self.profile.join("Saves/Campaign").join(name);
        write_test_save(&save, details);
        save
    }

    /// A snapshot store as an earlier build left it: a mod's store with its resume manifest
    /// and whatever saves that build filed there.
    fn store_with_save(&self, store: &str, target: &str, name: &str, details: &[u8]) -> PathBuf {
        let folder = self.profile_base.join(store);
        fs::create_dir_all(&folder).unwrap();
        let manifest = CampaignProfileResumeManifest {
            format: 1, campaign_id: store.into(), target_path: target.into(), dependency_names: vec![], captured_at: 1, legacy_migrated: false,
        };
        fs::write(folder.join("ccm-resume.json"), serde_json::to_string(&manifest).unwrap()).unwrap();
        let save = folder.join("Saves/Campaign").join(name);
        write_test_save(&save, details);
        save
    }

    fn switch(&self, source: &str, target: &str) {
        self.switch_slot("Maps/Campaign/swarm", source, target);
    }

    fn switch_slot(&self, slot: &str, source: &str, target: &str) {
        apply_profile_transition_at(
            &self.root, &self.profile, &self.profile_base,
            slot, slot, source, &[], target, &[], &self.staging,
        )
        .unwrap();
    }
}

impl Drop for ProfileSandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

const WOL_MISSION: &[u8] = b"Campaign/TRaynor01.SC2Map\0Campaigns/Liberty.SC2Campaign\0Campaigns/Swarm.SC2Campaign\0Campaigns/Void.SC2Campaign";
const HOTS_HUB: &[u8] = b"\x05Kaldir\x04BRUTAL\x01>Campaign/Swarm/ZStoryExpedition\x00\x00\x01";
const LOTV_MISSION: &[u8] = b"Campaign/Void/vAiur01.SC2Map\0Campaigns/Liberty.SC2Campaign\0Campaigns/Swarm.SC2Campaign\0Campaigns/Void.SC2Campaign";

#[test]
fn switching_one_campaign_leaves_the_other_campaigns_saves_where_they_are() {
    // Every campaign save lists Liberty, Swarm and Void as dependencies. Going by those,
    // a LotV switch used to take the WoL and HotS playthroughs with it.
    let sandbox = ProfileSandbox::new("slot-scoped");
    let wol = sandbox.mission_save_of("Liberation Day.SC2Save", WOL_MISSION);
    let hub = sandbox.mission_save_of("Kaldir.SC2Save", HOTS_HUB);
    let lotv = sandbox.mission_save_of("Aiur.SC2Save", LOTV_MISSION);
    sandbox.switch_slot("Maps/Campaign/void", "", "lotv-mod");
    assert!(wol.is_file(), "the WoL save stays live");
    assert!(hub.is_file(), "the HotS hub save stays live");
    assert!(!lotv.exists(), "only the LotV save goes with Blizzard's LotV campaign");
    assert!(sandbox.profile_base.join("vanilla-legacy-of-the-void/Saves/Campaign/Aiur.SC2Save").is_file());
    // A HotS switch owns the hub save, whose map has no extension, and nothing else.
    sandbox.switch_slot("Maps/Campaign/swarm", "", "hots-mod");
    assert!(wol.is_file());
    assert!(!hub.exists());
    assert!(sandbox.profile_base.join("vanilla-heart-of-the-swarm/Saves/Campaign/Kaldir.SC2Save").is_file());
}

#[test]
fn saves_filed_under_another_campaigns_mod_come_back_on_the_next_switch() {
    let sandbox = ProfileSandbox::new("rehome");
    let stored = sandbox.store_with_save("lotv-mod", "Maps/Campaign/void", "Liberation Day.SC2Save", WOL_MISSION);
    let stored_own = sandbox.store_with_save("lotv-mod", "Maps/Campaign/void", "Aiur.SC2Save", LOTV_MISSION);
    // The player has since saved another "Liberation Day"; it keeps its name.
    let newer = sandbox.mission_save_of("Liberation Day.SC2Save", b"Campaign/TRaynor02.SC2Map\0");
    let newer_bytes = fs::read(&newer).unwrap();
    sandbox.switch("", "hots-mod");
    assert!(!stored.exists(), "the WoL save leaves the LotV mod's store");
    assert!(stored_own.is_file(), "the LotV mod's own save stays in its store");
    assert_eq!(fs::read(&newer).unwrap(), newer_bytes);
    assert!(sandbox.profile.join("Saves/Campaign/Liberation Day (2).SC2Save").is_file(), "the older one comes back under a free name");
    // An identical live copy means the stored one is just dropped.
    let twin = sandbox.store_with_save("vanilla-legacy-of-the-void", "Maps/Campaign/void", "Liberation Day (2).SC2Save", WOL_MISSION);
    sandbox.switch("hots-mod", "");
    assert!(!twin.exists());
    assert!(sandbox.profile.join("Saves/Campaign/Liberation Day (2).SC2Save").is_file());
}

#[test]
fn hub_saves_name_their_story_map_without_an_extension() {
    assert_eq!(extract_campaign_map_paths(HOTS_HUB), vec!["Campaign/Swarm/ZStoryExpedition"]);
    assert_eq!(extract_campaign_map_paths(WOL_MISSION), vec!["Campaign/TRaynor01.SC2Map"]);
    assert_eq!(mission_slot(&extract_campaign_map_paths(HOTS_HUB)), Some("Maps/Campaign/swarm"));
    assert_eq!(extract_campaign_map_paths(b"CampaignPanelLastMission Campaign/"), Vec::<String>::new());
}

#[test]
fn restoring_the_original_keeps_the_mission_saves_of_a_mod_without_dependencies() {
    // Many CCM packages ship no .SC2Mod, so their saves name no mod. Switching such a
    // mod back to Blizzard's campaign used to delete its mission saves outright.
    let sandbox = ProfileSandbox::new("nodeps-restore");
    let save = sandbox.mission_save("Back in the Saddle.SC2Save");
    sandbox.switch("nodeps-mod", "vanilla-heart-of-the-swarm");
    assert!(!save.exists(), "the mod's save must leave the live profile");
    assert!(
        sandbox.profile_base.join("nodeps-mod/Saves/Campaign/Back in the Saddle.SC2Save").is_file(),
        "the mod's mission save must be kept in its own store"
    );
}

#[test]
fn switching_between_mods_without_dependencies_keeps_each_ones_saves_apart() {
    let sandbox = ProfileSandbox::new("nodeps-switch");
    sandbox.mission_save("Mod A mission.SC2Save");
    sandbox.switch("mod-a", "mod-b");
    assert!(
        !sandbox.profile.join("Saves/Campaign/Mod A mission.SC2Save").exists(),
        "mod A's save must not stay live while mod B is installed"
    );
    assert!(sandbox.profile_base.join("mod-a/Saves/Campaign/Mod A mission.SC2Save").is_file());
    // And switching back brings it home.
    sandbox.switch("mod-b", "mod-a");
    assert!(sandbox.profile.join("Saves/Campaign/Mod A mission.SC2Save").is_file());
}

// A local catalog whose package file is gone leaves out that mod, not the whole catalog.
#[test]
fn local_catalog_leaves_out_mods_with_missing_packages() {
    let root = std::env::temp_dir().join(format!("ccm-catalog-{}", Uuid::new_v4()));
    fs::create_dir_all(root.join("packages")).unwrap();
    fs::write(root.join("packages/present.zip"), b"zip").unwrap();
    let entry = |id: &str, title: &str, path: &str| serde_json::json!({
        "id": id, "title": title, "author": "Author", "version": "1.0", "description": "A mod.",
        "tags": [], "requirements": { "campaign": "Wings of Liberty" },
        "package": { "path": path, "sha256": "a".repeat(64), "size": 3 }
    });
    let document = serde_json::json!({
        "format": 1, "name": "Test", "updatedAt": "2026-10-05",
        "campaigns": [entry("gone", "Gone Mod", "packages/gone.zip"), entry("present", "Present Mod", "packages/present.zip")]
    });
    fs::write(root.join("catalog.json"), document.to_string()).unwrap();

    let loaded = load_catalog_blocking(root.join("catalog.json").display().to_string()).unwrap();
    assert_eq!(loaded.campaigns.iter().map(|campaign| campaign.id.as_str()).collect::<Vec<_>>(), ["present"]);
    let _ = fs::remove_dir_all(root);
}

// The key and counter match the archive bot's (bot/src/hosts.ts), whose download of this
// file matched the real package's SHA-256.
#[test]
fn mega_links_yield_the_file_key() {
    let (id, key, counter) = mega_file("https://mega.nz/file/IWhFgYiD#1VrZAmjsQSekYB7WQ0-zFVFATvEVK4oG_1i-HY89y-g").unwrap();
    assert_eq!(id, "IWhFgYiD");
    assert_eq!(hex::encode(key), "841a97f37dc7cb215b38a0cbcc7278fd");
    assert_eq!(hex::encode(counter), "51404ef1152b8a060000000000000000");
    let legacy = mega_file("https://mega.nz/#!IWhFgYiD!1VrZAmjsQSekYB7WQ0-zFVFATvEVK4oG_1i-HY89y-g").unwrap();
    assert_eq!(legacy.1, key);
    assert!(mega_file("https://mega.nz/folder/IWhFgYiD#abc").is_none());
    assert!(mega_file("https://example.com/file/IWhFgYiD#1VrZAmjsQSekYB7WQ0-zFVFATvEVK4oG_1i-HY89y-g").is_none());
    assert!(mega_file("https://mega.nz/file/IWhFgYiD#short").is_none());
}

#[test]
fn drive_links_and_confirm_page() {
    let file = |link: &str| drive_file(link).map(|(id, key)| (id, key.unwrap_or_default()));
    let pair = |id: &str, key: &str| Some((id.to_string(), key.to_string()));
    assert_eq!(file("https://drive.google.com/file/d/1JAjdXx-SsKskXY0G-BqZeY4ZItccq32t/view?usp=sharing"), pair("1JAjdXx-SsKskXY0G-BqZeY4ZItccq32t", ""));
    assert_eq!(file("https://drive.google.com/open?id=abc_D-1"), pair("abc_D-1", ""));
    // Files shared before 2021 carry a resource key in the link.
    assert_eq!(file("https://drive.google.com/file/d/0B9x/view?usp=sharing&resourcekey=0-AbC_d-9"), pair("0B9x", "0-AbC_d-9"));
    assert_eq!(file("https://drive.google.com/open?id=0B9x&resourcekey=0-k"), pair("0B9x", "0-k"));
    assert_eq!(file("https://drive.google.com/file/d/0B9x/view?resourcekey=bad%20key"), pair("0B9x", ""));
    assert_eq!(file("https://drive.google.com/drive/folders/xyz"), None);
    assert_eq!(file("https://docs.google.com/document/d/zz/edit"), None);
    // Shape of Drive's virus-scan page (2026-10-05).
    let page = r#"<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="1JAj"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="7248a322"></form>"#;
    assert_eq!(drive_confirm_fields(page), [("id", "1JAj"), ("export", "download"), ("confirm", "t"), ("uuid", "7248a322")]
        .map(|(name, value)| (name.to_string(), value.to_string())));
    // The same fields in another attribute order and quoting; visible inputs are skipped.
    let reordered = r#"<input class="x" value="1JAj" name="id" type="hidden"/><input name='confirm' type='HIDDEN' value='a&amp;b'><input type="submit" name="go" value="Download">"#;
    assert_eq!(drive_confirm_fields(reordered), [("id", "1JAj"), ("confirm", "a&b")]
        .map(|(name, value)| (name.to_string(), value.to_string())));
}
