# -*- coding: utf-8 -*-
"""
批量 OCR：一次进程启动、加载一次模型、处理全部图片。

用法:
    python ocr_worker.py <input.json> <output.json>

input.json :  {"items": [{"id": "s1", "image": "C:/.../f1.png"}, ...]}
output.json:  {"ok": true, "results": {"s1": {"text": "...", "items": [...], "scores": [...]}}}

为什么用文件而不是 stdio 管道：Windows 下子进程管道 + 双向 NDJSON 容易因
缓冲/编码互相阻塞；文件交换无死锁风险，且模型依然只加载一次（性能等价）。
"""
import sys
import os
import json
import traceback


def main():
    if len(sys.argv) < 3:
        print("usage: ocr_worker.py <input.json> <output.json>", file=sys.stderr)
        return 2

    inp, outp = sys.argv[1], sys.argv[2]

    with open(inp, "r", encoding="utf-8") as f:
        payload = json.load(f)
    items = payload.get("items", [])

    result = {"ok": True, "results": {}, "errors": []}

    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:
        result["ok"] = False
        result["errors"].append("import failed: %s" % e)
        _write(outp, result)
        return 1

    try:
        engine = RapidOCR()
    except Exception as e:
        result["ok"] = False
        result["errors"].append("init failed: %s" % e)
        _write(outp, result)
        return 1

    for it in items:
        rid = it.get("id")
        img = it.get("image")
        if not img or not os.path.exists(img):
            result["results"][str(rid)] = {"text": "", "items": [], "error": "missing image"}
            continue
        try:
            res, _elapse = engine(img)
            texts, scores = [], []
            if res:
                for row in res:
                    try:
                        t = str(row[1]).strip()
                        s = float(row[2])
                    except Exception:
                        continue
                    if t:
                        texts.append(t)
                        scores.append(round(s, 4))
            result["results"][str(rid)] = {
                "text": "\n".join(texts),
                "items": texts,
                "scores": scores,
                "avgScore": round(sum(scores) / len(scores), 4) if scores else 0.0,
            }
        except Exception as e:
            result["results"][str(rid)] = {"text": "", "items": [], "error": str(e)}

    _write(outp, result)
    return 0


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # 保证任何情况下都产出可读的错误文件，方便 Node 侧定位
        try:
            with open(sys.argv[2], "w", encoding="utf-8") as f:
                json.dump({"ok": False, "results": {}, "errors": [traceback.format_exc()]},
                          f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        sys.exit(1)
