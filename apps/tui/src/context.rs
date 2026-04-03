use std::path::PathBuf;

/// Returns the canonical current working directory.
pub fn canonical_cwd() -> Option<PathBuf> {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.canonicalize().ok())
}
