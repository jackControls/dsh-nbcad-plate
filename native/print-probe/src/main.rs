//! print-probe: pixel tools for plate prints, built for the nbcad-plate workflow.
//!
//! The print is a PDF (rendered here, no external tools), a PNG or a JPG. The page
//! commands work on the sheet; the plate commands take the plate size and work in plate
//! millimetres (origin at the lower-left corner of the plan view, y up):
//!
//!   print-probe info       --print P
//!   print-probe render     --print P --out o.png [--dpi 150] [--window fx0,fy0,fx1,fy1] [--page 1]
//!   print-probe calibrate  --print P --length L --width W
//!   print-probe crop       --print P --length L --width W --region x0,y0,x1,y1 --out o.png [--dpi 400] [--holes h.json] [--grid 10]
//!   print-probe ring-score --print P --length L --width W --holes h.json [--dpi 600] [--search 2.5]
//!   print-probe symbols    --print P --length L --width W [--region x0,y0,x1,y1] [--dpi 300] [--holes h.json] [--out o.png]
//!
//! Page renders are cached per (file, dpi, page) under $PRINT_PROBE_CACHE or the temp dir.
//! Every result is one JSON line on stdout; a failure is `{"ok":false,"error":...}`.
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{RenderCache, RenderSettings};

/// Raster prints (PNG, JPG) carry no reliable scale; their native pixels count as this dpi.
const RASTER_NATIVE_DPI: f64 = 300.0;
/// Largest page render accepted (per side, px): keeps memory bounded on huge sheets at high dpi.
const MAX_PAGE_PX: f64 = 30000.0;
/// Largest PNG the `render` command writes (per side, px): bigger images only cost tokens to view.
const MAX_RENDER_PX: usize = 4096;

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Report a failure as the JSON line the host expects and exit.
fn fail(message: &str) -> ! {
    println!("{{\"ok\":false,\"error\":{}}}", json_string(message));
    std::process::exit(1)
}

fn is_pdf(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".pdf")
}

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

fn gray_from_rgba(w: usize, h: usize, rgba: &[u8]) -> Gray {
    let mut px = vec![255u8; w * h];
    for (i, c) in rgba.chunks_exact(4).enumerate().take(w * h) {
        px[i] = ((c[0] as u32 * 299 + c[1] as u32 * 587 + c[2] as u32 * 114) / 1000) as u8;
    }
    Gray { w, h, px }
}

/// Render one PDF page at `dpi` with hayro (pure Rust; JPEG, CCITT, JBIG2 and JPX scans decode).
fn render_pdf_page(path: &str, dpi: u32, page: u32) -> Gray {
    let data = fs::read(path).unwrap_or_else(|e| fail(&format!("cannot read {path}: {e}")));
    let pdf = Pdf::new(data).unwrap_or_else(|e| fail(&format!("cannot open {path} as a PDF: {e:?}")));
    let pages = pdf.pages();
    let count = pages.len();
    let index = page.max(1) as usize - 1;
    let p = pages.get(index).unwrap_or_else(|| fail(&format!("page {page} does not exist: the file has {count} page(s)")));
    let scale = dpi as f32 / 72.0;
    let (w, h) = p.render_dimensions();
    if (w * scale) as f64 > MAX_PAGE_PX || (h * scale) as f64 > MAX_PAGE_PX {
        fail(&format!("page {page} is {:.0} x {:.0} px at {dpi} dpi, above the {MAX_PAGE_PX} px limit; use a lower dpi", w * scale, h * scale));
    }
    let settings = RenderSettings { x_scale: scale, y_scale: scale, bg_color: WHITE, ..Default::default() };
    let pixmap = hayro::render(p, &RenderCache::new(), &InterpreterSettings::default(), &settings);
    let (pw, ph) = (pixmap.width() as usize, pixmap.height() as usize);
    gray_from_rgba(pw, ph, pixmap.data_as_u8_slice())
}

