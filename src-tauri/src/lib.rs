mod history;
mod procs;
mod rate_limits;
mod tray_icon;
mod workers;

use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 背景で状態を取り直す間隔。
const REFRESH_INTERVAL: Duration = Duration::from_secs(30);
/// この割合を超えたら、メニューバーでも色を出して知らせる。
const ALERT_PERCENT: f32 = 85.0;
/// 長時間稼働とみなす既定の境目。
const STALE_HOURS: f64 = 2.0;
/// 状態が更新されたことをフロントへ伝えるイベント名。
const REFRESH_EVENT: &str = "hotaru://refreshed";

const TRAY_ID: &str = "hotaru";
const MAIN_WINDOW: &str = "main";
const POPOVER_WINDOW: &str = "popover";

#[tauri::command]
async fn read_rate_limits() -> Result<rate_limits::RateLimits, String> {
    tauri::async_runtime::spawn_blocking(rate_limits::read)
        .await
        .map_err(|e| format!("使用状況の読み取りに失敗しました: {e}"))
}

#[tauri::command]
async fn detect_stale_procs(hours: Option<f64>) -> Result<procs::DetectResult, String> {
    let hours = hours.unwrap_or(STALE_HOURS);
    tauri::async_runtime::spawn_blocking(move || procs::detect(hours))
        .await
        .map_err(|e| format!("プロセスの検出に失敗しました: {e}"))?
}

#[tauri::command]
async fn kill_stale_procs(pids: Vec<i32>) -> Result<procs::KillResult, String> {
    tauri::async_runtime::spawn_blocking(move || procs::kill_procs(pids))
        .await
        .map_err(|e| format!("プロセスの停止に失敗しました: {e}"))
}

#[tauri::command]
async fn read_usage_history(days: Option<usize>) -> Result<history::UsageHistory, String> {
    let days = days.unwrap_or(14);
    tauri::async_runtime::spawn_blocking(move || history::read(days))
        .await
        .map_err(|e| format!("使用履歴の読み取りに失敗しました: {e}"))
}

#[tauri::command]
async fn read_day_hours(date: String) -> Result<Vec<u64>, String> {
    tauri::async_runtime::spawn_blocking(move || history::day_hours(&date))
        .await
        .map_err(|e| format!("時間帯の集計に失敗しました: {e}"))?
}

#[tauri::command]
async fn list_workers() -> Result<workers::WorkerList, String> {
    tauri::async_runtime::spawn_blocking(workers::list)
        .await
        .map_err(|e| format!("ワーカーの取得に失敗しました: {e}"))?
}

#[tauri::command]
async fn list_dev_procs(hours: Option<f64>) -> Result<procs::DevList, String> {
    let hours = hours.unwrap_or(STALE_HOURS);
    tauri::async_runtime::spawn_blocking(move || procs::list_dev(hours))
        .await
        .map_err(|e| format!("プロセス一覧の取得に失敗しました: {e}"))?
}

#[tauri::command]
async fn wire_statusline() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(rate_limits::wire)
        .await
        .map_err(|e| format!("設定処理に失敗しました: {e}"))?
}

/// ウィンドウを前面に出す。tray やメニューから呼ぶため、重い処理はしない。
fn show_window(app: &tauri::AppHandle) {
    set_dock_visible(app, true);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Dock にアイコンを出すかどうかを切り替える。
///
/// Dock に出る「通常のアプリ」は、前面に出ないまま他アプリの全画面スペースへ
/// 窓を出せない。メニューバーに常駐するアプリが揃って Dock を持たないのは
/// この制約があるため。小窓だけを使っている間は Dock から降り、
/// ちゃんとした窓を開いている間だけ Dock に戻る。
#[cfg(target_os = "macos")]
fn set_dock_visible(app: &tauri::AppHandle, visible: bool) {
    let _ = app.set_activation_policy(if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    });
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_app: &tauri::AppHandle, _visible: bool) {}

/// 他のアプリが全画面のときでもメニューバーの小窓を手前に出す。
///
/// 全画面は専用のスペースになるため、素直に出そうとすると 3 つとも引っかかる。
///
/// - 小窓がそのスペースへ付いて行けない。すべてのスペースに顔を出してよく、
///   全画面の添え物として扱ってよいことを伝える
/// - 高さが足りない。`always_on_top` が使う `NSFloatingWindowLevel`（3）は
///   メニューバー（24）より下で、全画面の下に沈む
/// - 前面に出す指示がアプリの起動待ちになる。`set_focus` は
///   `activateIgnoringOtherApps` を非同期で投げるだけなので、その前に
///   `orderFrontRegardless` で窓自体を手前へ運んでおく
#[cfg(target_os = "macos")]
fn present_over_fullscreen(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    /// NSPopUpMenuWindowLevel。開いたメニューと同じ高さ。
    const POPUP_MENU_LEVEL: isize = 101;

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    // tauri が返す生ポインタは、この窓が生きている間だけ有効。
    let ns = unsafe { &*(ptr as *const NSWindow) };
    let before = ns.collectionBehavior();
    ns.setCollectionBehavior(
        before
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary,
    );
    ns.setLevel(POPUP_MENU_LEVEL);

    ns.orderFrontRegardless();
}

#[cfg(not(target_os = "macos"))]
fn present_over_fullscreen(_window: &tauri::WebviewWindow) {}

