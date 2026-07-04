#!/usr/bin/env python3
# fixture stub：与引擎 curate.py 同 CLI（reindex --instance --dir --apply）。
# 最小行为：把目录下内容页以 | [[stem]] | ... | 行登记进该目录 README。真实逻辑归引擎测试管。
import argparse, pathlib

p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
r = sub.add_parser("reindex")
r.add_argument("--instance", required=True)
r.add_argument("--dir", required=True)
r.add_argument("--apply", action="store_true")
rm = sub.add_parser("rm")
rm.add_argument("--instance", required=True)
rm.add_argument("--page", required=True)
rm.add_argument("--apply", action="store_true")
a = p.parse_args()

if a.cmd == "rm":
    target = pathlib.Path(a.instance) / a.page
    assert target.is_file(), f"not a file: {a.page}"
    if a.apply:
        target.unlink()
    print("removed " + a.page)
    raise SystemExit(0)

d = pathlib.Path(a.instance) / a.dir
readme = d / "README.md"
lines = [
    f"| [[{f.stem}]] | {f.stem} |"
    for f in sorted(d.rglob("*.md"))
    if f.name != "README.md" and not f.name.startswith("_")
]
if a.apply:
    text = readme.read_text() if readme.exists() else f"# {a.dir}\n"
    text += "\n" + "\n".join(lines) + "\n"
    readme.write_text(text)
print("reindexed " + a.dir)
