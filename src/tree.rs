//! A tiny arena builder for plugin views.

use crate::mandara::plugin::types::Tone;
use crate::mandara::plugin::ui;

fn style() -> ui::Style {
    ui::Style {
        width: 0.0,
        height: 0.0,
        min_width: 0.0,
        min_height: 0.0,
        padding: 0.0,
        gap: 0.0,
        radius: 0.0,
        size: 0.0,
        grow: false,
        bold: false,
        align: ui::Align::Auto,
        tone: Tone::Normal,
    }
}

pub struct Tree {
    nodes: Vec<ui::Node>,
}

impl Default for Tree {
    /// A panel builds ~20 nodes; reserve once instead of growing the arena
    /// several times on every render.
    fn default() -> Self {
        Self { nodes: Vec::with_capacity(32) }
    }
}

impl Tree {
    pub fn add(&mut self, kind: ui::Kind, text: &str) -> u32 {
        self.nodes.push(ui::Node {
            id: String::new(),
            kind,
            text: text.into(),
            hint: String::new(),
            action: String::new(),
            value: 0.0,
            min: 0.0,
            max: 0.0,
            step: 0.0,
            index: 0,
            children: Vec::new(),
            style: style(),
            options: Vec::new(),
            image: 0,
            marks: Vec::new(),
            disabled: false,
        });
        (self.nodes.len() - 1) as u32
    }

    pub fn node(&mut self, i: u32) -> &mut ui::Node {
        &mut self.nodes[i as usize]
    }

    pub fn text(&mut self, text: &str, size: f32) -> u32 {
        let i = self.add(ui::Kind::Text, text);
        self.node(i).style.size = size;
        i
    }

    pub fn tone(&mut self, i: u32, tone: Tone) {
        self.node(i).style.tone = tone;
    }

    pub fn bold(&mut self, i: u32) {
        self.node(i).style.bold = true;
    }

    pub fn grow(&mut self, i: u32) {
        self.node(i).style.grow = true;
    }

    pub fn row(&mut self, gap: f32, kids: &[u32]) -> u32 {
        let i = self.add(ui::Kind::Row, "");
        self.node(i).style.gap = gap;
        self.node(i).children = kids.to_vec();
        i
    }

    pub fn column(&mut self, gap: f32, kids: &[u32]) -> u32 {
        let i = self.add(ui::Kind::Column, "");
        self.node(i).style.gap = gap;
        self.node(i).children = kids.to_vec();
        i
    }

    pub fn group(&mut self, rows: &[u32]) -> u32 {
        let i = self.add(ui::Kind::Group, "");
        self.node(i).children = rows.to_vec();
        i
    }

    pub fn view(self, root: u32) -> ui::View {
        ui::View {
            nodes: self.nodes,
            root,
            focus: String::new(),
        }
    }
}
