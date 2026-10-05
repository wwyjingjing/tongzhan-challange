# -*- coding: utf-8 -*-
"""
overlay_gen.py —— 为「烧录标记」生成 ✅/❌ + 编号 的整块透明 PNG，并算出贴图坐标。

用法（文件交换，避免 Windows 管道互锁；与 ocr_worker.py 同一套路）：
    python overlay_gen.py <in.json> <out.json>

in.json:
{
  "video":       {"w": 1080, "h": 2400},
  "cfg":         { ... burn 配置，见 DEFAULT_CFG ... },
  "items":       [{"id": "1", "num": 3, "err": false}, ...],
  "outDir":      "F:/.../cut-tool/work/badges",   // 生成 PNG 的落脚目录
  "assetsDir":   "F:/.../cut-tool/assets",        // 内置 ✅/❌ 图（可不存在，会即时生成）
  "returnBase64": false                            // 预览时置 true，回传图片内容
}

out.json:
{ "ok": true, "badge": {"style": "emoji|vector|custom"},
  "items": [{"id": "1", "png": "...", "x": 100, "y": 200, "w": 238, "h": 400, "b64": "..."}],
  "log": ["..."] }
失败时：{ "ok": false, "error": "..." }
"""
import base64
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ---------- 默认配置（与 server.js / 前端保持一致）----------
DEFAULT_CFG = {
    "badgeScale": 0.22,      # 符号宽度 = 画面宽 × 该值
    "numberSize": 0.055,     # 编号字号 = 画面高 × 该值
    "gap": 0.012,            # 符号与编号间距 = 画面高 × 该值
    "order": "badgeTop",     # badgeTop=符号在上 | numberTop=编号在上
    "anchor": "bottom-center",
    "offsetX": 0.0,          # 附加偏移 = 画面宽/高 × 该值
    "offsetY": -0.06,
    "numberColor": "#FFFFFF",
    "numberStroke": "#000000",
    "strokeWidth": 0.004,    # 描边宽 = 画面高 × 该值
    "fontPath": r"C:\Windows\Fonts\msyhbd.ttc",
    "badgeStyle": "emoji",   # emoji=系统彩色表情 | vector=矢量绘制（绿勾/红叉）
    "badgeOkImage": "",      # 自定义图片（留空则用内置）
    "badgeNoImage": "",
}

EMOJI_FONT = r"C:\Windows\Fonts\seguiemj.ttf"
FONT_FALLBACKS = [
    r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\arialbd.ttf",
]
COLOR_OK = (34, 197, 94)     # 绿
COLOR_NO = (239, 68, 68)     # 红
ANCHOR_F = {
    "top-left": (0.0, 0.0), "top-center": (0.5, 0.0), "top-right": (1.0, 0.0),
    "mid-left": (0.0, 0.5), "center": (0.5, 0.5), "mid-right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0), "bottom-center": (0.5, 1.0), "bottom-right": (1.0, 1.0),
}