/// アプリが前面でなくても窓だけを手前へ運ぶ。
///
/// `set_focus` は `activateIgnoringOtherApps` を非同期で投げるだけなので、
/// その場では手前に来ない。出した直後にこれを呼んで空白の間をなくす。
#[cfg(target_os = "macos")]
fn order_front_regardless(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    unsafe { &*(ptr as *const NSWindow) }.orderFrontRegardless();
}

#[cfg(not(target_os = "macos"))]
fn order_front_regardless(_window: &tauri::WebviewWindow) {}

/// TODO: 全画面での挙動を掴むための一時的な記録。原因が確定したら消す。
#[cfg(target_os = "macos")]
fn log_popover_state(window: &tauri::WebviewWindow, main_open: bool) {
    use objc2_app_kit::NSWindow;

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    let ns = unsafe { &*(ptr as *const NSWindow) };
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("hotaru-popover.log"))
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(
                f,
                "main_open={} behavior={:?} level={} visible={} on_active_space={} frame={:?}",
                main_open,
                ns.collectionBehavior(),
                ns.level(),
                ns.isVisible(),
                ns.isOnActiveSpace(),
                ns.frame(),
            )
        });
}

#[cfg(not(target_os = "macos"))]
fn log_popover_state(_window: &tauri::WebviewWindow, _main_open: bool) {}

/// メニューバーのアイコンを押したときの開閉。
///
/// アイコンの位置は実ピクセルで届くため、窓の倍率で論理座標に直してから置く。
/// ここを取り違えると Retina では画面の外に飛んでいく。
fn toggle_popover(app: &tauri::AppHandle, rect: tauri::Rect) {
    let Some(window) = app.get_webview_window(POPOVER_WINDOW) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let anchor = rect.position.to_logical::<f64>(scale);
    let icon = rect.size.to_logical::<f64>(scale);
    let width = window
        .outer_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(330.0);

    let x = anchor.x + icon.width / 2.0 - width / 2.0;
    let y = anchor.y + icon.height + 6.0;
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
        x: x.max(8.0),
        y,
    }));

    // ちゃんとした窓を開いていないなら Dock から降りる。全画面のスペースへ
    // 出られるかどうかがここで決まるので、窓を出す前に済ませる。
    let main_open = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !main_open {
        set_dock_visible(app, false);
    }

    // スペースへの割り当ては窓を出す時に決まる。出してから変えても移らない。
    present_over_fullscreen(&window);
    let _ = window.show();
    order_front_regardless(&window);
    log_popover_state(&window, main_open);
    // 外側を押したら閉じる作りが焦点の変化に乗っているため、focus は残す。
    let _ = window.set_focus();
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    if let Some(pop) = app.get_webview_window(POPOVER_WINDOW) {
        let _ = pop.hide();
    }
    show_window(&app);
}

/// 背景で状態を取り直し、変化したときだけアイコンを描き替える。
fn spawn_refresh_loop(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<(Option<i32>, bool)> = None;
        loop {
            let limits = rate_limits::read();
            let percentage = limits.five_hour.as_ref().map(|w| w.used_percentage as f32);
            let has_stale = procs::detect(STALE_HOURS)
                .map(|d| d.procs.iter().any(|p| p.certain))
                .unwrap_or(false);
            let alert = percentage.map(|p| p >= ALERT_PERCENT).unwrap_or(false);

            // 小数の揺れで描き直さないよう、整数の百分率で変化を見る。
            let key = (percentage.map(|p| p.round() as i32), has_stale);
            if last != Some(key) {
                if let Some(tray) = app.tray_by_id(TRAY_ID) {
                    // set_icon は単体だとテンプレート指定を落とし、暗いメニューバーで
                    // 黒いまま沈んで見えなくなる。必ず両方を一度に渡す。
                    let _ = tray.set_icon_with_as_template(
                        Some(tray_icon::render(percentage, has_stale, alert)),
                        !alert,
                    );
                    // 輪だけでは細かい割合が読めないので、隣に数字も出す。
                    let _ = tray.set_title(percentage.map(|p| format!("{}%", p.round() as i32)));
                }
                last = Some(key);
            }

            let _ = app.emit(REFRESH_EVENT, ());
            std::thread::sleep(REFRESH_INTERVAL);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_rate_limits,
            read_usage_history,
            read_day_hours,
            list_workers,
            detect_stale_procs,
            list_dev_procs,
            kill_stale_procs,
            wire_statusline,
            open_main_window
        ])
        .setup(|app| {
            let open_item = MenuItem::with_id(app, "open", "hotaru を開く", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray_icon::render(None, false, false))
                .icon_as_template(true)
                .menu(&menu)
                // 左クリックはウィンドウの開閉に使うため、メニューは右クリックだけに出す。
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            // 自動更新（デスクトップのみ）
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            spawn_refresh_loop(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 閉じても終了せず、メニューバーに残して常駐を保つ。
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                if window.label() == MAIN_WINDOW {
                    set_dock_visible(window.app_handle(), false);
                }
            }
            // 小窓は他所を触ったらしまう。
            tauri::WindowEvent::Focused(false) if window.label() == POPOVER_WINDOW => {
                let _ = window.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // dock のアイコンを押したときに、しまってあるウィンドウを呼び戻す。
            if let tauri::RunEvent::Reopen { .. } = event {
                show_window(app);
            }
        });
}
