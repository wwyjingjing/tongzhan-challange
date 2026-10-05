# -*- coding: utf-8 -*-
"""
生成端到端测试视频（修正版）：
内容段带真实音频（440Hz 正弦 + 语音感），段间插入【数字静音】间隙，
这样才能验证 silencedetect 的切分能力。

期望：6 个内容段 / 5 处静音间隙 -> 5 个切点 / 6 个切片
其中 PART2/4/6 为广告类文字 -> OCR 应判为 cut
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = r"F:\workbuddy\2026-10-01-11-46-21\cut-tool\work\src"
FR = r"F:\workbuddy\2026-10-01-11-46-21\cut-tool\work\testframes"
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(FR, exist_ok=True)
FONT = r"C:\Windows\Fonts\msyh.ttc"

plan = [
    ("第三章 数据结构基础", 3.0, 1.2, False),
    ("本视频由星辰教育独家赞助播出", 3.0, 1.2, True),
    ("我们来看二叉树的定义", 3.0, 1.2, False),
    ("关注公众号 领取课程资料", 3.0, 1.2, True),
    ("接下来讲解遍历的三种方式", 3.0, 1.2, False),
    ("点赞投币收藏 一键三连", 3.0, 0.0, True),
]

font = ImageFont.truetype(FONT, 40)
f_small = ImageFont.truetype(FONT, 30)
W, H = 1280, 720
parts = []

for i, (text, vdur, sdur, is_ad) in enumerate(plan):
    img = Image.new("RGB", (W, H), (16, 18, 24))
    d = ImageDraw.Draw(img)
    d.text((60, 60), "PART %d" % (i + 1), font=f_small, fill=(80, 90, 110))
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((W - tw) / 2, (H - th) / 2), text, font=font, fill=(235, 238, 245))
    png = os.path.join(FR, "p%d.png" % (i + 1))
    img.save(png)

    # 内容段：真实音频（不同音高，便于区分）
    freq = 300 + i * 90
    seg = os.path.join(FR, "s%d.mp4" % (i + 1))
    subprocess.run([
        "ffmpeg", "-y", "-loop", "1", "-i", png,
        "-f", "lavfi", "-i", "sine=frequency=%d:sample_rate=44100" % freq,
        "-t", str(vdur), "-r", "25", "-pix_fmt", "yuv420p",
        "-af", "volume=0.5",
        "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k", "-shortest", seg
    ], capture_output=True)
    parts.append(seg)

    if sdur > 0:
        sil = os.path.join(FR, "g%d.mp4" % (i + 1))
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=%dx%d:d=%s:r=25" % (W, H, sdur),
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-t", str(sdur), "-pix_fmt", "yuv420p",
            "-c:v", "libx264", "-c:a", "aac", "-b:a", "128k", sil
        ], capture_output=True)
        parts.append(sil)

lst = os.path.join(FR, "list.txt")
with open(lst, "w", encoding="utf-8") as f:
    for p in parts:
        f.write("file '%s'\n" % p.replace("\\", "/"))

final = os.path.join(OUT_DIR, "e2e_test.mp4")
r = subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                    "-c", "copy", final], capture_output=True)
if r.returncode != 0:
    print(r.stderr.decode("utf-8", "ignore")[-1200:]); sys.exit(1)

pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                     "-of", "default=nw=1:nk=1", final], capture_output=True, text=True)
print("final:", final)
print("duration:", pr.stdout.strip())
print("expected: 6 content segs + 5 silent gaps -> 5 cuts / 6 clips")
