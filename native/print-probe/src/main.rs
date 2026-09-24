//! print-probe: pixel tools for scanned plate prints, built for the nbcad-plate workflow.
//!
//! Every subcommand takes the print (PDF, rendered through `pdftoppm`), the plate size, and
//! works in plate millimetres (origin at the lower-left corner of the plan view, y up):
//!
//!   print-probe calibrate  --pdf P --length L --width W
//!   print-probe crop       --pdf P --length L --width W --region x0,y0,x1,y1 --out o.png [--dpi 400] [--holes h.json] [--grid 10]
//!   print-probe ring-score --pdf P --length L --width W --holes h.json [--dpi 600] [--search 2.5]
//!   print-probe symbols    --pdf P --length L --width W [--region x0,y0,x1,y1] [--dpi 300] [--holes h.json] [--out o.png]
//!
//! Renders are cached per (pdf, dpi, page, crop) under $PRINT_PROBE_CACHE or the temp dir.
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

// ----------------------------------------------------------------------------- images

struct Gray {
    w: usize,
    h: usize,
    px: Vec<u8>,
}

impl Gray {
    #[inline]
    fn at(&self, x: i64, y: i64) -> u8 {
        if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
            255
        } else {
            self.px[y as usize * self.w + x as usize]
        }
    }
}

fn parse_pgm(data: &[u8]) -> Gray {
    // P5 <w> <h> <maxval> then binary data; comments start with '#'
    let mut idx = 0usize;
    let mut fields: Vec<String> = Vec::new();
    while fields.len() < 4 {
        while idx < data.len() && data[idx].is_ascii_whitespace() {
            idx += 1;
        }
        if data[idx] == b'#' {
            while data[idx] != b'\n' {
                idx += 1;
            }
            continue;
        }
        let start = idx;
        while idx < data.len() && !data[idx].is_ascii_whitespace() {
            idx += 1;
        }
        fields.push(String::from_utf8_lossy(&data[start..idx]).to_string());
    }
    idx += 1;
    assert_eq!(fields[0], "P5", "expected a P5 pgm");
    let w: usize = fields[1].parse().unwrap();
    let h: usize = fields[2].parse().unwrap();
    Gray { w, h, px: data[idx..idx + w * h].to_vec() }
}

fn cache_dir() -> PathBuf {
    let dir = std::env::var("PRINT_PROBE_CACHE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("print-probe-cache"));
    fs::create_dir_all(&dir).ok();
    dir
}

/// Render one page (or a pixel crop of it) to grayscale through pdftoppm, cached.
fn render(pdf: &str, dpi: u32, page: u32, crop: Option<(i64, i64, i64, i64)>) -> Gray {
    let meta = fs::metadata(pdf).unwrap_or_else(|_| panic!("cannot read {pdf}"));
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let key = format!(
        "{}-{}-{}-{}-{}-{:?}",
        PathBuf::from(pdf).file_name().unwrap().to_string_lossy(),
        meta.len(),
        stamp,
        dpi,
        page,
        crop
    )
    .replace(['(', ')', ' ', ','], "_");
    let path = cache_dir().join(format!("{key}.pgm"));
    if let Ok(data) = fs::read(&path) {
        if data.len() > 16 {
            return parse_pgm(&data);
        }
    }
    let prefix = cache_dir().join(format!("{key}.tmp"));
    let mut cmd = Command::new("pdftoppm");
    cmd.args(["-gray", "-r", &dpi.to_string(), "-f", &page.to_string(), "-l", &page.to_string()]);
    if let Some((x, y, w, h)) = crop {
        cmd.args(["-x", &x.to_string(), "-y", &y.to_string(), "-W", &w.to_string(), "-H", &h.to_string()]);
    }
    let status = cmd.args(["-singlefile", pdf, prefix.to_str().unwrap()]).status().expect("pdftoppm not found on PATH");
    assert!(status.success(), "pdftoppm failed");
    let produced = cache_dir().join(format!("{key}.tmp.pgm"));
    fs::rename(&produced, &path).expect("rename render");
    parse_pgm(&fs::read(&path).unwrap())
}

// ----------------------------------------------------------------------------- calibration

const CAL_DPI: u32 = 150;

#[derive(Clone, Debug)]
struct Cal {
    dpi: u32,
    tl: (f64, f64),
    tr: (f64, f64),
    bl: (f64, f64),
    br: (f64, f64),
    length: f64,
    width: f64,
}

impl Cal {
    fn px_per_mm(&self) -> f64 {
        (self.br.0 - self.bl.0) / self.length
    }
    fn skew_deg(&self) -> f64 {
        (self.br.1 - self.bl.1).atan2(self.br.0 - self.bl.0).to_degrees()
    }
    /// plate mm -> pixels at `dpi`, minus an optional crop offset
    fn to_px(&self, dpi: u32, off: (f64, f64)) -> impl Fn(f64, f64) -> (f64, f64) + '_ {
        let k = dpi as f64 / self.dpi as f64;
        let (tl, tr, bl, br) = (sc(self.tl, k), sc(self.tr, k), sc(self.bl, k), sc(self.br, k));
        let (l, w) = (self.length, self.width);
        move |x: f64, y: f64| {
            let (u, v) = (x / l, y / w);
            let px = bl.0 + u * (br.0 - bl.0) + v * (tl.0 - bl.0) + u * v * (tr.0 - tl.0 - br.0 + bl.0);
            let py = bl.1 + u * (br.1 - bl.1) + v * (tl.1 - bl.1) + u * v * (tr.1 - tl.1 - br.1 + bl.1);
            (px - off.0, py - off.1)
        }
    }
    /// pixels at `dpi` (plus crop offset) -> plate mm, affine from bl, br, tl
    fn to_mm(&self, dpi: u32, off: (f64, f64)) -> impl Fn(f64, f64) -> (f64, f64) + '_ {
        let k = dpi as f64 / self.dpi as f64;
        let (tl, bl, br) = (sc(self.tl, k), sc(self.bl, k), sc(self.br, k));
        let (ax, ay) = ((br.0 - bl.0) / self.length, (br.1 - bl.1) / self.length);
        let (bx, by) = ((tl.0 - bl.0) / self.width, (tl.1 - bl.1) / self.width);
        let det = ax * by - ay * bx;
        move |px: f64, py: f64| {
            let (dx, dy) = (px + off.0 - bl.0, py + off.1 - bl.1);
            ((dx * by - dy * bx) / det, (ax * dy - ay * dx) / det)
        }
    }
    fn json(&self) -> String {
        format!(
            "{{\"dpi\":{},\"tl\":[{},{}],\"tr\":[{},{}],\"bl\":[{},{}],\"br\":[{},{}],\"px_per_mm\":{:.4},\"skew_deg\":{:.3}}}",
            self.dpi, self.tl.0, self.tl.1, self.tr.0, self.tr.1, self.bl.0, self.bl.1, self.br.0, self.br.1, self.px_per_mm(), self.skew_deg()
        )
    }
}

