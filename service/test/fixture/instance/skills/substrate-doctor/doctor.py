#!/usr/bin/env python3
# fixture stub：最小 doctor——只校验 governance/zones.md 的 yaml 块可解析 + 每个注册 zone 的目录存在。
# 真实 doctor 归引擎测试管（在真实例私库）；这里只求「schema_apply 落地 doctor 0 error」端到端可真验。
# 末行固定输出 `→ N error(s)`（keeper/executor 的 runDoctor 用正则 `→ (\d+) error` 抽 N）。
import sys, re, pathlib

inst = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
errors = []

# 1) zones.md 的 yaml 块必须存在且可按引擎约定的固定形状解析（与 acl.parseZones 同款行级解析，不引 yaml 依赖）
zones_md = inst / "governance" / "zones.md"
try:
    raw = zones_md.read_text(encoding="utf-8")
except Exception as e:  # noqa: BLE001 —— 读不到就是一处 error，doctor 不该崩
    print(f"zones.md 读取失败：{e}")
    print("→ 1 error(s)")
    raise SystemExit(0)

m = re.search(r"```yaml\n(.*?)```", raw, re.S)
if not m:
    print("zones.md 找不到 yaml 块")
    print("→ 1 error(s)")
    raise SystemExit(0)

zones = []
current = None
for line in m.group(1).split("\n"):
    item = re.match(r"^  - (\w+):\s*(.*)$", line)
    field = re.match(r"^    (\w+):\s*(.*)$", line)
    if item:
        current = {item.group(1): item.group(2).strip().strip("\"'")}
        zones.append(current)
    elif field and current is not None:
        current[field.group(1)] = field.group(2).strip().strip("\"'")

# 2) 围栏完整性（F1 加固）：purpose 里注入的 ``` 会提前闭合 yaml 块（本 stub 与 acl.parseZones 同款非贪婪
#    正则都会被截断）。截断时块外必残留 zone 条目形状的孤行（`  - id:` / 4 空格缩进的 `key:`），且全文 ```
#    计数常失配——任一命中即报「围栏截断」损坏，验收门对此不再失明。
tail = raw[m.end():]
if re.search(r"^(  - \w+:|    \w+:)", tail, re.M):
    errors.append("yaml 围栏疑似被截断：块外残留 zone 条目行")
if raw.count("```") % 2 != 0:
    errors.append("``` 围栏数不配平（奇数个，疑似截断/未闭合）")

# 3) 每个注册 zone 的目录必须真实存在（schema_apply 建 zone 后此项应变 0 error）
for z in zones:
    p = z.get("path")
    if not p:
        errors.append(f"zone {z.get('id', '?')} 缺 path")
        continue
    if not (inst / p).is_dir():
        errors.append(f"zone {z.get('id', '?')} 的目录不存在：{p}")

for e in errors:
    print(e)
print(f"→ {len(errors)} error(s)")
