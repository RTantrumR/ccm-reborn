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
        let save = self.profile.join("Saves/Campaign").join(name);
        write_test_save(&save, b"Campaign/Swarm/ZChar02.SC2Map\0");
        save
    }

    fn switch(&self, source: &str, target: &str) {
        apply_profile_transition_at(
            &self.root, &self.profile, &self.profile_base,
            "Maps/Campaign/swarm", "Maps/Campaign/swarm",
            source, &[], target, &[], &self.staging,
        )
        .unwrap();
    }
}

impl Drop for ProfileSandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
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
    assert_eq!(loaded.missing_packages, ["Gone Mod"]);
    let _ = fs::remove_dir_all(root);
}
