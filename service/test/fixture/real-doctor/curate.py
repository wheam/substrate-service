#!/usr/bin/env python3
"""substrate-curator curate.py — 删页(连带清反向链接) + 重建目录索引（零依赖，python3 标准库）。

为什么要它（设计动机）:
  - **删一个内容页不该连累别人**：删页后，全库指向它的 [[wikilink]] 会变成断链。本工具在删页时
    一并清理这些反向链接（纯导航条目删整行；正文里去链成纯文本），让删除是干净的一等操作。
  - **目录该能自动填**：import / 日常维护后，每个目录的 README 文件级索引应能自动(重)建，
    免手工逐条登记（reindex 子命令；import.py 落地后会自动调它）。

子命令:
  rm       删一个内容页 + 清全库对它的反向链接 + 重建其所在目录索引。
  reindex  扫描一个目录的内容页(*.md，排除 README/_前缀)，在该目录 README 的标记块内重建文件级索引。

用法:
  python3 curate.py rm      --instance <实例根> --page <相对路径.md> [--apply]
  python3 curate.py reindex --instance <实例根> --dir  <相对目录>     [--apply]

默认 **dry-run**（只打计划，不动盘）；加 --apply 才真正改/删。
退出码: 0 成功 / 2 调用错误（路径不对/越界等）。

约束（对齐引擎其它脚本）: 零依赖、CWD 无关（路径全参数化）、坏输入优雅退出不崩、副作用默认 dry-run。
"""
import sys, os, re, glob, argparse

INDEX_START = "<!-- INDEX:START（substrate 自动维护：块内每次 reindex 会被重写，块外内容保留）-->"
INDEX_END = "<!-- INDEX:END -->"


def read_text(p):
    try:
        return open(p, encoding="utf-8-sig", errors="replace").read()
    except Exception:
        return None


def stem_of(p):
    return os.path.splitext(os.path.basename(p))[0]


def link_basename(raw):
    """[[dir/stem.md|alias#anchor]] → 'stem'（与 doctor 的解析口径一致）。"""
    return stem_of(raw.split("|")[0].split("#")[0].strip())


def under_instance(instance, p):
    ri, rp = os.path.realpath(instance), os.path.realpath(p)
    return rp == ri or rp.startswith(ri + os.sep)


def all_mds(root):
    return sorted(glob.glob(root + "/**/*.md", recursive=True))


def title_of(text, fallback):
    m = re.match(r"\s*---\s*\n(.*?)\n---", text or "", re.S)
    if m:
        tm = re.search(r"(?m)^title:[ \t]*(.+?)[ \t]*$", m.group(1))
        if tm:
            return tm.group(1).strip().strip("'\"")
    for line in (text or "").splitlines():
        hm = re.match(r"\s*#{1,6}\s+(.+?)\s*#*\s*$", line)
        if hm:
            return hm.group(1).strip()
    return fallback


# ── reindex ──────────────────────────────────────────────────────────────────

def dir_content_pages(instance, reldir):
    d = os.path.join(instance, reldir)
    out = []
    for p in sorted(glob.glob(d + "/*.md")):
        b = os.path.basename(p)
        if b == "README.md" or b.startswith("_"):
            continue
        out.append(p)
    return out


def build_index_block(instance, reldir):
    pages = dir_content_pages(instance, reldir)
    lines = [INDEX_START, "", "| 文件 | 摘要（自动取标题，可手动改）|", "|------|------|"]
    if not pages:
        lines.append("| _（空）_ | |")
    for p in pages:
        st = stem_of(p)
        ttl = title_of(read_text(p), st).replace("|", "\\|")
        lines.append(f"| [[{st}]] | {ttl} |")
    lines += ["", INDEX_END]
    return "\n".join(lines)


def regen_readme(instance, reldir, apply):
    """(重)建 reldir/README.md 的索引块。返回 (action, n_pages)。"""
    readme = os.path.join(instance, reldir, "README.md")
    block = build_index_block(instance, reldir)
    existing = read_text(readme)
    if existing is None:
        name = os.path.basename(reldir.rstrip("/")) or reldir
        new = (f"# {name} — 索引\n\n"
               f"> 文件级索引由 `substrate-curator reindex` / `substrate-import` 自动维护：\n"
               f"> 标记块内每次重建会覆盖，块外内容（如 Agent Packet、说明）保留。\n\n"
               f"{block}\n")
        action = "新建 README + 索引"
    elif INDEX_START in existing and INDEX_END in existing:
        new = re.sub(re.escape(INDEX_START) + r".*?" + re.escape(INDEX_END), lambda _: block, existing, flags=re.S)
        action = "重建已有索引块"
    else:
        new = existing.rstrip("\n") + "\n\n" + block + "\n"
        action = "追加索引块（保留原 README 内容）"
    n = len(dir_content_pages(instance, reldir))
    if apply:
        os.makedirs(os.path.dirname(readme), exist_ok=True)
        with open(readme, "w", encoding="utf-8") as f:
            f.write(new)
    return action, n


def cmd_reindex(a):
    instance = os.path.abspath(a.instance)
    if not os.path.isdir(instance):
        print(f"curate reindex: --instance 不是目录: {instance}"); return 2
    reldir = a.dir.strip("/")
    target_dir = os.path.abspath(os.path.join(instance, reldir))
    if not under_instance(instance, target_dir):
        print(f"curate reindex: --dir 越出实例根，拒绝: {a.dir}"); return 2
    if not os.path.isdir(target_dir):
        print(f"curate reindex: 目录不存在: {a.dir}"); return 2
    action, n = regen_readme(instance, reldir, a.apply)
    mode = "APPLY" if a.apply else "DRY-RUN"
    print(f"curate reindex  dir={reldir}  mode={mode}")
    print(f"  {action}：登记 {n} 个内容页到 {reldir}/README.md 的索引块")
    if not a.apply:
        print("  → dry-run，未写盘。加 --apply 真正重建索引。")
    return 0


