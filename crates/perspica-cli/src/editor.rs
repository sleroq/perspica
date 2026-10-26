//! Local editor launching. Browser requests name review indexes, never commands or paths.
use crate::{FileEntry, MultiFileResult};
use perspica_core::manifest::{ChangeKind, DiffHunk};
use std::path::{Path, PathBuf};
use std::process::Stdio;

pub struct Editor {
    executable: Option<PathBuf>,
    root: PathBuf,
}

impl Editor {
    pub fn new(explicit: Option<PathBuf>) -> Result<Self, String> {
        let executable = explicit.or_else(|| {
            ["PERSPICA_EDITOR", "VISUAL", "EDITOR"]
                .iter()
                .filter_map(std::env::var_os)
                .find(|v| !v.is_empty())
                .map(PathBuf::from)
        });
        Ok(Self {
            executable,
            root: std::env::current_dir().map_err(|e| e.to_string())?,
        })
    }

    pub fn name(&self) -> String {
        self.executable
            .as_ref()
            .map(|p| {
                p.file_name()
                    .unwrap_or(p.as_os_str())
                    .to_string_lossy()
                    .into_owned()
            })
            .unwrap_or_else(|| "system default application".into())
    }

    fn path(&self, file: &FileEntry) -> Result<PathBuf, String> {
        if file.status == "D" {
            return Err("This file was deleted; there is no new-side file to open.".into());
        }
        if file.binary {
            return Err("Opening binary files from the review is not supported.".into());
        }
        let path = self.root.join(&file.new_path);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("File unavailable on disk: {e}"))?;
        if !metadata.file_type().is_file() {
            return Err(
                "Only regular files can be opened, not directories or symbolic links.".into(),
            );
        }
        let content = std::fs::read(&path).map_err(|e| format!("Could not read file: {e}"))?;
        if String::from_utf8_lossy(&content) != file.new_source {
            return Err(
                "The file on disk differs from this review. Refresh the review before opening it."
                    .into(),
            );
        }
        path.canonicalize()
            .map_err(|e| format!("File unavailable on disk: {e}"))
    }

    pub fn unavailable(&self, file: &FileEntry) -> Option<String> {
        self.path(file).err()
    }

    pub async fn open(
        &self,
        review: &MultiFileResult,
        file: usize,
        hunk: Option<usize>,
    ) -> Result<(), String> {
        let entry = review
            .files
            .get(file)
            .ok_or("That file is not in this review.")?;
        let path = self.path(entry)?;
        let hunks = &review
            .results
            .get(file)
            .ok_or("No diff for that file.")?
            .hunks;
        let chosen = match hunk {
            Some(i) => Some(hunks.get(i).ok_or("That change is not in this review.")?),
            None => hunks.first(),
        };
        let line = chosen.and_then(|h| changed_line(h, &entry.new_source));
        let Some(executable) = &self.executable else {
            return tokio::task::spawn_blocking(move || open::that(path))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("Could not open the default application: {e}"));
        };
        let name = executable
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if matches!(name, "nvim" | "vim" | "vi" | "nano") {
            return Err("A terminal editor needs a terminal. Restart with --editor zed, another GUI editor, or an executable wrapper that opens a terminal.".into());
        }
        let mut command = tokio::process::Command::new(executable);
        // Absolute paths cannot be interpreted as options. Zed's documented position syntax
        // is path:line:column; other executables receive just the file, as one argument.
        command
            .arg(argument(name, &path, line))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|e| format!("Could not launch {}: {e}. Set --editor to a GUI editor executable (no shell arguments).", self.name()))?;
        match tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await {
            Ok(status) => {
                let status = status.map_err(|e| format!("Could not wait for the editor: {e}"))?;
                if !status.success() {
                    return Err(format!(
                        "{} exited with {status}. Check the editor configuration (--editor).",
                        self.name()
                    ));
                }
            }
            // Some GUI editors stay alive. Reap them without holding the request open.
            Err(_) => {
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
            }
        }
        Ok(())
    }
}

fn argument(name: &str, path: &Path, line: Option<usize>) -> std::ffi::OsString {
    let mut argument = path.as_os_str().to_owned();
    if name == "zed" {
        if let Some(line) = line {
            argument.push(format!(":{line}:1"));
        }
    }
    argument
}

fn changed_line(hunk: &DiffHunk, source: &str) -> Option<usize> {
    let count = source.lines().count();
    if count == 0 {
        return None;
    }
    let changed = hunk
        .changes
        .iter()
        .filter(|c| c.kind != ChangeKind::Context)
        .find_map(|c| c.new_span.as_ref().map(|s| s.start_line));
    Some(changed.unwrap_or(hunk.new_range.start).clamp(1, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_added_and_removed_lines_to_the_new_side() {
        let hunks =
            crate::git::parse_unified_diff("@@ -1,3 +1,3 @@\n context\n-old\n+new\n tail\n");
        assert_eq!(changed_line(&hunks[0], "context\nnew\ntail\n"), Some(2));
        let hunks = crate::git::parse_unified_diff("@@ -2,2 +2,0 @@\n-old\n-tail\n");
        assert_eq!(changed_line(&hunks[0], "context\n"), Some(1));
        assert_eq!(changed_line(&hunks[0], ""), None);
    }

    #[test]
    fn zed_position_is_one_argument_and_generic_editors_get_only_the_path() {
        let path = Path::new("/review/-a file λ.ts");
        assert_eq!(argument("zed", path, Some(7)), "/review/-a file λ.ts:7:1");
        assert_eq!(argument("other", path, Some(7)), path.as_os_str());
        assert_eq!(argument("zed", path, None), path.as_os_str());
    }
}
