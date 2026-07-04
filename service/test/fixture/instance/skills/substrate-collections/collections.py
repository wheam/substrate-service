#!/usr/bin/env python3
# fixture stub：与引擎 collections.py 同 CLI（upsert --csv --field k=v --apply）。
# 最小行为：按 id 幂等 追加/更新 一行。真实逻辑归引擎测试管。
import argparse, csv

p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
u = sub.add_parser("upsert")
u.add_argument("--csv", required=True)
u.add_argument("--field", action="append", default=[])
u.add_argument("--apply", action="store_true")
a = p.parse_args()

fields = dict(f.split("=", 1) for f in a.field)
assert "id" in fields, "id required"

with open(a.csv, newline="") as fh:
    reader = csv.reader(fh)
    header = next(reader)
    rows = [dict(zip(header, r)) for r in reader]

hit = [r for r in rows if r.get("id") == fields["id"]]
if hit:
    hit[0].update(fields)
else:
    rows.append({**{c: "" for c in header}, **{k: v for k, v in fields.items() if k in header}})

if a.apply:
    with open(a.csv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=header)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in header})
print(("APPLIED" if a.apply else "DRY") + " upsert " + fields["id"])
