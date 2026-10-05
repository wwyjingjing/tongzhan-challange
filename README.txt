童站挑战剪辑器 · 使用前须知
================================

【怎么启动】
双击「启动.cmd」（纯英文名兜底：start.cmd）。
它会自动挑一个空闲端口（8777 起）、启动服务、等就绪后打开浏览器。
关闭那个黑窗口 = 停止服务。
启动细节写在 cut-tool\_launcher.log，起不来时先看它。

【依赖】（本机都已装好）
1) ffmpeg / ffprobe 要在 PATH 里：本机为 F:\ffmpeg-4.4.1-full_build\bin
2) 烧录 ✅/❌ 需要 Python + Pillow，默认用：
   C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe
   （换电脑/换 Python 时设环境变量 CUT_PY 指向别的 python.exe）
3) Node.js 18+（启动器优先用 PATH 里的 node，找不到就用内置兜底路径）
   页面右上角自检会显示「ffmpeg ✔ / PIL ✔」。

【默认路径】（都可用环境变量覆盖）
- 默认输出目录        F:\workbuddy\2026-10-02-12-47-05\output\manual   → set CUT_OUT_DIR=...
- 音效文件            assets\对.mp3 / assets\错.mp3                    → set CUT_SFX_OK=... / CUT_SFX_NO=...
- 端口                set CUT_PORT=8888
- 导出并发数          set CUT_CONC=3

【文件说明】
启动.cmd / start.cmd   双击启动
launcher.js            启动助手（挑端口 / 起服务 / 就绪后开浏览器，不依赖 PowerShell）
server.js              本地服务（零依赖，仅用 Node 内置模块）
overlay_gen.py         生成 ✅/❌ + 编号标记图（Pillow）
ocr_worker.py          早期 OCR 判定用的脚本（现在流程用不到，留着备用）
pick_file.ps1          调用 Windows 原生文件对话框
public\index.html      前端页面（打点 / 审核 / 导出全在这里）
assets\                对.mp3 / 错.mp3（可以整体替换成你自己的音效）
使用说明.md            ★ 完整说明，建议先读这个

【导出的东西在哪】
<输出目录>\clips_burned\     烧录好的切片（✅/❌ + 编号 + 对/错音效）
<输出目录>\clips\            干净切片（可选）
<输出目录>\童站挑战_xxx.mp4   合并好的成片
<输出目录>\manifest.json     本次导出的清单

【这一版有什么】（截至 2026-10-05）
- 手动滚轮/下滑/快捷键打点（默认 M 打点、E 标错，键位可改）
- 审核栏贴在视频右侧：逐段标 ✅/❌、跳到 / 截断 / ✂ 删点、「⇅ 全部反选」
- 起点 / 结尾：只导出中间那段，编号从起点重新从 1 开始
- 打点自动存档（刷新/崩溃不丢）+ 导出/导入打点文件
- 烧录 ✅/❌ + 编号（出现/消失时间可分别设置）+ 对/错音效（原声保持）
- 导出后自动合并成一条成片，也可单独「🎬 合并成片」

打包时间：2026-10-05