/// Area-average (shrinking) or bilinear (enlarging) resample.
fn resample(g: &Gray, scale: f64) -> Gray {
    let w = ((g.w as f64) * scale).round().max(1.0) as usize;
    let h = ((g.h as f64) * scale).round().max(1.0) as usize;
    let mut px = vec![255u8; w * h];
    if scale < 1.0 {
        let inv = 1.0 / scale;
        for y in 0..h {
            let (sy0, sy1) = ((y as f64 * inv).floor() as usize, (((y + 1) as f64 * inv).ceil() as usize).min(g.h).max((y as f64 * inv).floor() as usize + 1));
            for x in 0..w {
                let (sx0, sx1) = ((x as f64 * inv).floor() as usize, (((x + 1) as f64 * inv).ceil() as usize).min(g.w).max((x as f64 * inv).floor() as usize + 1));
                let mut sum = 0u64;
                let mut n = 0u64;
                for sy in sy0..sy1 {
                    for sx in sx0..sx1 {
                        sum += g.px[sy * g.w + sx] as u64;
                        n += 1;
                    }
                }
                px[y * w + x] = if n > 0 { (sum / n) as u8 } else { 255 };
            }
        }
    } else {
        for y in 0..h {
            let fy = (y as f64 + 0.5) / scale - 0.5;
            let y0 = fy.floor().max(0.0) as i64;
            let ty = (fy - y0 as f64).clamp(0.0, 1.0);
            for x in 0..w {
                let fx = (x as f64 + 0.5) / scale - 0.5;
                let x0 = fx.floor().max(0.0) as i64;
                let tx = (fx - x0 as f64).clamp(0.0, 1.0);
                let a = g.at(x0, y0) as f64;
                let b = g.at(x0 + 1, y0) as f64;
                let c = g.at(x0, y0 + 1) as f64;
                let d = g.at(x0 + 1, y0 + 1) as f64;
                let v = a * (1.0 - tx) * (1.0 - ty) + b * tx * (1.0 - ty) + c * (1.0 - tx) * ty + d * tx * ty;
                px[y * w + x] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Gray { w, h, px }
}

/// Decode a PNG or JPG print; its native pixels count as RASTER_NATIVE_DPI.
fn render_raster(path: &str, dpi: u32) -> Gray {
    let img = image::open(path).unwrap_or_else(|e| fail(&format!("cannot decode {path}: {e}"))).to_luma8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let base = Gray { w, h, px: img.into_raw() };
    let scale = dpi as f64 / RASTER_NATIVE_DPI;
    if (scale - 1.0).abs() < 1e-9 {
        base
    } else {
        if (base.w as f64 * scale) > MAX_PAGE_PX || (base.h as f64 * scale) > MAX_PAGE_PX {
            fail(&format!("image is {:.0} x {:.0} px at {dpi} dpi, above the {MAX_PAGE_PX} px limit; use a lower dpi", base.w as f64 * scale, base.h as f64 * scale));
        }
        resample(&base, scale)
    }
}

/// Render one whole page (PDF page or raster image) to grayscale at `dpi`, cached on disk.
fn render_page(print: &str, dpi: u32, page: u32) -> Gray {
    let meta = fs::metadata(print).unwrap_or_else(|e| fail(&format!("cannot read {print}: {e}")));
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let key = format!(
        "{}-{}-{}-{}-{}",
        PathBuf::from(print).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        meta.len(),
        stamp,
        dpi,
        page
    )
    .replace(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '_', "_");
    let path = cache_dir().join(format!("{key}.pgm"));
    if let Ok(data) = fs::read(&path) {
        if data.len() > 16 {
            return parse_pgm(&data);
        }
    }
    let g = if is_pdf(print) { render_pdf_page(print, dpi, page) } else { render_raster(print, dpi) };
    let tmp = cache_dir().join(format!("{key}.{}.tmp", std::process::id()));
    let mut data = format!("P5\n{} {}\n255\n", g.w, g.h).into_bytes();
    data.extend_from_slice(&g.px);
    if fs::write(&tmp, &data).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
    g
}

/// A pixel window of the page (white outside the page), the same for every command.
fn crop_gray(g: &Gray, x: i64, y: i64, w: i64, h: i64) -> Gray {
    let (w, h) = (w.max(1) as usize, h.max(1) as usize);
    let mut px = vec![255u8; w * h];
    for j in 0..h {
        for i in 0..w {
            px[j * w + i] = g.at(x + i as i64, y + j as i64);
        }
    }
    Gray { w, h, px }
}

/// Render one page (or a pixel crop of it) to grayscale, cached.
fn render(print: &str, dpi: u32, page: u32, crop: Option<(i64, i64, i64, i64)>) -> Gray {
    let g = render_page(print, dpi, page);
    match crop {
        None => g,
        Some((x, y, w, h)) => crop_gray(&g, x, y, w, h),
    }
}

fn write_png_gray(path: &str, w: usize, h: usize, px: &[u8]) {
    let file = fs::File::create(path).unwrap_or_else(|e| fail(&format!("cannot write {path}: {e}")));
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap_or_else(|e| fail(&format!("cannot write {path}: {e}")));
    writer.write_image_data(px).unwrap_or_else(|e| fail(&format!("cannot write {path}: {e}")));
}

/// `info`: what the file is, how many pages, how big.
fn info_cmd(print: &str) -> String {
    if is_pdf(print) {
        let data = fs::read(print).unwrap_or_else(|e| fail(&format!("cannot read {print}: {e}")));
        let pdf = Pdf::new(data).unwrap_or_else(|e| fail(&format!("cannot open {print} as a PDF: {e:?}")));
        let pages = pdf.pages();
        let sizes: Vec<String> = pages.iter().map(|p| { let (w, h) = p.render_dimensions(); format!("[{:.1},{:.1}]", w as f64 / 72.0 * 25.4, h as f64 / 72.0 * 25.4) }).collect();
        format!("{{\"ok\":true,\"kind\":\"pdf\",\"pages\":{},\"page_size_mm\":[{}],\"note\":\"render a page with action render; window is given as page fractions from the top-left corner\"}}", pages.len(), sizes.join(","))
    } else {
        let (w, h) = image::image_dimensions(print).unwrap_or_else(|e| fail(&format!("cannot read {print}: {e}")));
        format!("{{\"ok\":true,\"kind\":\"image\",\"pages\":1,\"size_px\":[{w},{h}],\"assumed_dpi\":{RASTER_NATIVE_DPI},\"page_size_mm\":[[{:.1},{:.1}]]}}", w as f64 / RASTER_NATIVE_DPI * 25.4, h as f64 / RASTER_NATIVE_DPI * 25.4)
    }
}

/// `render`: a PNG of the page or of a window given as page fractions (top-left origin).
fn render_cmd(print: &str, page: u32, dpi: u32, window: Option<(f64, f64, f64, f64)>, out: &str) -> String {
    let g = render_page(print, dpi, page);
    let (fx0, fy0, fx1, fy1) = window.unwrap_or((0.0, 0.0, 1.0, 1.0));
    let x0 = (fx0.clamp(0.0, 1.0) * g.w as f64).floor() as i64;
    let y0 = (fy0.clamp(0.0, 1.0) * g.h as f64).floor() as i64;
    let x1 = (fx1.clamp(0.0, 1.0) * g.w as f64).ceil() as i64;
    let y1 = (fy1.clamp(0.0, 1.0) * g.h as f64).ceil() as i64;
    let (w, h) = ((x1 - x0).max(1), (y1 - y0).max(1));
    if w as usize > MAX_RENDER_PX || h as usize > MAX_RENDER_PX {
        fail(&format!("the window is {w} x {h} px at {dpi} dpi, above the {MAX_RENDER_PX} px limit for one image; lower the dpi or narrow the window"));
    }
    let c = crop_gray(&g, x0, y0, w, h);
    write_png_gray(out, c.w, c.h, &c.px);
    format!(
        "{{\"ok\":true,\"png\":{},\"size\":[{},{}],\"dpi\":{},\"page_size_px\":[{},{}],\"window\":[{},{},{},{}],\"origin_px\":[{},{}],\"note\":\"a page fraction f maps to pixel f * page_size_px; zoom with a narrower window at a higher dpi\"}}",
        json_string(out), c.w, c.h, dpi, g.w, g.h, fx0, fy0, fx1, fy1, x0, y0
    )
}

// ----------------------------------------------------------------------------- calibration

const CAL_DPI: u32 = 300;

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

/// Fraction of the pixels along a horizontal (or vertical) segment that are dark within +-2 px.
fn side_support(g: &Gray, fixed: usize, from: usize, to: usize, horizontal: bool) -> f64 {
    let (lo, hi) = (from.min(to), from.max(to));
    side_support_band(g, fixed, lo, hi, horizontal, 2 + ((hi - lo) as f64 * 0.009) as i64)
}

/// Same, with an explicit +-band in px (a scan can be rotated by half a degree, so a short
/// segment of a long side needs the long side's band).
fn side_support_band(g: &Gray, fixed: usize, lo: usize, hi: usize, horizontal: bool, band: i64) -> f64 {
    if hi <= lo {
        return 0.0;
    }
    let mut dark = 0;
    for t in lo..=hi {
        let mut hit = false;
        for d in -band..=band {
            let (x, y) = if horizontal { (t as i64, fixed as i64 + d) } else { (fixed as i64 + d, t as i64) };
            if g.at(x, y) < 110 {
                hit = true;
                break;
            }
        }
        if hit {
            dark += 1;
        }
    }
    dark as f64 / (hi - lo + 1) as f64
}

/// Median stroke width (px) of a horizontal or vertical line at `fixed`, sampled along lo..hi
/// every 8 px: the perpendicular dark run through the nearest dark pixel within +-band.
fn stroke_width(g: &Gray, fixed: usize, lo: usize, hi: usize, horizontal: bool, band: i64) -> f64 {
    let mut widths: Vec<i64> = Vec::new();
    let mut t = lo;
    while t <= hi {
        let mut found: Option<i64> = None;
        for d in -band..=band {
            let (x, y) = if horizontal { (t as i64, fixed as i64 + d) } else { (fixed as i64 + d, t as i64) };
            if g.at(x, y) < 110 {
                found = Some(fixed as i64 + d);
                break;
            }
        }
        if let Some(c) = found {
            let (mut a, mut b) = (c, c);
            let px = |p: i64| if horizontal { g.at(t as i64, p) } else { g.at(p, t as i64) };
            while px(a - 1) < 110 && c - a < 40 {
                a -= 1;
            }
            while px(b + 1) < 110 && b - c < 40 {
                b += 1;
            }
            widths.push(b - a + 1);
        }
        t += 8;
    }
    if widths.is_empty() {
        return 0.0;
    }
    widths.sort();
    widths[widths.len() / 2] as f64
}

/// Support of a side measured with a small band, so only a candidate row/column that really
/// sits on the line scores; for long sides the band grows a little with skew.
fn tight_support(g: &Gray, fixed: usize, lo: usize, hi: usize, horizontal: bool) -> f64 {
    side_support_band(g, fixed, lo, hi, horizontal, 3 + ((hi - lo) as f64 * 0.003) as i64)
}

/// Find the plate outline on the sheet.
/// Candidate lines are the strongest vertical and horizontal ink lines away from the page
/// border (the drawing frame). A candidate rectangle pairs two of each with the span ratio
/// width/length within 3 %; its vertical sides must be drawn over their length and its
/// horizontal sides at least at the ends (a notched outline still has those), and its strokes
/// must have visible-line weight (about 4 px at 300 dpi; dimension lines and table rules are
/// about 2.5 px). Rectangles in the title-block corner (bottom right) are skipped. Among the
/// survivors the strongest lines win, which is the main view.
fn calibrate(pdf: &str, page: u32, length: f64, width: f64) -> Cal {
    let g = render(pdf, CAL_DPI, page, None);
    let (rows, cols) = dark_counts(&g, 0, g.w, 0, g.h, 110);
    let (mx, my) = ((g.w as f64 * 0.06) as usize, (g.h as f64 * 0.06) as usize);
    let xc = peaks(&cols, mx, g.w - mx, 48, 6);
    let yc = peaks(&rows, my, g.h - my, 48, 6);
    let target = width / length;
    let debug = std::env::var("PROBE_DEBUG").is_ok();
    let expect: Option<Vec<usize>> = std::env::var("PROBE_EXPECT").ok().map(|e| e.split(',').map(|t| t.trim().parse().unwrap()).collect());
    let hint: Option<(f64, f64, f64, f64)> = std::env::var("PROBE_HINT").ok().map(|h| {
        let v: Vec<f64> = h.split(',').map(|t| t.trim().parse().unwrap()).collect();
        (v[0], v[1], v[2], v[3])
    });
    // (strength, span, x0, x1, y0, y1, thinnest, median width)
    let mut cands: Vec<(f64, f64, usize, usize, usize, usize, f64, f64)> = Vec::new();
    for i in 0..xc.len() {
        for j in i + 1..xc.len() {
            let (x0, x1) = (xc[i], xc[j]);
            let span_x = (x1 - x0) as f64;
            if span_x < g.w as f64 * 0.06 {
                continue;
            }
            let want = span_x * target;
            for k in 0..yc.len() {
                let y0 = yc[k];
                for l in k + 1..yc.len() {
                    let y1 = yc[l];
                    let span_y = (y1 - y0) as f64;
                    if span_y < want * 0.97 {
                        continue;
                    }
                    if span_y > want * 1.03 {
                        break;
                    }
                    let dbg = expect.as_ref().map_or(false, |v| (v[0] as i64 - x0 as i64).abs() <= 6 && (v[1] as i64 - x1 as i64).abs() <= 6 && (v[2] as i64 - y0 as i64).abs() <= 6 && (v[3] as i64 - y1 as i64).abs() <= 6);
                    if let Some((hx0, hy0, hx1, hy1)) = hint {
                        let (fx0, fx1, fy0, fy1) = (x0 as f64 / g.w as f64, x1 as f64 / g.w as f64, y0 as f64 / g.h as f64, y1 as f64 / g.h as f64);
                        if fx0 < hx0 - 0.02 || fx1 > hx1 + 0.02 || fy0 < hy0 - 0.02 || fy1 > hy1 + 0.02 {
                            if dbg { eprintln!("  expected: outside hint"); }
                            continue;
                        }
                    } else {
                        // title block: a shallow rectangle in the bottom band of the sheet
                        let (fy1, fh) = (y1 as f64 / g.h as f64, (y1 - y0) as f64 / g.h as f64);
                        if fy1 > 0.80 && fh < 0.15 {
                            if dbg { eprintln!("  expected: in the title-block band"); }
                            continue;
                        }
                    }
                    let end = ((span_x * 0.06) as usize).max(8);
                    // a scan may be rotated by up to half a degree: the ends of a long side sit off the peak row
                    let skew_band = 3 + (span_x * 0.005) as i64;
                    let left = tight_support(&g, x0, y0, y1, false);
                    let right = tight_support(&g, x1, y0, y1, false);
                    let ends = [
                        side_support_band(&g, y0, x0, x0 + end, true, skew_band),
                        side_support_band(&g, y0, x1 - end, x1, true, skew_band),
                        side_support_band(&g, y1, x0, x0 + end, true, skew_band),
                        side_support_band(&g, y1, x1 - end, x1, true, skew_band),
                    ];
                    // stroke weight from the vertical sides at their middle third, where the peak column is exact
                    let mid = (y0 + y1) / 2;
                    let third = ((y1 - y0) / 3).max(4);
                    let widths = [
                        stroke_width(&g, x0, mid - third, mid + third, false, 4),
                        stroke_width(&g, x1, mid - third, mid + third, false, 4),
                    ];
                    let mut sorted = [widths[0], widths[1], widths[0], widths[1]];
                    sorted.sort_by(|p, q| p.partial_cmp(q).unwrap());
                    let median = (widths[0] + widths[1]) / 2.0;
                    let strength = (cols[x0] + cols[x1] + rows[y0] + rows[y1]) as f64;
                    if dbg {
                        eprintln!("  expected: left {left:.2} right {right:.2} ends {:?} widths {widths:?} median {median} strength {strength}", ends.iter().map(|v| (v * 100.0).round() / 100.0).collect::<Vec<_>>());
                    }
                    if left < 0.6 || right < 0.6 || ends.iter().any(|s| *s < 0.5) {
                        continue;
                    }
                    if median < 2.0 || median > 8.0 {
                        continue;
                    }
                    cands.push((strength, span_x, x0, x1, y0, y1, sorted[0], median));
                }
            }
        }
    }
    if debug {
        let mut show = cands.clone();
        show.sort_by(|p, q| q.0.partial_cmp(&p.0).unwrap());
        eprintln!("{} candidates; by strength (strength, span, x0, x1, y0, y1, thinnest, median width):", cands.len());
        for c in show.iter().take(10) {
            eprintln!("  {:.0} {:.0} {} {} {} {} {:.1} {:.1}", c.0, c.1, c.2, c.3, c.4, c.5, c.6, c.7);
        }
    }
    // a plate outline is drawn with one line weight on all its sides: a candidate whose two
    // vertical sides differ in weight by more than 30 % is a cell, hatching or a coincidence,
    // and it must not set the weight bar for the real outline
    cands.retain(|c| c.6 >= 0.7 * c.7);
    // and it is one of the larger rectangles with this aspect ratio on the sheet, never a
    // title-block cell or a small detail under a third the size of the largest match
    let max_span = cands.iter().map(|c| c.1).fold(0.0, f64::max);
    cands.retain(|c| c.1 >= 0.3 * max_span);
    if debug {
        eprintln!("{} candidates after the weight-consistency and size filters", cands.len());
    }
    // visible-line weight is relative to the sheet: keep the candidates whose strokes are as thick
    // as the thickest candidate's (within 20 %), then take the strongest lines among them
    let max_width = cands.iter().map(|c| c.7).fold(0.0, f64::max);
    let best = cands
        .iter()
        .cloned()
        .filter(|c| c.7 >= 0.9 * max_width && c.6 >= 0.75 * max_width)
        .fold(None, |acc: Option<(f64, f64, usize, usize, usize, usize, f64, f64)>, c| match acc {
            None => Some(c),
            Some(b) => if c.0 > b.0 { Some(c) } else { Some(b) },
        });
    let (_, span_x, x0, x1, yt, yb, _, _) = best.expect("plate outline not found on the page; check --length/--width, or set PROBE_HINT=x0,y0,x1,y1 (page fractions) around the plan view");
    let scale = span_x / length;
    let band = ((length.min(width) * 0.25 * scale) as usize).max(20);
    let inset = (band / 8).max(4);
    let refine_row = |yg: usize, xlo: usize, xhi: usize| -> usize {
        let mut best = (0.0, yg);
        for y in yg.saturating_sub(12)..(yg + 13).min(g.h) {
            let s = side_support_band(&g, y, xlo, xhi.min(g.w), true, 1);
            let wdt = stroke_width(&g, y, xlo, xhi.min(g.w), true, 1);
            let score = s * wdt - 0.01 * (y as f64 - yg as f64).abs();
            if score > best.0 {
                best = (score, y);
            }
        }
        best.1
    };
    let refine_col = |xg: usize, ylo: usize, yhi: usize| -> usize {
        let mut best = (0.0, xg);
        for x in xg.saturating_sub(12)..(xg + 13).min(g.w) {
            let s = side_support_band(&g, x, ylo, yhi.min(g.h), false, 1);
            let wdt = stroke_width(&g, x, ylo, yhi.min(g.h), false, 1);
            let score = s * wdt - 0.01 * (x as f64 - xg as f64).abs();
            if score > best.0 {
                best = (score, x);
            }
        }
        best.1
    };
    let tl = (refine_col(x0, yt + inset, yt + inset + band), refine_row(yt, x0 + inset, x0 + inset + band));
    let tr = (refine_col(x1, yt + inset, yt + inset + band), refine_row(yt, x1 - inset - band, x1 - inset));
    let bl = (refine_col(x0, yb - inset - band, yb - inset), refine_row(yb, x0 + inset, x0 + inset + band));
    let br = (refine_col(x1, yb - inset - band, yb - inset), refine_row(yb, x1 - inset - band, x1 - inset));
    Cal { dpi: CAL_DPI, tl: (tl.0 as f64, tl.1 as f64), tr: (tr.0 as f64, tr.1 as f64), bl: (bl.0 as f64, bl.1 as f64), br: (br.0 as f64, br.1 as f64), length, width }
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

fn parse_window(s: &str) -> (f64, f64, f64, f64) {
    let v: Vec<f64> = s.split(',').map(|t| t.trim().parse().unwrap_or_else(|_| fail("--window wants four page fractions fx0,fy0,fx1,fy1"))).collect();
    if v.len() != 4 {
        fail("--window wants four page fractions fx0,fy0,fx1,fy1");
    }
    (v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3]))
}

fn number(args: &[String], name: &str) -> Option<f64> {
    arg(args, name).map(|v| v.parse().unwrap_or_else(|_| fail(&format!("{name} wants a number"))))
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "internal error".to_string());
        println!("{{\"ok\":false,\"error\":{}}}", json_string(&message));
    }));
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: print-probe <info|render|calibrate|crop|ring-score|symbols> --print P [--length L --width W] [...]");
        std::process::exit(2);
    }
    let t0 = Instant::now();
    let cmd = args[1].as_str();
    let print = arg(&args, "--print").or_else(|| arg(&args, "--pdf")).unwrap_or_else(|| fail("--print is required"));
    let page: u32 = number(&args, "--page").unwrap_or(1.0) as u32;
    let holes = arg(&args, "--holes").map(|p| read_holes(&p)).unwrap_or_default();
    let output = match cmd {
        "info" => info_cmd(&print),
        "render" => {
            let dpi = number(&args, "--dpi").unwrap_or(150.0) as u32;
            let window = arg(&args, "--window").map(|w| parse_window(&w));
            let out = arg(&args, "--out").unwrap_or_else(|| fail("render needs --out"));
            render_cmd(&print, page, dpi, window, &out)
        }
        "calibrate" | "crop" | "ring-score" | "probe" | "symbols" => {
            let length = number(&args, "--length").unwrap_or_else(|| fail(&format!("{cmd} needs --length and --width")));
            let width = number(&args, "--width").unwrap_or_else(|| fail(&format!("{cmd} needs --length and --width")));
            let cal = calibrate(&print, page, length, width);
            match cmd {
                "calibrate" => format!("{{\"ok\":true,\"calibration\":{}}}", cal.json()),
                "crop" => {
                    let region = parse_region(&arg(&args, "--region").unwrap_or_else(|| fail("crop needs --region")));
                    let dpi = number(&args, "--dpi").unwrap_or(400.0) as u32;
                    let out = arg(&args, "--out").unwrap_or_else(|| fail("crop needs --out"));
                    let grid = number(&args, "--grid").unwrap_or(0.0);
                    crop_cmd(&print, page, &cal, region, dpi, &out, &holes, grid)
                }
                "ring-score" => {
                    let dpi = number(&args, "--dpi").unwrap_or(600.0) as u32;
                    let search = number(&args, "--search").unwrap_or(2.5);
                    ring_score_cmd(&print, page, &cal, &holes, dpi, search)
                }
                "probe" => {
                    let dpi = number(&args, "--dpi").unwrap_or(600.0) as u32;
                    let at: Vec<f64> = arg(&args, "--at").unwrap_or_else(|| fail("probe needs --at x,y")).split(',').map(|t| t.trim().parse().unwrap_or_else(|_| fail("--at wants x,y"))).collect();
                    let (x, y) = (at[0], at[1]);
                    let g = render(&print, dpi, page, None);
                    let ppm = cal.px_per_mm() * dpi as f64 / cal.dpi as f64;
                    let (px, py) = cal.to_px(dpi, (0.0, 0.0))(x, y);
                    let p = probe_refined(&g, px, py, ppm, 32.0);
                    let thick = if p.r_px > 0.0 { thick_fraction(&g, p.cx, p.cy, p.r_px, ppm, (1.0f64).max(0.4 * p.r_px / ppm)) } else { 0.0 };
                    format!("{{\"ok\":true,\"at\":[{},{}],\"px\":[{:.1},{:.1}],\"drawn\":\"{}\",\"ring\":{:.2},\"interior\":{:.2},\"thick\":{:.2},\"drawn_diameter_mm\":{:.1},\"profile_r_ring0_ring_tol_interior\":{}}}", x, y, px, py, p.kind, p.ring, p.interior, thick, 2.0 * p.r_px / ppm, profile(&g, px, py, ppm, 6.0))
                }
                _ => {
                    let region = arg(&args, "--region").map(|r| parse_region(&r));
                    let dpi = number(&args, "--dpi").unwrap_or(400.0) as u32;
                    let out = arg(&args, "--out");
                    symbols_cmd(&print, page, &cal, region, dpi, &holes, out.as_deref())
                }
            }
        }
        other => fail(&format!("unknown subcommand {other}")),
    };
    let mut o = output;
    o.insert_str(o.len() - 1, &format!(",\"elapsed_ms\":{}", t0.elapsed().as_millis()));
    let mut stdout = std::io::stdout();
    stdout.write_all(o.as_bytes()).unwrap();
    stdout.write_all(b"\n").unwrap();
}
