# -*- coding: utf-8 -*-
"""造测试片：底部字幕在已知时刻切换，用来验证 OCR 自动打点的准确度。

字幕（每条持续 2.5 秒，切换点 = 1.0 / 3.5 / 6.0 / 8.5 / 11.0 / 13.5 秒）：
    童站挑战 第三关 开始 / 这题我会 稳 / 结果翻车了哈哈 / 再来一次 这次认真 / 终于过关 好耶 / 收工 明天见
输出：work/src/sub_test.mp4（1280x720 25fps，带一条正弦音轨）
"""
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))     # cut-tool/
SRC = os.path.join(ROOT, 'work', 'src')
os.makedirs(SRC, exist_ok=True)
FF = r'F:\ffmpeg-4.4.1-full_build\bin\ffmpeg.exe'

LINES = ['童站挑战 第三关 开始', '这题我会 稳', '结果翻车了哈哈',
         '再来一次 这次认真', '终于过关 好耶', '收工 明天见']
START = 1.0
EACH = 2.5
W, H = 1280, 720

# 生成字幕条 PNG（白字黑描边，居中，贴底部）
font = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', 56)
pngs = []
for i, txt in enumerate(LINES):
    strip = Image.new('RGBA', (W, 140), (0, 0, 0, 0))
    d = ImageDraw.Draw(strip)
    tw = d.textlength(txt, font=font)
    x = (W - tw) / 2
    d.text((x, 30), txt, font=font, fill=(255, 255, 255, 255),
           stroke_width=4, stroke_fill=(0, 0, 0, 255))
    p = os.path.join(SRC, '_sub_%d.png' % i)
    strip.save(p)
    pngs.append(p)

# 拼 ffmpeg 参数：底图（深色）+ 6 条字幕按时出现
args = [FF, '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x101418:s=%dx%d:r=25:d=16' % (W, H),
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=16']
for p in pngs:
    args += ['-i', p]
filters = []
cur = '[0:v]'
for i in range(len(pngs)):
    a = START + i * EACH
    b = a + EACH - 0.15
    nxt = '[v%d]' % (i + 1)
    filters.append('%s[%d:v]overlay=0:%d:enable=\'between(t,%.2f,%.2f)\'%s'
                   % (cur, i + 2, H - 160, a, b, nxt))
    cur = nxt
args += ['-filter_complex', ';'.join(filters) + ';%snull[vo]' % cur]
args += ['-map', '[vo]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest',
         os.path.join(SRC, 'sub_test.mp4')]
print('生成中…')
r = subprocess.run(args, capture_output=True, text=True)
print('ffmpeg 返回码:', r.returncode, (r.stderr or '')[-300:])
for p in pngs:
    try:
        os.remove(p)
    except OSError:
        pass
out = os.path.join(SRC, 'sub_test.mp4')
print('输出:', out, os.path.getsize(out) if os.path.exists(out) else '（失败）', 'bytes')
print('已知字幕切换时刻（秒）:', [round(START + i * EACH, 2) for i in range(len(LINES))])