fn sc(p: (f64, f64), k: f64) -> (f64, f64) {
    (p.0 * k, p.1 * k)
}

fn dark_counts(g: &Gray, x0: usize, x1: usize, y0: usize, y1: usize, thr: u8) -> (Vec<usize>, Vec<usize>) {
    let mut rows = vec![0usize; g.h];
    let mut cols = vec![0usize; g.w];
    for y in y0..y1 {
        let row = &g.px[y * g.w..(y + 1) * g.w];
        for x in x0..x1 {
            if row[x] < thr {
                rows[y] += 1;
                cols[x] += 1;
            }
        }
    }
    (rows, cols)
}

fn peaks(counts: &[usize], lo: usize, hi: usize, n: usize, gap: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (lo..hi).collect();
    order.sort_by(|a, b| counts[*b].cmp(&counts[*a]));
    let mut chosen: Vec<usize> = Vec::new();
    for i in order {
        if chosen.iter().all(|c| (*c as i64 - i as i64).abs() > gap as i64) {
            chosen.push(i);
        }
        if chosen.len() == n {
            break;
        }
    }
    chosen.sort();
    chosen
}

fn calibrate(pdf: &str, page: u32, length: f64, width: f64) -> Cal {
    let g = render(pdf, CAL_DPI, page, None);
    let (rows, cols) = dark_counts(&g, 0, g.w, 0, g.h, 110);
    let (mx, my) = ((g.w as f64 * 0.05) as usize, (g.h as f64 * 0.05) as usize);
    let xc = peaks(&cols, mx, g.w - mx, 8, 12);
    let yc = peaks(&rows, my, g.h - my, 10, 8);
    let mut best: Option<(usize, usize, usize, usize, usize)> = None;
    for i in 0..xc.len() {
        for j in i + 1..xc.len() {
            let span_x = xc[j] - xc[i];
            if (span_x as f64) < g.w as f64 * 0.25 {
                continue;
            }
            for k in 0..yc.len() {
                for l in k + 1..yc.len() {
                    let span_y = yc[l] - yc[k];
                    let err = ((span_y as f64 / span_x as f64) - width / length).abs() / (width / length);
                    if err < 0.03 {
                        let score = cols[xc[i]] + cols[xc[j]] + rows[yc[k]] + rows[yc[l]];
                        if best.map_or(true, |b| score > b.0) {
                            best = Some((score, xc[i], xc[j], yc[k], yc[l]));
                        }
                    }
                }
            }
        }
    }
    let (_, x0, x1, yt, yb) = best.expect("plate outline not found on the page; check --length/--width");
    let scale = (x1 - x0) as f64 / length;
    let band = ((length.min(width) * 0.25 * scale) as usize).max(40);
    let refine_row = |yg: usize, xlo: usize, xhi: usize| -> usize {
        let (r, _) = dark_counts(&g, xlo, xhi.min(g.w), yg.saturating_sub(12), (yg + 13).min(g.h), 110);
        (yg.saturating_sub(12)..(yg + 13).min(g.h)).max_by_key(|y| r[*y]).unwrap()
    };
    let refine_col = |xg: usize, ylo: usize, yhi: usize| -> usize {
        let (_, c) = dark_counts(&g, xg.saturating_sub(12), (xg + 13).min(g.w), ylo, yhi.min(g.h), 110);
        (xg.saturating_sub(12)..(xg + 13).min(g.w)).max_by_key(|x| c[*x]).unwrap()
    };
    let tl = (refine_col(x0, yt + 30, yt + 30 + band) as f64, refine_row(yt, x0 + 30, x0 + 30 + band) as f64);
    let tr = (refine_col(x1, yt + 30, yt + 30 + band) as f64, refine_row(yt, x1 - 30 - band, x1 - 30) as f64);
    let bl = (refine_col(x0, yb - 30 - band, yb - 30) as f64, refine_row(yb, x0 + 30, x0 + 30 + band) as f64);
    let br = (refine_col(x1, yb - 30 - band, yb - 30) as f64, refine_row(yb, x1 - 30 - band, x1 - 30) as f64);
    Cal { dpi: CAL_DPI, tl, tr, bl, br, length, width }
}

// ----------------------------------------------------------------------------- holes json

#[derive(Clone, Debug)]
struct Hole {
    x: f64,
    y: f64,
    d: f64,
    cb: Option<f64>,
}

/// Minimal reader for the inspect/run_script JSON: finds every {"x":..,"y":..,"diameter":..,"counterbore":..} object.
fn read_holes(path: &str) -> Vec<Hole> {
    let text = fs::read_to_string(path).unwrap_or_else(|_| panic!("cannot read {path}"));
    let mut out = Vec::new();
    let mut i = 0;
    let bytes = text.as_bytes();
    while let Some(p) = text[i..].find("\"x\"") {
        let start = i + p;
        // object bounds
        let obj_start = text[..start].rfind('{').unwrap_or(start);
        let obj_end = start + text[start..].find('}').unwrap_or(text.len() - start - 1) + 1;
        let obj = &text[obj_start..obj_end];
        let num = |key: &str| -> Option<f64> {
            let k = format!("\"{key}\"");
            let q = obj.find(&k)? + k.len();
            let rest = obj[q..].trim_start_matches(|c: char| c == ':' || c.is_whitespace());
            let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == 'E' || c == '+')).unwrap_or(rest.len());
            rest[..end].parse().ok()
        };
        if let (Some(x), Some(y), Some(d)) = (num("x"), num("y"), num("diameter")) {
            out.push(Hole { x, y, d, cb: num("counterbore") });
        }
        i = obj_end.max(start + 3);
        if i >= bytes.len() {
            break;
        }
    }
    out
}

