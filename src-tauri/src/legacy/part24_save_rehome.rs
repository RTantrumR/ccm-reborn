// Saves an earlier build filed under another campaign's mod: every campaign save lists
// Liberty, Swarm and Void as dependencies, and ownership went by those, so a LotV switch
// took the WoL and HotS playthroughs with it. Each switch now brings such saves back
// (apply_profile_transition_at_with_hook in part06).

/// The slot a snapshot store belongs to: `vanilla-<slot>` by name, a mod's by its resume
/// manifest. A store without either says nothing about its saves.
fn profile_store_target(store: &Path) -> Option<&'static str> {
    let name = store.file_name()?.to_str()?;
    if let Some(slot) = name.strip_prefix("vanilla-") {
        return ["Maps/Campaign", "Maps/Campaign/swarm", "Maps/Campaign/void", "Maps/Campaign/nova"]
            .into_iter()
            .find(|target| campaign_slot_for_target(target) == Some(slot));
    }
    let manifest = read_campaign_profile_resume_manifest(&store.join("ccm-resume.json"), name).ok()?;
    campaign_profile_spec(&manifest.target_path).map(|spec| spec.target)
}

/// A mission save a snapshot store holds for another slot than its own: an earlier build
/// filed every campaign save under whichever slot was switched. On the next switch it
/// goes back to the live profile, under a free name if the player has saved one of that
/// name since, or is dropped when the live copy is the same file.
struct MisfiledSave {
    stored: PathBuf,
    live: Option<PathBuf>,
}

fn misfiled_store_saves(profile_base: &Path, profile: &Path, reserved: &mut HashSet<PathBuf>) -> Result<Vec<MisfiledSave>, String> {
    let mut misfiled = Vec::new();
    if !profile_base.is_dir() {
        return Ok(misfiled);
    }
    let mut stores: Vec<PathBuf> = fs::read_dir(profile_base).map_err(io_error)?.flatten().map(|entry| entry.path()).collect();
    stores.sort();
    for store in stores {
        if fs::symlink_metadata(&store).map_err(io_error)?.file_type().is_symlink() || !store.is_dir() {
            continue;
        }
        let Some(store_target) = profile_store_target(&store) else { continue };
        for stored in collect_regular_files(&store.join("Saves"))? {
            let relative = stored.strip_prefix(&store).map_err(|_| "Stored save escaped its store.")?;
            if !is_user_loadable_campaign_save(&store, &stored)
                || stored.extension().and_then(|extension| extension.to_str()).map(|extension| extension.eq_ignore_ascii_case("SC2Save")) != Some(true)
            {
                continue;
            }
            let Ok(details) = inspect_save_details(&stored) else { continue };
            let Some(slot) = mission_slot(&details.maps) else { continue };
            if slot == store_target {
                continue;
            }
            let destination = profile.join(relative);
            if destination.is_file() && fs::read(&destination).map_err(io_error)? == fs::read(&stored).map_err(io_error)? {
                misfiled.push(MisfiledSave { stored, live: None });
                continue;
            }
            // A free name: not on disk, not about to be written by this switch, not taken above.
            let folder = destination.parent().ok_or("Stored save has no folder.")?.to_path_buf();
            let stem = destination.file_stem().and_then(|stem| stem.to_str()).unwrap_or("Mission").to_string();
            let live = std::iter::once(destination.clone())
                .chain((2..1000).map(|number| folder.join(format!("{stem} ({number}).SC2Save"))))
                .find(|candidate| !candidate.exists() && !reserved.contains(candidate))
                .ok_or("No free name is left for a save that is coming back.")?;
            reserved.insert(live.clone());
            misfiled.push(MisfiledSave { stored, live: Some(live) });
        }
    }
    Ok(misfiled)
}
