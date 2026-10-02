// SPDX-License-Identifier: GPL-3.0-only

fn main() {
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
}
