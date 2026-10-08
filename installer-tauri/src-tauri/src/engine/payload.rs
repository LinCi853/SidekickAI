use std::path::Path;
use std::process::{Command, Stdio};

use super::CommandHidden;

pub(crate) fn clear_readonly_attributes(directory: &Path) {
    let _ = Command::new("attrib").hidden().args(["-R", "/S", "/D", &format!("{}\\*", directory.display())])
        .stdout(Stdio::null()).stderr(Stdio::null()).status();
}