def hex2rgb(s, default=(255, 255, 255)):
    s = (s or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return default
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return default


def load_number_font(path, size, logs):
    cands = [path] + [p for p in FONT_FALLBACKS if p != path]
    errs = []
    for p in cands:
        if not p:
            continue
        try:
            f = ImageFont.truetype(p, size)
            if os.path.normcase(p) != os.path.normcase(path or ""):
                logs.append("编号字体回退：%s → %s" % (path, p))
            return f
        except Exception as e:                                   # noqa: BLE001
            errs.append("%s(%s)" % (p, e))
    raise RuntimeError("没有可用字体：" + "; ".join(errs))


def render_emoji_badge(ch, px, logs):
    """用 Segoe UI Emoji 渲染真彩色表情；失败返回 None。"""
    if not os.path.exists(EMOJI_FONT):
        return None
    try:
        font = ImageFont.truetype(EMOJI_FONT, px)
        pad = px // 2
        img = Image.new("RGBA", (px * 2, px * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.text((pad, pad), ch, font=font, embedded_color=True)
        bbox = img.getbbox()
        if not bbox:
            return None
        return img.crop(bbox)
    except Exception as e:                                       # noqa: BLE001
        logs.append("表情渲染失败（%s），改用矢量图形" % e)
        return None


def _round_cap(d, pt, r, fill):
    d.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=fill)


def draw_polyline(d, pts, width, fill, outline, ow):
    """带描边的圆头折线。"""
    if outline and ow > 0:
        d.line(pts, fill=outline, width=int(width + 2 * ow), joint="curve")
        for p in (pts[0], pts[-1]):
            _round_cap(d, p, (width + 2 * ow) / 2.0, outline)
    d.line(pts, fill=fill, width=int(width), joint="curve")
    for p in (pts[0], pts[-1]):
        _round_cap(d, p, width / 2.0, fill)


def render_vector_badge(err, target_w, logs):
    """矢量绘制：绿勾 / 红叉，白色描边（贴纸风），锐利且不挑字体。"""
    S = int(target_w)
    m = S * 0.06                                   # 外边距（给描边留空间）
    box = S - 2 * m
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = COLOR_NO if err else COLOR_OK
    lw = box * 0.21
    ow = box * 0.06
    if err:
        p1 = (m + box * 0.14, m + box * 0.14)
        p2 = (m + box * 0.86, m + box * 0.86)
        p3 = (m + box * 0.86, m + box * 0.14)
        p4 = (m + box * 0.14, m + box * 0.86)
        draw_polyline(d, [p1, p2], lw, color, (255, 255, 255, 255), ow)
        draw_polyline(d, [p3, p4], lw, color, (255, 255, 255, 255), ow)
    else:
        pts = [(m + box * 0.08, m + box * 0.55),
               (m + box * 0.37, m + box * 0.85),
               (m + box * 0.93, m + box * 0.12)]
        draw_polyline(d, pts, lw, color, (255, 255, 255, 255), ow)
    return img


def load_custom_badge(path, target_w, logs):
    try:
        img = Image.open(path).convert("RGBA")
    except Exception as e:                                       # noqa: BLE001
        logs.append("自定义标记图读取失败（%s）：%s" % (path, e))
        return None
    w, h = img.size
    nh = max(1, int(round(h * target_w / float(w))))
    return img.resize((int(target_w), nh), Image.LANCZOS)


def fit_square(img, side):
    """等比缩放并居中放进 side×side 方框：✅/❌ 与编号的相对位置在各切片间保持一致。"""
    w, h = img.size
    k = min(side / float(w), side / float(h))
    nw, nh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    resized = img.resize((nw, nh), Image.LANCZOS) if (nw, nh) != (w, h) else img
    box = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    box.alpha_composite(resized, ((side - nw) // 2, (side - nh) // 2))
    return box


def make_badge(err, cfg, logs, cache):
    key = ("no" if err else "ok", int(round(cfg["_badge_px"])))
    if key in cache:
        return cache[key]
    target_w = int(round(cfg["_badge_px"]))
    custom = cfg.get("badgeNoImage" if err else "badgeOkImage") or ""
    img = None
    if custom:
        img = load_custom_badge(custom, target_w, logs)
        if img is not None:
            cfg["_style_used"] = "custom"
    if img is None and cfg.get("badgeStyle", "emoji") == "emoji":
        # 直接按目标尺寸渲染，避免位图表情二次缩放
        img = render_emoji_badge("\u274c" if err else "\u2705", max(32, target_w), logs)
        if img is not None:
            cfg["_style_used"] = "emoji"
    if img is None:
        img = render_vector_badge(err, target_w, logs)
        cfg["_style_used"] = "vector"
    img = fit_square(img, target_w)
    cache[key] = img
    return img


def render_number(num_text, cfg, logs):
    """把编号渲染成一张紧裁边的透明 PNG（白字黑描边，颜色/字号/描边宽可配）。"""
    vh = cfg["_vh"]
    npx = max(8, int(round(vh * cfg["numberSize"])))
    font = load_number_font(cfg.get("fontPath") or FONT_FALLBACKS[0], npx, logs)
    sw = max(0, int(round(vh * cfg.get("strokeWidth", 0))))
    color = hex2rgb(cfg.get("numberColor"), (255, 255, 255)) + (255,)
    stroke = hex2rgb(cfg.get("numberStroke"), (0, 0, 0)) + (255,)

    pad = sw + max(2, npx // 12)
    tmp = Image.new("RGBA", (npx * (len(num_text) + 2) + pad * 2, npx * 2 + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    d.text((pad, pad), num_text, font=font, fill=color,
           stroke_width=sw, stroke_fill=stroke)
    bbox = tmp.getbbox()
    return tmp.crop(bbox) if bbox else tmp


def compose_layers(badge, num_img, cfg):
    """按上下顺序把符号与编号排好，返回 ([ (kind, img, dx, dy) ], 整块宽, 整块高)。"""
    gap = max(0, int(round(cfg["_vh"] * cfg.get("gap", 0))))
    seq = [("badge", badge), ("number", num_img)] if cfg.get("order", "badgeTop") == "badgeTop" \
        else [("number", num_img), ("badge", badge)]
    W = max(img.width for _, img in seq)
    H = sum(img.height for _, img in seq) + gap
    layers, yoff = [], 0
    for kind, img in seq:
        layers.append((kind, img, (W - img.width) // 2, yoff))
        yoff += img.height + gap
    return layers, W, H


def place_box(w, h, cfg):
    vw, vh = cfg["_vw"], cfg["_vh"]
    fx, fy = ANCHOR_F.get(cfg.get("anchor", "bottom-center"), (0.5, 1.0))
    x = (vw - w) * fx + vw * float(cfg.get("offsetX", 0) or 0)
    y = (vh - h) * fy + vh * float(cfg.get("offsetY", 0) or 0)
    x = int(round(max(0, min(vw - w, x))))
    y = int(round(max(0, min(vh - h, y))))
    # yuv420p 下取偶数坐标，避免色度错位
    return x - (x % 2), y - (y % 2)


def main():
    if len(sys.argv) < 3:
        print("usage: python overlay_gen.py <in.json> <out.json>")
        return 2
    in_path, out_path = sys.argv[1], sys.argv[2]
    with open(in_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    logs = []
    try:
        cfg = dict(DEFAULT_CFG)
        cfg.update(spec.get("cfg") or {})
        vw = int((spec.get("video") or {}).get("w") or 0)
        vh = int((spec.get("video") or {}).get("h") or 0)
        if vw <= 0 or vh <= 0:
            raise RuntimeError("video 宽高无效")
        cfg["_vw"], cfg["_vh"] = vw, vh
        cfg["_badge_px"] = max(16, int(round(vw * float(cfg.get("badgeScale", 0.22)))))
        out_dir = spec.get("outDir") or "."
        os.makedirs(out_dir, exist_ok=True)

        cache = {}
        items = []
        for it in spec.get("items") or []:
            err = bool(it.get("err"))
            num_text = str(it.get("num", ""))
            item_id = str(it.get("id", "x"))
            badge = make_badge(err, cfg, logs, cache)
            num_img = render_number(num_text, cfg, logs)
            layers, W, H = compose_layers(badge, num_img, cfg)
            x, y = place_box(W, H, cfg)

            rec = {"id": item_id, "x": x, "y": y, "w": W, "h": H,
                   "badgeStyle": cfg.get("_style_used"), "layers": []}
            for kind, img, dx, dy in layers:
                lx, ly = x + dx, y + dy
                lx, ly = lx - (lx % 2), ly - (ly % 2)          # 与整块对齐取偶
                png = os.path.join(out_dir, "ly_%s_%s.png" % (item_id, kind))
                img.save(png)
                rec["layers"].append({"kind": kind, "png": png, "x": lx, "y": ly,
                                      "w": img.width, "h": img.height})
            if spec.get("returnBase64"):
                # 整块合成图（预览缩略图用）+ 各层图（按真实位置预览用）
                block = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                for kind, img, dx, dy in layers:
                    block.alpha_composite(img, (dx, dy))
                import io
                buf = io.BytesIO()
                block.save(buf, format="PNG")
                rec["b64"] = base64.b64encode(buf.getvalue()).decode("ascii")
                for lay in rec["layers"]:
                    with open(lay["png"], "rb") as fp:
                        lay["b64"] = base64.b64encode(fp.read()).decode("ascii")
            items.append(rec)

        result = {"ok": True, "badge": {"style": cfg.get("_style_used", "vector")},
                  "items": items, "log": logs}
    except Exception as e:                                       # noqa: BLE001
        import traceback
        result = {"ok": False, "error": "%s: %s" % (type(e).__name__, e),
                  "trace": traceback.format_exc()[-1500:], "log": logs}

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
