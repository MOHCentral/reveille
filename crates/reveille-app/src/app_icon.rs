// SPDX-License-Identifier: GPL-3.0-only

pub fn small(scale_factor: f64) -> tauri::image::Image<'static> {
    // Windows resizes HICONs; supplying the nearest representation avoids shrinking the 256px art.
    if scale_factor <= 1.0 {
        tauri::include_image!("icons/16x16.png")
    } else if scale_factor <= 1.25 {
        tauri::include_image!("icons/20x20.png")
    } else if scale_factor <= 1.5 {
        tauri::include_image!("icons/24x24.png")
    } else if scale_factor <= 1.75 {
        tauri::include_image!("icons/28x28.png")
    } else if scale_factor <= 2.0 {
        tauri::include_image!("icons/32x32.png")
    } else if scale_factor <= 2.5 {
        tauri::include_image!("icons/40x40.png")
    } else if scale_factor <= 3.0 {
        tauri::include_image!("icons/48x48.png")
    } else {
        tauri::include_image!("icons/64x64.png")
    }
}

pub fn window(scale_factor: f64) -> tauri::image::Image<'static> {
    // The taskbar can fall back to this same HICON, so it must cover 32 logical pixels.
    if scale_factor <= 1.0 {
        tauri::include_image!("icons/32x32.png")
    } else if scale_factor <= 1.25 {
        tauri::include_image!("icons/40x40.png")
    } else if scale_factor <= 1.5 {
        tauri::include_image!("icons/48x48.png")
    } else if scale_factor <= 1.75 {
        tauri::include_image!("icons/56x56.png")
    } else if scale_factor <= 2.0 {
        tauri::include_image!("icons/64x64.png")
    } else if scale_factor <= 2.5 {
        tauri::include_image!("icons/80x80.png")
    } else if scale_factor <= 3.0 {
        tauri::include_image!("icons/96x96.png")
    } else {
        tauri::include_image!("icons/128x128.png")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn window_icon_covers_taskbar_pixels_without_upscaling() {
        for (scale, pixels) in [
            (1.0, 32),
            (1.25, 40),
            (1.5, 48),
            (1.75, 56),
            (2.0, 64),
            (3.0, 96),
            (4.0, 128),
        ] {
            let icon = super::window(scale);
            assert_eq!(icon.width(), pixels, "display scale {scale}");
            assert_eq!(icon.height(), pixels);
        }
    }

    #[test]
    fn small_icon_matches_windows_display_scaling() {
        for (scale, pixels) in [
            (1.0, 16),
            (1.25, 20),
            (1.5, 24),
            (1.75, 28),
            (2.0, 32),
            (2.5, 40),
            (3.0, 48),
            (4.0, 64),
        ] {
            let icon = super::small(scale);
            assert_eq!(icon.width(), pixels, "display scale {scale}");
            assert_eq!(icon.height(), pixels);
            assert_eq!(icon.rgba().len(), (pixels * pixels * 4) as usize);
        }
    }
}