# ── rm（删页 + 清反向链接）─────────────────────────────────────────────────────

def plan_inbound(instance, target_stem, target_path):
    """扫全库，找指向 target_stem 的反向链接。返回 {file: [(lineno, kind)]}，kind ∈ {drop, delink}。
    纯导航条目（列表项/表格行以指向目标的链接开头）→ drop 整行；其余 → delink（去链成纯文本）。"""
    hits = {}
    for f in all_mds(instance):
        if os.path.abspath(f) == os.path.abspath(target_path):
            continue
        text = read_text(f)
        if text is None:
            continue
        edits = []
        for i, line in enumerate(text.split("\n")):
            wl = [w for w in re.findall(r"\[\[([^\]]+)\]\]", line) if link_basename(w) == target_stem]
            if not wl:
                continue
            first = re.search(r"\[\[([^\]]+)\]\]", line)
            leads_target = first is not None and link_basename(first.group(1)) == target_stem
            if leads_target and (re.match(r"\s*[-*+]\s*\[\[", line) or re.match(r"\s*\|\s*\[\[", line)):
                edits.append((i, "drop"))     # 纯导航条目（bullet / 表格行首列）→ 删整行
            else:
                edits.append((i, "delink"))    # 正文内引用 → 去链成纯文本（不破坏句子）
        if edits:
            hits[f] = edits
    return hits


def apply_inbound(instance, target_stem, hits):
    for f, edits in hits.items():
        text = read_text(f)
        if text is None:
            continue
        drop = {i for i, k in edits if k == "drop"}
        delink = {i for i, k in edits if k == "delink"}
        out = []
        for i, line in enumerate(text.split("\n")):
            if i in drop:
                continue
            if i in delink:
                def repl(m):
                    raw = m.group(1)
                    if link_basename(raw) != target_stem:
                        return m.group(0)
                    return (raw.split("|", 1)[1] if "|" in raw else raw.split("#")[0]).strip()
                line = re.sub(r"\[\[([^\]]+)\]\]", repl, line)
            out.append(line)
        with open(f, "w", encoding="utf-8") as fh:
            fh.write("\n".join(out))


def cmd_rm(a):
    instance = os.path.abspath(a.instance)
    if not os.path.isdir(instance):
        print(f"curate rm: --instance 不是目录: {instance}"); return 2
    page = os.path.abspath(os.path.join(instance, a.page))
    if not under_instance(instance, page):
        print(f"curate rm: --page 越出实例根，拒绝: {a.page}"); return 2
    if not os.path.isfile(page):
        print(f"curate rm: 页不存在: {a.page}"); return 2
    if not page.endswith(".md"):
        print(f"curate rm: 只删 .md 内容页: {a.page}"); return 2

    target_stem = stem_of(page)
    reldir = os.path.dirname(os.path.relpath(page, instance)).replace(os.sep, "/")
    hits = plan_inbound(instance, target_stem, page)

    mode = "APPLY" if a.apply else "DRY-RUN"
    print(f"curate rm  page={a.page}  mode={mode}")
    print(f"  删除文件: {os.path.relpath(page, instance)}")
    total = sum(len(v) for v in hits.values())
    if total == 0:
        print("  反向链接: 无（没有别的页链向它，删除无连累）")
    else:
        print(f"  反向链接: {total} 处，分布在 {len(hits)} 个文件——一并清理：")
        for f, edits in sorted(hits.items()):
            rf = os.path.relpath(f, instance)
            drops = sum(1 for _, k in edits if k == "drop")
            delinks = sum(1 for _, k in edits if k == "delink")
            parts = []
            if drops:   parts.append(f"删 {drops} 行(纯导航条目)")
            if delinks: parts.append(f"去链 {delinks} 处(正文引用)")
            print(f"    - {rf}: {'，'.join(parts)}")

    if not a.apply:
        print("  → dry-run，未动盘。确认后加 --apply 执行（删页 + 清链 + 重建该目录索引）。")
        return 0

    apply_inbound(instance, target_stem, hits)
    os.remove(page)
    if reldir and os.path.isdir(os.path.join(instance, reldir)):
        action, n = regen_readme(instance, reldir, True)
        print(f"  已重建目录索引: {reldir}/README.md（{action}，现 {n} 个内容页）")
    print(f"  → 已删 {a.page}，清理 {total} 处反向链接。建议跑 substrate-doctor 复核。")
    return 0


def main(argv):
    ap = argparse.ArgumentParser(prog="curate.py", add_help=True)
    sub = ap.add_subparsers(dest="cmd")

    rm = sub.add_parser("rm", help="删内容页 + 清全库反向链接 + 重建目录索引")
    rm.add_argument("--instance", required=True)
    rm.add_argument("--page", required=True, help="要删的页（相对实例根）")
    rm.add_argument("--apply", action="store_true")

    ri = sub.add_parser("reindex", help="重建一个目录 README 的文件级索引块")
    ri.add_argument("--instance", required=True)
    ri.add_argument("--dir", required=True, help="目标目录（相对实例根）")
    ri.add_argument("--apply", action="store_true")

    if not argv:
        ap.print_help(); return 2
    a = ap.parse_args(argv)
    if a.cmd == "rm":
        return cmd_rm(a)
    if a.cmd == "reindex":
        return cmd_reindex(a)
    ap.print_help(); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
