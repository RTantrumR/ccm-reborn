// The window's title bar takes the page background (`--bg-page` in tokens.css).
// `"theme": "Dark"` in tauri.conf.json already makes it dark everywhere; Windows 11
// can also take the exact colour. Windows 10 ignores the attribute and stays dark.

#[cfg(target_os = "windows")]
fn paint_title_bar(app: &tauri::App) {
    use tauri::Manager;
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR};

    // COLORREF is 0x00BBGGRR: #131418.
    const PAGE_BACKGROUND: u32 = 0x0018_1413;
    let Some(window) = app.get_webview_window("main") else { return; };
    let Ok(hwnd) = window.hwnd() else { return; };
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_CAPTION_COLOR as u32,
            &PAGE_BACKGROUND as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn paint_title_bar(_app: &tauri::App) {}
