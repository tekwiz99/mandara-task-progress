//! Mandara plugin: a running-light progress bar for long tasks.
//!
//! The plugin is sandboxed, so progress arrives through its own settings:
//! the companion CLI writes them with `mandara msg config set`, and
//! `host::setting` reads them on the next render. The live desktop now uses
//! Mandara's built-in `progress` plugin instead; this Wasm plugin is kept as
//! a reference. The bar item shows a small chase light, a real meter and the percentage;
//! the panel holds the details. A completion toast uses the broker.

mod tree;

use std::cell::{Cell, RefCell};
use std::fmt::Write as _;

wit_bindgen::generate!({ world: "plugin", path: "wit" });

use mandara::plugin::broker;
use mandara::plugin::host;
use mandara::plugin::types::Tone;
use mandara::plugin::ui::{self, Kind as K, Shape, Surface, Value};
use tree::Tree;

/// Canvas and broker are the only optional surfaces this plugin uses.
const FEATURES: &[&str] = &["ui.layout", "ui.canvas", "broker"];

/// Animation/rendering interval: 250 ms is the host minimum. The spinner
/// itself runs on OpenCode's 80 ms clock, so each redraw samples three frames
/// and the head moves at OpenCode's real speed rather than 3x slower.
const REFRESH_MS: u32 = 250;
const BAR_DOTS: usize = 8;
const PANEL_DOTS: usize = 8;
const CHASE_STEP_MS: u64 = 80;

/// OpenCode's "blocks" spinner shape: a scanner across `width` cells with a
/// six-step trailing glow. OpenCode holds 30/9 frames at the ends, but at
/// Mandara's 4 fps that reads as a dead pause, so the holds are shortened to
/// keep the light moving continuously.
const HOLD_START_FRAMES: u64 = 2;
const HOLD_END_FRAMES: u64 = 1;
const TRAIL: usize = 6;
const INACTIVE_ALPHA: f32 = 0.6;

/// Bar sizes, on Mandara's 4 px rhythm.
const BAR_GAP: f32 = 6.0;
const BAR_CHASE_W: f32 = 22.0;
const BAR_CHASE_H: f32 = 10.0;
const BAR_METER_W: f32 = 56.0;
const BAR_METER_H: f32 = 6.0;
const BAR_TEXT_PX: f32 = 12.0;
const BAR_ICON_PX: f32 = 14.0;

/// Panel sizes.
const PANEL_GAP: f32 = 16.0;
const ROW_GAP: f32 = 8.0;
const TIGHT_GAP: f32 = 4.0;
const LABEL_PX: f32 = 16.0;
const HERO_PX: f32 = 36.0;
const CAPTION_PX: f32 = 12.0;
const METER_H: f32 = 12.0;
const CHASE_H: f32 = 14.0;
const CHIP_PX: f32 = 11.0;
const ICON_PX: f32 = 16.0;
#[derive(Copy, Clone, PartialEq, Eq)]
enum Phase {
    Idle,
    Running,
    Question,
    Done,
    Error,
}

impl Phase {
    fn parse(value: &str) -> Self {
        match value {
            "running" => Phase::Running,
            "question" => Phase::Question,
            "done" => Phase::Done,
            "error" => Phase::Error,
            _ => Phase::Idle,
        }
    }

    fn tone(self) -> Tone {
        match self {
            Phase::Idle => Tone::Muted,
            Phase::Running => RUN_TONE.get(),
            Phase::Question => Tone::Warning,
            Phase::Done => Tone::Success,
            Phase::Error => Tone::Error,
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Phase::Idle => "circle",
            Phase::Running => "timer",
            Phase::Question => "info",
            Phase::Done => "check",
            Phase::Error => "alert",
        }
    }

    /// Plain English key: the host translates view text for us after render.
    fn label(self) -> &'static str {
        match self {
            Phase::Idle => "Idle",
            Phase::Running => "Running",
            Phase::Question => "Need confirm",
            Phase::Done => "Finished",
            Phase::Error => "Failed",
        }
    }
}

