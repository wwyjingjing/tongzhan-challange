# -*- coding: utf-8 -*-
"""校验输出切片的时长是否与审核后的切点一致（帧精确性验证）"""
import subprocess, json, os

OUT = r"F:\workbuddy\2026-10-01-11-46-21\cut-tool\output"
mf = os.path.join(OUT, "manifest.json")

def dur(p):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", p], capture_output=True, text=True)
    try: return float(r.stdout.strip())
    except: return -1

m = json.load(open(mf, encoding="utf-8"))
print("source:", m["source"])
print("mode:", m["mode"])
print("counts:", m["counts"])
print()

# 用 manifest 里的 start/end 与产物时长比对，并检查 keep 序列是否连续
for g in ("keep", "cut"):
    print(f"=== {g} ({len(m[g])} 段) ===")
    prev_end = None
    for it in m[g]:
        p = os.path.join(OUT, it["file"].replace("/", os.sep))
        d = dur(p)
        expect = it["end"] - it["start"]
        delta = d - expect
        mark = "OK " if abs(delta) < 0.13 else "!!!"
        # 相邻段是否连续（keep 组若来自连续内容应首尾相接）
        gap = "" if prev_end is None else f" | 与前段间隔 {it['start']-prev_end:+.3f}s"
        print(f"  {mark} {it['file']:<16} 起 {it['start']:>7.3f} 止 {it['end']:>7.3f} "
              f"应 {expect:>6.3f}s 实 {d:>6.3f}s 差 {delta:+.3f}s{gap}")
        prev_end = it["end"]
    print()

print("=== 编号连续性 ===")
for g in ("keep", "cut"):
    files = sorted(m[g], key=lambda x: x["file"])
    seq = [int(f["file"].split("_")[1].split(".")[0]) for f in files]
    ok = seq == list(range(1, len(seq) + 1))
    print(f"  {g}: {seq} -> {'从 1 起连续编号 ✔' if ok else '编号异常 ✘'}")