// ----------------------------------------------------------------------------- ring score

/// Ring completeness at radius r around (cx, cy): the fraction of the 52 directions that are
/// more than 12 degrees away from the four axes where ink (< 150) lies within +-tol px of r.
/// Leaving the axes out means the crosshair, the centrelines and any line through the centre
/// do not count, so a bare line crossing scores ~0 and a circle scores ~1.
fn ring_completeness_tol(g: &Gray, cx: f64, cy: f64, r: f64, tol: i64) -> f64 {
    let mut hit = 0;
    let mut total = 0;
    for k in 0..72 {
        let deg = k * 5;
        let off_axis = (deg % 90 > 12) && (deg % 90 < 78);
        if !off_axis {
            continue;
        }
        total += 1;
        let a = (deg as f64).to_radians();
        let (ca, sa) = (a.cos(), a.sin());
        for d in -tol..=tol {
            let rr = r + d as f64;
            if g.at((cx + rr * ca).round() as i64, (cy + rr * sa).round() as i64) < 110 {
                hit += 1;
                break;
            }
        }
    }
    hit as f64 / total as f64
}

fn ring_completeness(g: &Gray, cx: f64, cy: f64, r: f64) -> f64 {
    ring_completeness_tol(g, cx, cy, r, 2)
}

/// Interior lightness: 8 directions at 30 and 60 degrees in each quadrant (clear of the
/// crosshair and of an X), sampled in the annulus 0.3 r .. 0.55 r (clear of the ring's inner
/// blur); the fraction whose samples are all paper (> 125). A hole symbol scores >= 0.5, a
/// solid arrowhead, a filled dot or a text glyph scores low.
fn interior_light(g: &Gray, cx: f64, cy: f64, r: f64) -> f64 {
    let mut light = 0;
    for k in 0..8 {
        let deg = 30.0 + 30.0 * (k % 2) as f64 + 90.0 * (k / 2) as f64;
        let a = deg.to_radians();
        let (ca, sa) = (a.cos(), a.sin());
        let mut ok = true;
        for i in 0..4 {
            let rr = r * (0.30 + 0.25 * i as f64 / 3.0);
            if g.at((cx + rr * ca).round() as i64, (cy + rr * sa).round() as i64) <= 125 {
                ok = false;
                break;
            }
        }
        if ok {
            light += 1;
        }
    }
    light as f64 / 8.0
}