thread_local! {
    /// The tone chosen for "running" this render: the theme's accent when it
    /// is distinguishable from warning, otherwise normal (white).
    static RUN_TONE: Cell<Tone> = const { Cell::new(Tone::Accent) };
    /// Whether the panel shows its explanatory rows.
    static DETAILS: Cell<bool> = const { Cell::new(false) };
    /// The task key seen running, and the one already notified about.
    static SEEN_RUNNING: RefCell<String> = const { RefCell::new(String::new()) };
    static NOTIFIED: RefCell<String> = const { RefCell::new(String::new()) };
}

fn is_seen_running(key: &str) -> bool {
    SEEN_RUNNING.with(|s| s.borrow().as_str() == key)
}

fn is_notified(key: &str) -> bool {
    NOTIFIED.with(|s| s.borrow().as_str() == key)
}

fn digit(c: u8) -> i32 {
    match c {
        b'0'..=b'9' => (c - b'0') as i32,
        b'a'..=b'f' => (c - b'a' + 10) as i32,
        b'A'..=b'F' => (c - b'A' + 10) as i32,
        _ => -1,
    }
}

fn rgb(hex: &str) -> [f32; 3] {
    let b = hex.as_bytes();
    if b.len() != 7 || b[0] != b'#' {
        return [0.0; 3];
    }
    let mut out = [0.0; 3];
    for (i, c) in out.iter_mut().enumerate() {
        let hi = digit(b[1 + i * 2]);
        let lo = digit(b[2 + i * 2]);
        if hi < 0 || lo < 0 {
            return [0.0; 3];
        }
        *c = (hi * 16 + lo) as f32 / 255.0;
    }
    out
}

/// When the theme's accent is too close to its warning colour (both gold in
/// some Looks), "running" uses the neutral tone so the three states stay
/// distinguishable. With a blue-primary theme it is blue automatically.
fn running_tone(theme: &Palette) -> Tone {
    thread_local! {
        static CACHE: RefCell<Option<(bool, String, String, Tone)>> = const { RefCell::new(None) };
    }
    CACHE.with(|cell| {
        let mut cache = cell.borrow_mut();
        if let Some((dark, primary, warning, tone)) = cache.as_ref()
            && *dark == theme.dark
            && primary == &theme.primary
            && warning == &theme.warning
        {
            return *tone;
        }
        let a = rgb(&theme.primary);
        let b = rgb(&theme.warning);
        let distance = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
        let tone = if distance < 0.18 { Tone::Normal } else { Tone::Accent };
        *cache = Some((theme.dark, theme.primary.clone(), theme.warning.clone(), tone));
        tone
    })
}

