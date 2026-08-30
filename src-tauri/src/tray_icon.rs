use tauri::image::Image;

/// Retina のメニューバー（22pt）に合わせた実ピクセル数。
const SIZE: u32 = 44;
const CENTER: f32 = SIZE as f32 / 2.0;
const OUTER: f32 = 16.5;
const INNER: f32 = 11.5;

const TAU: f32 = std::f32::consts::PI * 2.0;

/// 上限が近いときだけ使う色。
const ALERT: (f32, f32, f32) = (255.0, 82.0, 82.0);

/// 境界を 1px ぶんなめらかにする。
fn smooth_edge(distance: f32) -> f32 {
    (0.5 - distance).clamp(0.0, 1.0)
}

fn blend(dst: &mut [u8], idx: usize, r: f32, g: f32, b: f32, a: f32) {
    if a <= 0.0 {
        return;
    }
    let a = a.clamp(0.0, 1.0);
    let prev_a = dst[idx + 3] as f32 / 255.0;
    let out_a = a + prev_a * (1.0 - a);
    if out_a <= 0.0 {
        return;
    }
    let mix = |src: f32, dst_v: u8| {
        let d = dst_v as f32;
        ((src * a + d * prev_a * (1.0 - a)) / out_a).clamp(0.0, 255.0)
    };
    dst[idx] = mix(r, dst[idx]) as u8;
    dst[idx + 1] = mix(g, dst[idx + 1]) as u8;
    dst[idx + 2] = mix(b, dst[idx + 2]) as u8;
    dst[idx + 3] = (out_a * 255.0) as u8;
}

/// 5 時間枠の使用率をリングで、残留プロセスの有無を右下の点で表す。
///
/// `alert` が false のときは黒一色で描く。メニューバー側がテンプレート画像として
/// 明暗を反転させるため、並んでいる他のアイコンと同じ見え方になる。
/// 上限が近いときだけ色を持たせ、テンプレート扱いを外して目に入るようにする。
pub fn render(percentage: Option<f32>, has_stale: bool, alert: bool) -> Image<'static> {
    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];
    let (cr, cg, cb) = if alert { ALERT } else { (0.0, 0.0, 0.0) };
    let progress = percentage.map(|p| (p / 100.0).clamp(0.0, 1.0));

    for y in 0..SIZE {
        for x in 0..SIZE {
            let idx = ((y * SIZE + x) * 4) as usize;
            let dx = x as f32 + 0.5 - CENTER;
            let dy = y as f32 + 0.5 - CENTER;
            let r = (dx * dx + dy * dy).sqrt();

            // 12 時を起点に時計回りで 0.0〜1.0。
            let mut t = dx.atan2(-dy) / TAU;
            if t < 0.0 {
                t += 1.0;
            }

            let in_ring = smooth_edge(r - OUTER).min(smooth_edge(INNER - r));
            if in_ring <= 0.0 {
                continue;
            }

            match progress {
                // 使った分は濃く、残りは輪郭として薄く残す。
                Some(p) if t <= p => blend(&mut buf, idx, cr, cg, cb, in_ring),
                Some(_) => blend(&mut buf, idx, cr, cg, cb, in_ring * 0.3),
                None => blend(&mut buf, idx, cr, cg, cb, in_ring * 0.45),
            }
        }
    }

    if has_stale {
        // 右下に小さな点を置き、片付けるものがあることを知らせる。
        let (bx, by) = (SIZE as f32 - 7.5, SIZE as f32 - 7.5);
        for y in 0..SIZE {
            for x in 0..SIZE {
                let idx = ((y * SIZE + x) * 4) as usize;
                let d = ((x as f32 + 0.5 - bx).powi(2) + (y as f32 + 0.5 - by).powi(2)).sqrt();
                let core = smooth_edge(d - 3.6);
                if core > 0.0 {
                    blend(&mut buf, idx, cr, cg, cb, core);
                }
            }
        }
    }

    Image::new_owned(buf, SIZE, SIZE)
}