/// Fraction of the off-axis directions in which the ink run through radius r is thicker than
/// `max_mm`: a drawn circle is a thin uniform line (~0.15), a solid arrowhead wedge or a
/// line crossed at a shallow angle gives long radial runs.
fn thick_fraction(g: &Gray, cx: f64, cy: f64, r: f64, ppm: f64, max_mm: f64) -> f64 {
    let mut thick = 0;
    let mut total = 0;
    let limit = (max_mm * ppm) as i64;
    for k in 0..72 {
        let deg = k * 5;
        if !((deg % 90 > 12) && (deg % 90 < 78)) {
            continue;
        }
        total += 1;
        let a = (deg as f64).to_radians();
        let (ca, sa) = (a.cos(), a.sin());
        // find a dark pixel within +-2 px of r, then measure the contiguous dark run through it
        let mut found = None;
        for d in -2..=2 {
            let rr = r + d as f64;
            if g.at((cx + rr * ca).round() as i64, (cy + rr * sa).round() as i64) < 110 {
                found = Some(rr);
                break;
            }
        }
        if let Some(rr) = found {
            let mut inner = rr;
            while inner > 0.0 && g.at((cx + (inner - 1.0) * ca).round() as i64, (cy + (inner - 1.0) * sa).round() as i64) < 110 {
                inner -= 1.0;
            }
            let mut outer = rr;
            while outer - rr < 40.0 && g.at((cx + (outer + 1.0) * ca).round() as i64, (cy + (outer + 1.0) * sa).round() as i64) < 110 {
                outer += 1.0;
            }
            if (outer - inner) as i64 > limit {
                thick += 1;
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        thick as f64 / total as f64
    }
}

/// Distance (px) between (cx, cy) and the centroid of the dark pixels within radius `r`.
fn dark_centroid_offset(g: &Gray, cx: f64, cy: f64, r: f64) -> f64 {
    let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
    let ri = r.ceil() as i64;
    for dy in -ri..=ri {
        for dx in -ri..=ri {
            if (dx * dx + dy * dy) as f64 <= r * r && g.at(cx.round() as i64 + dx, cy.round() as i64 + dy) < 110 {
                sx += dx as f64;
                sy += dy as f64;
                n += 1.0;
            }
        }
    }
    if n == 0.0 {
        f64::MAX
    } else {
        ((sx / n).powi(2) + (sy / n).powi(2)).sqrt()
    }
}

/// Fraction of 24 directions (every 15 degrees) that are dark at radius r: for solid discs.
fn disc_dark(g: &Gray, cx: f64, cy: f64, r: f64) -> f64 {
    let mut dark = 0;
    for k in 0..24 {
        let a = (k as f64 + 0.5) * std::f64::consts::TAU / 24.0;
        if g.at((cx + r * a.cos()).round() as i64, (cy + r * a.sin()).round() as i64) < 110 {
            dark += 1;
        }
    }
    dark as f64 / 24.0
}

#[derive(Clone)]
struct Probe {
    kind: &'static str,
    ring: f64,
    interior: f64,
    r_px: f64,
    cb_px: Option<f64>,
    cx: f64,
    cy: f64,
}

fn none_probe(cx: f64, cy: f64) -> Probe {
    Probe { kind: "none", ring: 0.0, interior: 0.0, r_px: 0.0, cb_px: None, cx, cy }
}

fn rank(p: &Probe) -> f64 {
    match p.kind {
        "symbol" => 3.0 + p.ring,
        "dot" => 2.0 + p.ring,
        "dashed" => 1.0 + p.ring,
        _ => 0.0,
    }
}

/// What is drawn exactly at (cx, cy). A solid dot: a full ring at 0.4..1.2 mm with a dark
/// interior and light paper outside. Otherwise the smallest radius from 1.0 mm to r_max with
/// an off-axis ring >= 0.9 and a light interior = "symbol" (a second complete ring within
/// 3.5 r with a not-empty interior is its counterbore); an off-axis ring >= 0.5 with light
/// interior and light outside = "dashed" (hidden-line circle); otherwise "none".
fn probe_centre(g: &Gray, cx: f64, cy: f64, ppm: f64, r_max_mm: f64) -> Probe {
    let tol = (0.2 * ppm).round().max(1.0) as i64;
    let mut best_dashed: Option<Probe> = None;
    let mut r = 1.0 * ppm;
    let r_max = r_max_mm * ppm;
    while r <= r_max {
        let s = ring_completeness_tol(g, cx, cy, r, tol);
        if s >= 0.5 {
            let li = interior_light(g, cx, cy, r);
            if s >= 0.9 && li >= 0.5 && thick_fraction(g, cx, cy, r, ppm, (1.0f64).max(0.4 * r / ppm)) <= 0.25 {
                let mut cb = None;
                let mut r2 = r * 1.3 + 2.0;
                let r2_max = (r * 3.5).min(40.0 * ppm);
                while r2 <= r2_max {
                    if ring_completeness_tol(g, cx, cy, r2, tol) >= 0.9 {
                        cb = Some(r2);
                        break;
                    }
                    r2 += 0.1 * ppm;
                }
                return Probe { kind: "symbol", ring: s, interior: li, r_px: r, cb_px: cb, cx, cy };
            }
            if li >= 0.5 && interior_light(g, cx, cy, r * 1.9) >= 0.5 && thick_fraction(g, cx, cy, r, ppm, (1.0f64).max(0.4 * r / ppm)) <= 0.25 && best_dashed.as_ref().map_or(true, |p| s > p.ring) {
                best_dashed = Some(Probe { kind: "dashed", ring: s, interior: li, r_px: r, cb_px: None, cx, cy });
            }
        }
        r += 0.05 * ppm;
    }
    // solid dot: a disc of radius 0.6..1.6 mm that is dark throughout (at r and 0.7 r) with
    // paper just outside it (r + 0.5 mm) off-axis, so a crossing of two lines does not count
    let mut r = 0.6 * ppm;
    while r <= 1.6 * ppm {
        if disc_dark(g, cx, cy, r) >= 0.9
            && disc_dark(g, cx, cy, r * 0.7) >= 0.9
            && disc_dark(g, cx, cy, r + 0.5 * ppm) <= 0.25
            && dark_centroid_offset(g, cx, cy, r + 0.5 * ppm) <= 0.2 * ppm
        {
            // grow to the edge of the disc
            let mut edge = r;
            while edge <= 1.8 * ppm && disc_dark(g, cx, cy, edge + 0.05 * ppm) >= 0.9 {
                edge += 0.05 * ppm;
            }
            return Probe { kind: "dot", ring: 1.0, interior: 0.0, r_px: edge, cb_px: None, cx, cy };
        }
        r += 0.1 * ppm;
    }
    best_dashed.unwrap_or(none_probe(cx, cy))
}

/// Radial profile at a point, for debugging: r_mm, off-axis ring (tol 0), ring (tol 0.2 mm), interior light.
fn profile(g: &Gray, cx: f64, cy: f64, ppm: f64, r_max_mm: f64) -> String {
    let tol = (0.2 * ppm).round().max(1.0) as i64;
    let mut rows = Vec::new();
    let mut r = 0.3 * ppm;
    while r <= r_max_mm * ppm {
        rows.push(format!("[{:.2},{:.2},{:.2},{:.2}]", r / ppm, ring_completeness_tol(g, cx, cy, r, 0), ring_completeness_tol(g, cx, cy, r, tol), interior_light(g, cx, cy, r)));
        r += 0.1 * ppm;
    }
    format!("[{}]", rows.join(","))
}

/// Probe at (cx, cy) and at the eight neighbours 1 px away; keep the best.
fn probe_refined(g: &Gray, cx: f64, cy: f64, ppm: f64, r_max_mm: f64) -> Probe {
    let mut best = probe_centre(g, cx, cy, ppm, r_max_mm);
    for dx in [-1.0, 0.0, 1.0] {
        for dy in [-1.0, 0.0, 1.0] {
            if dx == 0.0 && dy == 0.0 {
                continue;
            }
            let p = probe_centre(g, cx + dx, cy + dy, ppm, r_max_mm);
            if rank(&p) > rank(&best) {
                best = p;
            }
        }
    }
    best
}

/// Ink crossings: pixels with a horizontal and a vertical ink run of at least 1.2 mm through
/// them (the centre mark of every hole symbol, and every line crossing of the drawing),
/// clustered by 4-connectivity; returns cluster centroids and sizes.
fn find_crossings(g: &Gray, ppm: f64) -> Vec<(f64, f64, usize)> {
    let (w, h) = (g.w, g.h);
    let dark = |v: u8| v < 150;
    let run = (1.2 * ppm).round().max(4.0) as usize;
    let mut hrun = vec![0u16; w * h];
    for y in 0..h {
        let row = &g.px[y * w..(y + 1) * w];
        let mut x = 0;
        while x < w {
            if dark(row[x]) {
                let start = x;
                while x < w && dark(row[x]) {
                    x += 1;
                }
                let len = (x - start).min(65535) as u16;
                for i in start..x {
                    hrun[y * w + i] = len;
                }
            } else {
                x += 1;
            }
        }
    }
    let mut vrun = vec![0u16; w * h];
    for x in 0..w {
        let mut y = 0;
        while y < h {
            if dark(g.px[y * w + x]) {
                let start = y;
                while y < h && dark(g.px[y * w + x]) {
                    y += 1;
                }
                let len = (y - start).min(65535) as u16;
                for i in start..y {
                    vrun[i * w + x] = len;
                }
            } else {
                y += 1;
            }
        }
    }
    let mut mark = vec![false; w * h];
    for i in 0..w * h {
        mark[i] = hrun[i] as usize >= run && vrun[i] as usize >= run;
    }
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut cands: Vec<(f64, f64, usize)> = Vec::new();
    for s in 0..w * h {
        if !mark[s] || seen[s] {
            continue;
        }
        seen[s] = true;
        stack.clear();
        stack.push(s);
        let (mut sx, mut sy, mut n) = (0usize, 0usize, 0usize);
        while let Some(p) = stack.pop() {
            let (x, y) = (p % w, p / w);
            sx += x;
            sy += y;
            n += 1;
            let mut push = |q: usize| {
                if mark[q] && !seen[q] {
                    seen[q] = true;
                    stack.push(q);
                }
            };
            if x > 0 {
                push(p - 1);
            }
            if x + 1 < w {
                push(p + 1);
            }
            if y > 0 {
                push(p - w);
            }
            if y + 1 < h {
                push(p + w);
            }
        }
        cands.push((sx as f64 / n as f64, sy as f64 / n as f64, n));
    }
    cands
}

/// Probe at the point, then at every ink crossing within `search_mm` (the crosshair of a
/// symbol nearby), then on a 0.25 mm grid; returns the best probe and where it was found.
fn probe_near(g: &Gray, crossings: &[(f64, f64, usize)], cx: f64, cy: f64, ppm: f64, r_max_mm: f64, search_mm: f64) -> Probe {
    let mut best = probe_refined(g, cx, cy, ppm, r_max_mm);
    if best.kind == "symbol" || best.kind == "dot" {
        return best;
    }
    let s_px = search_mm * ppm;
    for (x, y, _) in crossings {
        if (x - cx).abs() <= s_px && (y - cy).abs() <= s_px {
            let p = probe_refined(g, *x, *y, ppm, r_max_mm);
            if rank(&p) > rank(&best) {
                best = p;
            }
        }
    }
    if best.kind == "symbol" || best.kind == "dot" {
        return best;
    }
    let steps = (search_mm / 0.25).round() as i64;
    for dy in -steps..=steps {
        for dx in -steps..=steps {
            let p = probe_centre(g, cx + dx as f64 * 0.25 * ppm, cy + dy as f64 * 0.25 * ppm, ppm, r_max_mm);
            if rank(&p) > rank(&best) {
                best = p;
            }
        }
    }
    best
}

fn ring_score_cmd(pdf: &str, page: u32, cal: &Cal, holes: &[Hole], dpi: u32, search_mm: f64) -> String {
    let g = render(pdf, dpi, page, None);
    let ppm = cal.px_per_mm() * dpi as f64 / cal.dpi as f64;
    let to_px = cal.to_px(dpi, (0.0, 0.0));
    let to_mm = cal.to_mm(dpi, (0.0, 0.0));
    let crossings = find_crossings(&g, ppm);
    let mut items = Vec::new();
    let mut off = 0;
    for h in holes {
        let (px, py) = to_px(h.x, h.y);
        let p = probe_near(&g, &crossings, px, py, ppm, (h.d * 0.9).max(3.0).min(32.0), search_mm);
        let on = p.kind != "none";
        if !on {
            off += 1;
        }
        let (fx, fy) = to_mm(p.cx, p.cy);
        let offset = ((fx - h.x).powi(2) + (fy - h.y).powi(2)).sqrt();
        items.push(format!(
            "{{\"x\":{},\"y\":{},\"diameter\":{},\"drawn\":\"{}\",\"drawn_at\":[{:.1},{:.1}],\"offset_mm\":{:.1},\"ring\":{:.2},\"interior_light\":{:.2},\"drawn_diameter_mm\":{:.1},\"drawn_counterbore_mm\":{}}}",
            h.x, h.y, h.d, p.kind, fx, fy, offset, p.ring, p.interior, 2.0 * p.r_px / ppm, p.cb_px.map_or("null".to_string(), |v| format!("{:.1}", 2.0 * v / ppm))
        ));
    }
    format!("{{\"ok\":true,\"dpi\":{},\"holes\":{},\"nothing_drawn_within_search\":{},\"search_mm\":{},\"legend\":\"drawn: symbol = circle with a light interior (drawn_at is its centre, offset_mm from the model hole), dot = solid dot, dashed = partial ring such as a hidden-line circle, none = nothing round within search_mm\",\"items\":[{}]}}", dpi, holes.len(), off, search_mm, items.join(","))
}

// ----------------------------------------------------------------------------- png output

fn write_png(path: &str, w: usize, h: usize, rgb: &[u8]) {
    let file = fs::File::create(path).unwrap_or_else(|_| panic!("cannot write {path}"));
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().unwrap();
    writer.write_image_data(rgb).unwrap();
}

struct Canvas {
    w: usize,
    h: usize,
    rgb: Vec<u8>,
}

impl Canvas {
    fn from_gray(g: &Gray) -> Canvas {
        let mut rgb = Vec::with_capacity(g.w * g.h * 3);
        for v in &g.px {
            rgb.extend_from_slice(&[*v, *v, *v]);
        }
        Canvas { w: g.w, h: g.h, rgb }
    }
    fn put(&mut self, x: i64, y: i64, c: [u8; 3]) {
        if x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h {
            let o = (y as usize * self.w + x as usize) * 3;
            self.rgb[o..o + 3].copy_from_slice(&c);
        }
    }
    fn circle(&mut self, cx: f64, cy: f64, r: f64, c: [u8; 3], thick: usize) {
        let steps = ((std::f64::consts::TAU * r) as usize).max(24);
        for k in 0..steps {
            let a = k as f64 * std::f64::consts::TAU / steps as f64;
            for t in 0..thick {
                let rr = r + t as f64;
                self.put((cx + rr * a.cos()).round() as i64, (cy + rr * a.sin()).round() as i64, c);
            }
        }
    }
    fn cross(&mut self, cx: f64, cy: f64, s: i64, c: [u8; 3]) {
        for d in -s..=s {
            self.put(cx.round() as i64 + d, cy.round() as i64, c);
            self.put(cx.round() as i64, cy.round() as i64 + d, c);
        }
    }
    fn line(&mut self, a: (f64, f64), b: (f64, f64), c: [u8; 3]) {
        let n = ((b.0 - a.0).abs().max((b.1 - a.1).abs()) as usize).max(1);
        for i in 0..=n {
            let t = i as f64 / n as f64;
            self.put((a.0 + (b.0 - a.0) * t).round() as i64, (a.1 + (b.1 - a.1) * t).round() as i64, c);
        }
    }
}

const RED: [u8; 3] = [230, 0, 0];
const BLUE: [u8; 3] = [0, 0, 230];
const GREEN: [u8; 3] = [0, 160, 0];
const MAGENTA: [u8; 3] = [200, 0, 200];
const ORANGE: [u8; 3] = [230, 120, 0];

/// Pixel bounds of a millimetre region at `dpi`.
fn region_px(cal: &Cal, dpi: u32, region: (f64, f64, f64, f64)) -> (i64, i64, i64, i64) {
    let m = cal.to_px(dpi, (0.0, 0.0));
    let pts = [m(region.0, region.1), m(region.2, region.1), m(region.0, region.3), m(region.2, region.3)];
    let x0 = pts.iter().map(|p| p.0).fold(f64::MAX, f64::min).floor() as i64;
    let x1 = pts.iter().map(|p| p.0).fold(f64::MIN, f64::max).ceil() as i64;
    let y0 = pts.iter().map(|p| p.1).fold(f64::MAX, f64::min).floor() as i64;
    let y1 = pts.iter().map(|p| p.1).fold(f64::MIN, f64::max).ceil() as i64;
    (x0, y0, x1 - x0, y1 - y0)
}

fn draw_holes(cv: &mut Canvas, to_px: &dyn Fn(f64, f64) -> (f64, f64), holes: &[Hole], ppm: f64, color: [u8; 3]) {
    let thick = (ppm as usize).max(2);
    for h in holes {
        let (px, py) = to_px(h.x, h.y);
        cv.circle(px, py, (h.d / 2.0 * ppm).max(3.0), color, thick);
        cv.cross(px, py, (6.0 * (ppm / 2.0).max(1.0)) as i64, color);
        if let Some(cb) = h.cb {
            cv.circle(px, py, cb / 2.0 * ppm, BLUE, thick);
        }
    }
}

fn draw_grid(cv: &mut Canvas, to_px: &dyn Fn(f64, f64) -> (f64, f64), region: (f64, f64, f64, f64), step: f64, ppm: f64) {
    // ticks along the four borders of the region every `step` mm (long tick every 5 steps), plus faint lines
    let (x0, y0, x1, y1) = region;
    let mut x = (x0 / step).ceil() * step;
    while x <= x1 {
        let long = ((x / step).round() as i64) % 5 == 0;
        let len = if long { 4.0 * ppm } else { 2.0 * ppm };
        let (ax, ay) = to_px(x, y0);
        let (bx, by) = to_px(x, y1);
        if long {
            cv.line((ax, ay), (bx, by), [200, 220, 255]);
        }
        cv.line((ax, ay), (ax, ay - len), GREEN);
        cv.line((bx, by), (bx, by + len), GREEN);
        x += step;
    }
    let mut y = (y0 / step).ceil() * step;
    while y <= y1 {
        let long = ((y / step).round() as i64) % 5 == 0;
        let len = if long { 4.0 * ppm } else { 2.0 * ppm };
        let (ax, ay) = to_px(x0, y);
        let (bx, by) = to_px(x1, y);
        if long {
            cv.line((ax, ay), (bx, by), [200, 220, 255]);
        }
        cv.line((ax, ay), (ax + len, ay), GREEN);
        cv.line((bx, by), (bx - len, by), GREEN);
        y += step;
    }
}

fn crop_cmd(pdf: &str, page: u32, cal: &Cal, region: (f64, f64, f64, f64), dpi: u32, out: &str, holes: &[Hole], grid: f64) -> String {
    let (cx, cy, cw, ch) = region_px(cal, dpi, region);
    let g = render(pdf, dpi, page, Some((cx, cy, cw, ch)));
    let mut cv = Canvas::from_gray(&g);
    let to_px = cal.to_px(dpi, (cx as f64, cy as f64));
    let ppm = cal.px_per_mm() * dpi as f64 / cal.dpi as f64;
    if grid > 0.0 {
        draw_grid(&mut cv, &to_px, region, grid, ppm);
    }
    draw_holes(&mut cv, &to_px, holes, ppm, RED);
    write_png(out, cv.w, cv.h, &cv.rgb);
    format!(
        "{{\"ok\":true,\"png\":\"{}\",\"size\":[{},{}],\"dpi\":{},\"px_per_mm\":{:.3},\"region_mm\":[{},{},{},{}],\"holes_drawn\":{},\"grid_mm\":{},\"legend\":\"red = model hole, blue = counterbore, green ticks every grid mm from the region corner (long tick and faint line every 5 ticks)\"}}",
        out, cv.w, cv.h, dpi, ppm, region.0, region.1, region.2, region.3, holes.len(), grid
    )
}

// ----------------------------------------------------------------------------- symbol detection

#[derive(Clone, Debug)]
struct Symbol {
    x: f64,
    y: f64,
    d: f64,
    cb: Option<f64>,
    px: (f64, f64),
    parts: usize,
    kind: &'static str,
    ring_score: f64,
}

/// Every ink crossing whose surroundings are light off-axis is probed for a drawn circle.
fn detect_symbols(g: &Gray, ppm: f64, to_mm: &dyn Fn(f64, f64) -> (f64, f64)) -> Vec<Symbol> {
    let cands = find_crossings(g, ppm);
    let mut out: Vec<Symbol> = Vec::new();
    for (cx, cy, n) in cands {
        // prefilter: a symbol centre has paper around it off-axis at 1.5 mm, or is a solid dot
        let near_light = interior_light(g, cx, cy, 3.0 * ppm);
        if near_light < 0.4 && interior_light(g, cx, cy, 0.6 * ppm) > 0.3 {
            continue;
        }
        let p = probe_refined(g, cx, cy, ppm, 32.0);
        if p.kind != "symbol" && p.kind != "dot" && !(p.kind == "dashed" && p.ring >= 0.6) {
            continue;
        }
        let (mx, my) = to_mm(p.cx, p.cy);
        if let Some(o) = out.iter_mut().find(|o| ((o.x - mx).powi(2) + (o.y - my).powi(2)).sqrt() < 1.0) {
            if rank_kind(p.kind, p.ring) > rank_kind(o.kind, o.ring_score) {
                o.x = mx;
                o.y = my;
                o.d = 2.0 * p.r_px / ppm;
                o.cb = p.cb_px.map(|v| 2.0 * v / ppm);
                o.px = (p.cx, p.cy);
                o.kind = p.kind;
                o.ring_score = p.ring;
            }
            continue;
        }
        out.push(Symbol { x: mx, y: my, d: 2.0 * p.r_px / ppm, cb: p.cb_px.map(|v| 2.0 * v / ppm), px: (p.cx, p.cy), parts: n, kind: p.kind, ring_score: p.ring });
    }
    out.sort_by(|a, b| (a.y, a.x).partial_cmp(&(b.y, b.x)).unwrap());
    out
}

fn rank_kind(kind: &str, ring: f64) -> f64 {
    match kind {
        "symbol" => 3.0 + ring,
        "dot" => 2.0 + ring,
        "dashed" => 1.0 + ring,
        _ => 0.0,
    }
}

fn symbols_cmd(pdf: &str, page: u32, cal: &Cal, region: Option<(f64, f64, f64, f64)>, dpi: u32, holes: &[Hole], out: Option<&str>) -> String {
    let region = region.unwrap_or((0.0, 0.0, cal.length, cal.width));
    let (cx, cy, cw, ch) = region_px(cal, dpi, region);
    let g = render(pdf, dpi, page, Some((cx, cy, cw, ch)));
    let ppm = cal.px_per_mm() * dpi as f64 / cal.dpi as f64;
    let to_mm = cal.to_mm(dpi, (cx as f64, cy as f64));
    let to_px = cal.to_px(dpi, (cx as f64, cy as f64));
    let t = Instant::now();
    let all: Vec<Symbol> = detect_symbols(&g, ppm, &to_mm)
        .into_iter()
        .filter(|s| s.x > -2.0 && s.x < cal.length + 2.0 && s.y > -2.0 && s.y < cal.width + 2.0)
        .collect();
    let dashed: Vec<&Symbol> = all.iter().filter(|s| s.kind == "dashed").collect();
    let dashed_json: Vec<String> = dashed.iter().map(|s| format!("{{\"x\":{:.1},\"y\":{:.1},\"diameter\":{:.1}}}", s.x, s.y, s.d)).collect();
    let syms: Vec<Symbol> = all.iter().filter(|s| s.kind != "dashed").cloned().collect();
    let detect_ms = t.elapsed().as_millis();
    // matching
    let mut matched: Vec<(usize, usize, f64)> = Vec::new();
    let mut used = vec![false; syms.len()];
    let mut model_only: Vec<usize> = Vec::new();
    for (hi, h) in holes.iter().enumerate() {
        if h.x < region.0 || h.x > region.2 || h.y < region.1 || h.y > region.3 {
            continue;
        }
        let mut best: Option<(f64, usize)> = None;
        for (si, s) in syms.iter().enumerate() {
            if used[si] {
                continue;
            }
            let dist = ((h.x - s.x).powi(2) + (h.y - s.y).powi(2)).sqrt();
            if dist <= 2.5 && best.map_or(true, |b| dist < b.0) {
                best = Some((dist, si));
            }
        }
        match best {
            Some((d, si)) => {
                used[si] = true;
                matched.push((hi, si, d));
            }
            None => model_only.push(hi),
        }
    }
    let print_only: Vec<usize> = (0..syms.len()).filter(|i| !used[*i]).collect();
    if let Some(path) = out {
        let mut cv = Canvas::from_gray(&g);
        for (hi, _, _) in &matched {
            let h = &holes[*hi];
            let (px, py) = to_px(h.x, h.y);
            cv.circle(px, py, (h.d / 2.0 * ppm).max(3.0), GREEN, (ppm as usize).max(2));
        }
        for hi in &model_only {
            let h = &holes[*hi];
            let (px, py) = to_px(h.x, h.y);
            cv.circle(px, py, (h.d / 2.0 * ppm).max(4.0) + 2.0, RED, (ppm as usize).max(3));
            cv.cross(px, py, (8.0 * ppm / 2.0) as i64, RED);
        }
        for si in &print_only {
            let s = &syms[*si];
            cv.circle(s.px.0, s.px.1, s.d / 2.0 * ppm + 4.0, MAGENTA, (ppm as usize).max(3));
        }
        if holes.is_empty() {
            for s in &syms {
                cv.circle(s.px.0, s.px.1, s.d / 2.0 * ppm + 3.0, ORANGE, (ppm as usize).max(2));
            }
        }
        write_png(path, cv.w, cv.h, &cv.rgb);
    }
    let sym_json: Vec<String> = syms
        .iter()
        .map(|s| format!("{{\"x\":{:.1},\"y\":{:.1},\"diameter\":{:.1},\"counterbore\":{},\"drawn\":\"{}\"}}", s.x, s.y, s.d, s.cb.map_or("null".to_string(), |v| format!("{v:.1}")), s.kind))
        .collect();
    let mo: Vec<String> = model_only.iter().map(|hi| format!("{{\"x\":{},\"y\":{},\"diameter\":{}}}", holes[*hi].x, holes[*hi].y, holes[*hi].d)).collect();
    let po: Vec<String> = print_only.iter().map(|si| format!("{{\"x\":{:.1},\"y\":{:.1},\"diameter\":{:.1}}}", syms[*si].x, syms[*si].y, syms[*si].d)).collect();
    let far: Vec<String> = matched.iter().filter(|m| m.2 > 1.0).map(|m| format!("{{\"model\":[{},{}],\"drawn\":[{:.1},{:.1}],\"offset_mm\":{:.1}}}", holes[m.0].x, holes[m.0].y, syms[m.1].x, syms[m.1].y, m.2)).collect();
    format!(
        "{{\"ok\":true,\"dpi\":{},\"region_mm\":[{},{},{},{}],\"detect_ms\":{},\"note\":\"symbols are circles or solid dots found at ink crossings; text, arrowheads and concentric rings can still slip through, so treat print_only entries as places to look at, never as positions to model from\",\"symbols_found\":{},\"symbols\":[{}],\"partial_rings\":[{}],\"model_holes_in_region\":{},\"matched\":{},\"model_only\":[{}],\"print_only\":[{}],\"matched_offset_over_1mm\":[{}]{}}}",
        dpi, region.0, region.1, region.2, region.3, detect_ms, syms.len(), sym_json.join(","), dashed_json.join(","),
        matched.len() + model_only.len(), matched.len(), mo.join(","), po.join(","), far.join(","),
        out.map_or(String::new(), |p| format!(",\"png\":\"{p}\",\"legend\":\"green = model hole on a drawn symbol, red = model hole with no symbol, magenta = drawn symbol with no model hole, orange = symbol (no model given)\""))
    )
}

// ----------------------------------------------------------------------------- cli

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn parse_region(s: &str) -> (f64, f64, f64, f64) {
    let v: Vec<f64> = s.split(',').map(|t| t.trim().parse().expect("region numbers")).collect();
    assert_eq!(v.len(), 4, "--region x0,y0,x1,y1");
    (v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3]))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: print-probe <calibrate|crop|ring-score|symbols> --pdf P --length L --width W [...]");
        std::process::exit(2);
    }
    let t0 = Instant::now();
    let cmd = args[1].as_str();
    let pdf = arg(&args, "--pdf").expect("--pdf");
    let page: u32 = arg(&args, "--page").map(|v| v.parse().unwrap()).unwrap_or(1);
    let length: f64 = arg(&args, "--length").expect("--length").parse().unwrap();
    let width: f64 = arg(&args, "--width").expect("--width").parse().unwrap();
    let cal = calibrate(&pdf, page, length, width);
    let holes = arg(&args, "--holes").map(|p| read_holes(&p)).unwrap_or_default();
    let output = match cmd {
        "calibrate" => format!("{{\"ok\":true,\"calibration\":{}}}", cal.json()),
        "crop" => {
            let region = parse_region(&arg(&args, "--region").expect("--region"));
            let dpi: u32 = arg(&args, "--dpi").map(|v| v.parse().unwrap()).unwrap_or(400);
            let out = arg(&args, "--out").expect("--out");
            let grid: f64 = arg(&args, "--grid").map(|v| v.parse().unwrap()).unwrap_or(0.0);
            crop_cmd(&pdf, page, &cal, region, dpi, &out, &holes, grid)
        }
        "ring-score" => {
            let dpi: u32 = arg(&args, "--dpi").map(|v| v.parse().unwrap()).unwrap_or(600);
            let search: f64 = arg(&args, "--search").map(|v| v.parse().unwrap()).unwrap_or(2.5);
            ring_score_cmd(&pdf, page, &cal, &holes, dpi, search)
        }
        "probe" => {
            let dpi: u32 = arg(&args, "--dpi").map(|v| v.parse().unwrap()).unwrap_or(600);
            let at: Vec<f64> = arg(&args, "--at").expect("--at x,y").split(',').map(|t| t.trim().parse().expect("--at x,y")).collect();
            let (x, y) = (at[0], at[1]);
            let g = render(&pdf, dpi, page, None);
            let ppm = cal.px_per_mm() * dpi as f64 / cal.dpi as f64;
            let (px, py) = cal.to_px(dpi, (0.0, 0.0))(x, y);
            let p = probe_refined(&g, px, py, ppm, 32.0);
            let thick = if p.r_px > 0.0 { thick_fraction(&g, p.cx, p.cy, p.r_px, ppm, (1.0f64).max(0.4 * p.r_px / ppm)) } else { 0.0 };
            format!("{{\"ok\":true,\"at\":[{},{}],\"px\":[{:.1},{:.1}],\"drawn\":\"{}\",\"ring\":{:.2},\"interior\":{:.2},\"thick\":{:.2},\"drawn_diameter_mm\":{:.1},\"profile_r_ring0_ring_tol_interior\":{}}}", x, y, px, py, p.kind, p.ring, p.interior, thick, 2.0 * p.r_px / ppm, profile(&g, px, py, ppm, 6.0))
        }
        "symbols" => {
            let region = arg(&args, "--region").map(|r| parse_region(&r));
            let dpi: u32 = arg(&args, "--dpi").map(|v| v.parse().unwrap()).unwrap_or(400);
            let out = arg(&args, "--out");
            symbols_cmd(&pdf, page, &cal, region, dpi, &holes, out.as_deref())
        }
        other => {
            eprintln!("unknown subcommand {other}");
            std::process::exit(2);
        }
    };
    let mut o = output;
    o.insert_str(o.len() - 1, &format!(",\"elapsed_ms\":{}", t0.elapsed().as_millis()));
    let mut stdout = std::io::stdout();
    stdout.write_all(o.as_bytes()).unwrap();
    stdout.write_all(b"\n").unwrap();
}