/// A setting's JSON text for a string key: `"value"` -> `value`.
fn json_text(raw: &str) -> String {
    let s = raw.trim();
    if s.len() < 2 || !s.starts_with('"') || !s.ends_with('"') {
        return s.to_string();
    }
    let inner = &s[1..s.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn text_setting(key: &str) -> String {
    host::setting(key)
        .as_deref()
        .map(json_text)
        .unwrap_or_default()
}

fn num_setting(key: &str) -> f64 {
    host::setting(key)
        .as_deref()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn flag_setting(key: &str) -> bool {
    host::setting(key).as_deref() == Some("true")
}

fn percent() -> f32 {
    (num_setting("percent") as f32).clamp(0.0, 100.0)
}

fn task_key(label: &str) -> String {
    let started = num_setting("started") as u64;
    let mut key = String::with_capacity(label.len() + 24);
    let _ = write!(&mut key, "{started}:{label}");
    key
}

fn json_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(&mut out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `ms` as a short, stable-width duration.
fn duration(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

fn elapsed(now: u64) -> String {
    let started = num_setting("started") as u64;
    if started == 0 {
        return "—".to_string();
    }
    duration(now.saturating_sub(started))
}

/// The position and direction of OpenCode's scanner at a given frame.
fn scanner(frame: u64, count: usize) -> (usize, bool) {
    let n = count as u64;
    let total = n + HOLD_END_FRAMES + n - 1 + HOLD_START_FRAMES;
    let frame = frame % total;
    if frame < n {
        return (frame as usize, true);
    }
    let f = frame - n;
    if f < HOLD_END_FRAMES {
        return (count - 1, true);
    }
    let f = f - HOLD_END_FRAMES;
    if f < n - 1 {
        return (count - 2 - f as usize, false);
    }
    (0, false)
}

/// Alpha of the trailing glow: full at the head, a slight bloom behind it,
/// then exponential decay, as in OpenCode's `deriveTrailColors`.
fn trail_alpha(distance: usize) -> f32 {
    match distance {
        0 => 1.0,
        1 => 0.9,
        d => 0.65_f32.powi((d - 1) as i32),
    }
}

/// The chase light, styled after OpenCode's "blocks" spinner: small dim
/// squares with a bright block and a fading trail scanning back and forth.
fn marks(p: Phase, count: usize, now: u64) -> Vec<ui::Mark> {
    let tone = p.tone();
    // Static mode: one steady lit cell, no timer and no motion.
    if !flag_setting("animate") {
        let slot = 0.92 / count as f32;
        let width = slot * 0.78;
        return (0..count)
            .map(|i| ui::Mark {
                shape: Shape::Rect,
                x: 0.04 + i as f32 * slot + (slot - width) * 0.5,
                y: 0.19,
                width,
                height: 0.62,
                opacity: if p == Phase::Running && i == 0 {
                    1.0
                } else if p == Phase::Idle {
                    0.35
                } else {
                    0.6
                },
                radius: 0.0,
                tone,
            })
            .collect();
    }

    let frame = now / CHASE_STEP_MS;
    let (active, forward) = scanner(frame, count);
    let slot = 0.92 / count as f32;
    let block_w = slot * 0.78;
    let dot_w = slot * 0.34;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let distance = if forward {
            active as isize - i as isize
        } else {
            i as isize - active as isize
        };
        let (width, height, opacity) = match p {
            Phase::Running if distance >= 0 && (distance as usize) < TRAIL => {
                (block_w, 0.62, trail_alpha(distance as usize))
            }
            Phase::Running | Phase::Idle => (dot_w, 0.30, INACTIVE_ALPHA),
            _ => (block_w, 0.62, 1.0),
        };
        out.push(ui::Mark {
            shape: Shape::Rect,
            x: 0.04 + i as f32 * slot + (slot - width) * 0.5,
            y: (1.0 - height) * 0.5,
            width,
            height,
            tone,
            opacity,
            radius: 0.0,
        });
    }
    out
}

fn chase(t: &mut Tree, p: Phase, count: usize, w: f32, h: f32, now: u64) -> u32 {
    let i = t.add(K::Canvas, "");
    t.node(i).marks = marks(p, count, now);
    t.node(i).style.width = w;
    t.node(i).style.height = h;
    i
}

/// A fixed-width meter for the bar. The host's `meter` node always stretches
/// to its parent, which would push the percentage off the bar, so the compact
/// version is drawn as two canvas marks instead.
fn mini_meter(t: &mut Tree, p: Phase, w: f32, h: f32, percentage: f32) -> u32 {
    let i = t.add(K::Canvas, "");
    let fill = percentage / 100.0;
    t.node(i).marks = vec![
        ui::Mark {
            shape: Shape::Rect,
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            tone: Tone::Muted,
            opacity: 0.28,
            radius: h * 0.5,
        },
        ui::Mark {
            shape: Shape::Rect,
            x: 0.0,
            y: 0.0,
            width: fill,
            height: 1.0,
            tone: p.tone(),
            opacity: 1.0,
            radius: h * 0.5,
        },
    ];
    t.node(i).style.width = w;
    t.node(i).style.height = h;
    i
}

fn meter(t: &mut Tree, p: Phase, w: f32, h: f32, percentage: f32) -> u32 {
    let i = t.add(K::Meter, "");
    t.node(i).value = percentage / 100.0;
    t.node(i).style.width = w;
    t.node(i).style.height = h;
    t.tone(i, p.tone());
    i
}

fn pct_label(t: &mut Tree, p: Phase, size: f32, percentage: f32) -> u32 {
    let i = t.text(&format!("{:.0}%", percentage), size);
    t.bold(i);
    t.tone(i, p.tone());
    i
}

/// Bar item: the running light, plus a meter and percentage only when asked.
fn bar() -> ui::View {
    let mut t = Tree::default();
    let p = Phase::parse(&text_setting("state"));
    let kids = if p == Phase::Idle {
        let icon = t.add(K::Icon, "circle");
        t.node(icon).style.size = BAR_ICON_PX;
        t.tone(icon, Tone::Muted);
        let label = t.text("Idle", BAR_TEXT_PX);
        t.tone(label, Tone::Muted);
        vec![icon, label]
    } else {
        let now = host::now_unix_ms();
        let percentage = percent();
        let mut kids = vec![chase(&mut t, p, BAR_DOTS, BAR_CHASE_W, BAR_CHASE_H, now)];
        if flag_setting("show_bar_meter") {
            kids.push(mini_meter(&mut t, p, BAR_METER_W, BAR_METER_H, percentage));
        }
        if flag_setting("show_percent") {
            kids.push(pct_label(&mut t, p, BAR_TEXT_PX, percentage));
        }
        kids
    };
    let root = t.row(BAR_GAP, &kids);
    t.view(root)
}

/// Detail panel: one hero value, the chase, and a short set of facts.
fn panel() -> ui::View {
    let mut t = Tree::default();
    let now = host::now_unix_ms();
    let percentage = percent();
    let p = Phase::parse(&text_setting("state"));
    let label = text_setting("label");
    let title: &str = if label.is_empty() { "No active task" } else { &label };

    let icon = t.add(K::Icon, p.icon());
    t.node(icon).style.size = ICON_PX;
    t.tone(icon, p.tone());

    let name = t.text(title, LABEL_PX);
    t.bold(name);
    t.grow(name);

    let chip = t.text(p.label(), CHIP_PX);
    t.tone(chip, p.tone());
    let header = t.row(ROW_GAP, &[icon, name, chip]);

    let hero = pct_label(&mut t, p, HERO_PX, percentage);
    let caption = t.text("complete", CAPTION_PX);
    t.tone(caption, Tone::Muted);
    let hero_row = t.row(ROW_GAP, &[hero, caption]);

    let bar = meter(&mut t, p, 0.0, METER_H, percentage);
    t.grow(bar);
    let light = chase(&mut t, p, PANEL_DOTS, 0.0, CHASE_H, now);
    t.grow(light);

    let mut rows = Vec::with_capacity(3);
    let elapsed_row = line(&mut t, "Elapsed", &elapsed(now));
    rows.push(elapsed_row);
    let step = text_setting("step");
    if !step.is_empty() {
        rows.push(line(&mut t, "Step", &step));
    }
    if DETAILS.get() {
        rows.push(line(&mut t, "Progress", &format!("{:.0}%", percentage)));
    }
    let group = t.group(&rows);

    let toggle_label = if DETAILS.get() { "Hide details" } else { "Show details" };
    let toggle = t.add(K::Button, toggle_label);
    t.node(toggle).action = "details".into();

    let mut kids = vec![header, hero_row, bar, light];
    if !rows.is_empty() {
        kids.push(t.add(K::Divider, ""));
    }
    kids.push(group);
    kids.push(toggle);
    if DETAILS.get() {
        let hint = t.text("Update it with task-progress set <percent>", CAPTION_PX);
        t.tone(hint, Tone::Muted);
        kids.push(hint);
        // A key for the state colors, using the theme's own palette.
        let key_caption = t.text("Status colors", CAPTION_PX);
        t.tone(key_caption, Tone::Muted);
        kids.push(key_caption);
        let mut key = Vec::with_capacity(4);
        for (name, tone) in [
            ("Running", RUN_TONE.get()),
            ("Need confirm", Tone::Warning),
            ("Finished", Tone::Success),
            ("Failed", Tone::Error),
        ] {
            let label = t.text(name, CHIP_PX);
            t.tone(label, tone);
            key.push(label);
        }
        kids.push(t.row(ROW_GAP, &key));
    }

    let root = t.column(PANEL_GAP, &kids);
    t.view(root)
}

fn line(t: &mut Tree, label: &str, value: &str) -> u32 {
    let l = t.text(label, 0.0);
    t.tone(l, Tone::Muted);
    let spacer = t.add(K::Spacer, "");
    let v = t.text(value, 0.0);
    t.bold(v);
    t.row(ROW_GAP, &[l, spacer, v])
}

/// Sidebar card: a quiet summary of the same data.
fn sidebar() -> ui::View {
    let mut t = Tree::default();
    let percentage = percent();
    let p = Phase::parse(&text_setting("state"));
    let label = text_setting("label");
    let name: &str = if label.is_empty() { "No active task" } else { &label };
    let title = t.text(name, LABEL_PX);
    t.bold(title);
    let value = pct_label(&mut t, p, 0.0, percentage);
    let spacer = t.add(K::Spacer, "");
    let head = t.row(ROW_GAP, &[title, spacer, value]);
    let bar = meter(&mut t, p, 0.0, BAR_METER_H, percentage);
    t.grow(bar);
    let caption = t.text(p.label(), CAPTION_PX);
    t.tone(caption, Tone::Muted);
    let root = t.column(TIGHT_GAP, &[head, bar, caption]);
    t.view(root)
}

/// Post one toast when a running task first becomes done.
fn maybe_notify(p: Phase) {
    if p == Phase::Running {
        SEEN_RUNNING.replace(task_key(&text_setting("label")));
        return;
    }
    if p != Phase::Done || !flag_setting("notify_done") {
        return;
    }
    let key = task_key(&text_setting("label"));
    if !is_seen_running(&key) || is_notified(&key) {
        return;
    }
    NOTIFIED.replace(key);
    let label = text_setting("label");
    let body = if label.is_empty() {
        host::translate("Your task is done")
    } else {
        label
    };
    let payload = format!(
        "{{\"title\":{},\"body\":{}}}",
        json_quote(&host::translate("Task complete")),
        json_quote(&body)
    );
    let _ = broker::submit(&broker::Request {
        capability: "notifications.send".into(),
        operation: "send".into(),
        payload,
    });
}

struct Plugin;

impl Guest for Plugin {
    fn negotiate(_host: mandara::plugin::platform::HostInfo) -> Vec<String> {
        FEATURES.iter().map(|f| (*f).to_string()).collect()
    }

    fn init() -> Result<(), String> {
        Ok(())
    }

    fn refresh_ms() -> u32 {
        if flag_setting("animate") {
            REFRESH_MS
        } else {
            0
        }
    }

    fn render(theme: Palette, context: ui::Context) -> Option<ui::View> {
        RUN_TONE.set(running_tone(&theme));
        match context.surface {
            Surface::Bar => {
                maybe_notify(Phase::parse(&text_setting("state")));
                Some(bar())
            }
            Surface::Panel => Some(panel()),
            Surface::Sidebar => Some(sidebar()),
            _ => None,
        }
    }

    fn on_event(event: ui::Event) {
        if event.node == "details" && matches!(event.value, Value::Activate) {
            DETAILS.set(!DETAILS.get());
        }
    }

    fn launcher_query(_provider: String, _query: String, _limit: u32) -> Vec<ui::Hit> {
        Vec::new()
    }

    fn on_call(_caller: String, operation: String, _payload: String) -> Result<String, String> {
        Err(operation)
    }
}

export!(Plugin);
