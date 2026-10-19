#!/usr/bin/env python3
"""substrate-doctor — 防退化体检 + 迁移测试套件（零依赖，python3 标准库）。

用法:  python3 doctor.py [INSTANCE_ROOT]   (默认当前目录)
退出码: 0 = 无 error（可有 warning/advice）; 1 = 有 error; 2 = 调用错误（路径不对）。

设计约束（见引擎 docs/BUILD-PLAN.md §15 P1）:
  - 不假设 PyYAML：frontmatter / zones / registry 用受限子集正则解析。
  - 抽 [[wikilink]] 前先剥离 inline code 与 fenced code block。
  - 孤儿 / frontmatter 检查豁免 governance/* 与 README/索引/分片结构页，
    以及 skills/*（其顶部是 skill-manifest，不是内容页；skill 里的 [[..]] 是示例，不计入内容图）。
  - 对真实数据要 robust：BOM / 非 UTF-8 / 空 CSV / 尾空行 / 重名 / prose 数字都不能误判或崩。
"""
import sys, os, re, glob, csv

REQUIRED_FRONTMATTER = ["title", "created", "updated", "type"]

# 核心摘要护栏：memory/about-owner/_core.md 每条消息都进常驻小抄，须精简（≤ CORE_MAX_CHARS）。
# 分类记忆页全文不进小抄（按需读），故只盯核心、不再按 about-owner 总体积告警。
CORE_MAX_CHARS = 3000
MANIFEST_REQUIRED = ["name", "target_runtimes", "risk_level"]   # 见 schemas/skill-manifest.schema.yaml

# 密钥/凭据扫描（红线「Forbidden：密钥永不进库」的检测层）。
# 与 substrate-import/import.py 的 SENSITIVE_CONTENT 同源、须同步；此处按置信度分两档：
#   ERROR 档 = 高置信「形态类」凭据（真实凭据的固定形态，几乎不误报）→ 报错、拒绝「健康」。
#   WARN  档 = 低置信「标签+值」启发（如 `password: changeme`）→ 仅提醒复核，不误伤正文、不改退出码。
# 扫描豁免 skills/ 子树：那里有检测器本身与文档示例里的 token 形态（会自我误报）。
SECRET_PATTERNS_ERROR = [
    (re.compile(r"BEGIN[ A-Z]*PRIVATE KEY"),                 "PEM 私钥"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                    "AWS access key id"),
    (re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}"),          "Slack token"),
    (re.compile(r"\bgh[pousr]_[0-9A-Za-z]{20,}"),            "GitHub token"),
    (re.compile(r"\bgithub_pat_[0-9A-Za-z_]{20,}"),          "GitHub fine-grained PAT"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),               "Google API key"),
    (re.compile(r"\bsk_live_[0-9A-Za-z]{16,}"),              "Stripe live key"),
    (re.compile(r"\bsk-(?:proj|ant|svcacct)[-_]?[A-Za-z0-9]{16,}"), "OpenAI/Anthropic token"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), "JWT"),
]
SECRET_PATTERNS_WARN = [
    (re.compile(r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|credential)s?\b[\s:=\"']{1,4}[A-Za-z0-9_\-./+]{16,}"),
     "标签词后紧跟高熵串（疑似硬编码凭据，请人工确认）"),
]

errors, warnings, advice = [], [], []
def err(m):  errors.append(m)
def warn(m): warnings.append(m)
def adv(m):  advice.append(m)

def read_text(p):
    try:
        return open(p, encoding="utf-8-sig", errors="replace").read()
    except Exception:
        return None

def strip_indented_code(t):
    """剥 CommonMark 缩进式代码块：以 ≥4 空格或 tab 缩进、且【前有空行或在文首】的连续行块
    （缩进代码块不能打断段落，故必有前导空行；块内允许夹空行）。这样代码示例里的
    [[wikilink]] 不会被误判断链。**保守**：只剥前有空行的缩进块，浅缩进（<4）列表续行或
    无前导空行的缩进行一律保留——宁可漏剥也绝不把真实链接吞掉（避免漏报真断链）。"""
    lines = t.split("\n")
    out, prev_blank, i, n = [], True, 0, len(lines)
    ind = lambda s: s.startswith("    ") or s.startswith("\t")
    while i < n:
        if prev_blank and ind(lines[i]) and lines[i].strip():
            while i < n and ((ind(lines[i]) and lines[i].strip())
                             or (lines[i].strip() == "" and i + 1 < n and ind(lines[i + 1]) and lines[i + 1].strip())):
                i += 1                            # 吃掉缩进代码块整块（含块内空行），不计入输出
            prev_blank = False
            continue
        out.append(lines[i])
        prev_blank = (lines[i].strip() == "")
        i += 1
    return "\n".join(out)

def strip_code(t):
    t = re.sub(r"```.*?```", "", t, flags=re.S)   # fenced blocks (backtick)
    t = re.sub(r"~~~.*?~~~", "", t, flags=re.S)   # fenced blocks (tilde)
    t = strip_indented_code(t)                    # CommonMark 缩进式代码块（≥4 空格/tab，前有空行）
    t = re.sub(r"`[^`]*`", "", t)                 # inline code
    return t

def rel(root, p): return os.path.relpath(p, root)

def under(root, p, top):
    """p 是否在 root 下的 top/ 子树里（或就是 top）。"""
    r = rel(root, p).replace(os.sep, "/")
    return r == top or r.startswith(top + "/")

def is_structural(root, p):
    r = rel(root, p).replace(os.sep, "/")
    if under(root, p, "inbox"): return True   # 隔离收件不是正式内容页，不验内容页 schema/索引
    if os.path.basename(p) == "README.md": return True
    if r == "TODO.md": return True   # 实例根的待办 checklist：无 frontmatter/入链，是结构页（由 substrate-todo 维护）
    if under(root, p, "governance"): return True
    if under(root, p, "skills"): return True   # skill 目录顶部是 manifest，不是内容页（单独 lint，见检查 8）
    if os.path.basename(p).startswith("_"): return True
    if any(seg.startswith("by-") for seg in r.split("/")[:-1]): return True
    return False

def wikilink_targets(text):
    """返回 [(raw_target, name)]，已剥 code、去 alias/#anchor。"""
    out = []
    for raw in re.findall(r"\[\[([^\]]+)\]\]", strip_code(text)):
        tgt = raw.split("|")[0].split("#")[0].strip()
        if tgt: out.append(tgt)
    return out

def frontmatter_keys(text):
    m = re.match(r"\s*---\s*\n(.*?)\n---", text, re.S)   # 容忍前导空白/BOM(读时已去)
    if not m: return None
    return set(re.findall(r"(?m)^([A-Za-z_][\w-]*):", m.group(1)))

def csv_rows(path):
    try:
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
            rows = [r for r in csv.reader(f) if any(c.strip() for c in r)]
        return max(len(rows) - 1, 0)   # 减表头；空文件→0
    except Exception:
        return 0

def main(root):
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        print(f"doctor: 不是目录: {root}"); return 2
    mds = sorted(glob.glob(root + "/**/*.md", recursive=True))
    # 隔离收件不是知识图节点：既不能用未归档链接阻塞全库，也不能充当正式页的
    # 链接目标或入链来掩盖真实断链/孤儿。仍保留在 texts 中接受凭据等安全检查。
    graph_mds = [m for m in mds if not under(root, m, "inbox")]
    allfiles = set(graph_mds)
    texts = {}
    for m in mds:
        try:
            raw = open(m, "rb").read()
        except Exception:
            err(f"无法读取  {rel(root,m)}"); texts[m] = ""; continue
        try:
            texts[m] = raw.decode("utf-8-sig")          # 严格解码：能发现真正的非 UTF-8
        except UnicodeDecodeError:
            warn(f"非 UTF-8 编码（按替换字符解析，可能有乱码）  {rel(root,m)}")
            texts[m] = raw.decode("utf-8-sig", errors="replace")
    base = {}
    for m in graph_mds:
        base.setdefault(os.path.splitext(os.path.basename(m))[0], []).append(m)

    def resolve(tgt):
        """返回命中文件列表。路径式（含 /）必须按路径解析，不退回 basename
        （否则写错路径的链接会被 basename 兜底成功而漏判断链）。"""
        if "/" in tgt:
            cand = os.path.normpath(os.path.join(root, tgt if tgt.endswith(".md") else tgt + ".md"))
            return [cand] if cand in allfiles else []
        return base.get(re.sub(r"\.md$", "", os.path.basename(tgt)), [])

    # 1) 断链 + 入链统计（剥 code；排除自链；重名告警）。
    #    skills/ 里的 [[..]] 是示例/说明，不计入内容图：既不报断链，也不算入链。
    inbound = {m: 0 for m in mds}
    for m in graph_mds:
        if under(root, m, "skills"):
            continue
        for tgt in wikilink_targets(texts[m]):
            hits = resolve(tgt)
            if not hits:
                err(f"断链  {rel(root,m)} -> [[{tgt}]]")
            else:
                if len(hits) > 1:
                    warn(f"重名链接  {rel(root,m)} -> [[{tgt}]] 命中 {len(hits)} 个同名文件（孤儿/断链检测会失真）")
                for x in hits:
                    if x != m: inbound[x] += 1   # 自链不算入链

    # 2) 孤儿（内容页无入链）
    for m in mds:
        if is_structural(root, m): continue
        if inbound[m] == 0:
            err(f"孤儿  {rel(root,m)}（无任何入链 wikilink）")

    # 2b) 互链 ≥2（宪法【建议】：每页宜链到 2 个相关页；剥 code、排除自链；豁免结构页、skills/ 与 todo/）
    #     注：这是【提醒不报错】（WARN，不影响退出码）——保持知识图连通是好习惯，但不强制、不拦路。
    #     删页/加页时不应因此被卡（见 substrate-curator 的 rm：删页会自动清反向链接）。
    #     豁免 todo/：待办是操作性清单、非知识图节点（条目常无可链对象），且模板空页不该让
    #     全新实例开箱即带 WARN（洁净房上手测试的发现）。
    for m in mds:
        if is_structural(root, m) or under(root, m, "skills") or under(root, m, "todo"): continue
        self_stem = os.path.splitext(os.path.basename(m))[0]
        outs = {re.sub(r"\.md$", "", os.path.basename(t)) for t in wikilink_targets(texts[m])}
        outs.discard(self_stem)
        if len(outs) < 2:
            warn(f"互链不足  {rel(root,m)} 只链到 {len(outs)} 个页（建议每页 ≥2 个 [[wikilink]]，仅提醒不报错）")

    # 3) frontmatter 合规（内容页）
    for m in mds:
        if is_structural(root, m): continue
        keys = frontmatter_keys(texts[m])
        if keys is None:
            err(f"frontmatter 缺失  {rel(root,m)}")
        else:
            miss = [k for k in REQUIRED_FRONTMATTER if k not in keys]
            if miss: err(f"frontmatter 缺字段  {rel(root,m)}: {', '.join(miss)}")

    # 4) 索引漂移（同目录有 README.md 时，内容兄弟页须以整词/链接登记在该 README）
    def registered(readme_text):
        names = {re.sub(r"\.md$", "", os.path.basename(t)) for t in wikilink_targets(readme_text)}
        # 整词匹配 .md 路径：尾随 lookahead 排除 page.md.bak 这类子串误判为已登记
        names |= {re.sub(r"\.md$", "", os.path.basename(p))
                  for p in re.findall(r"[\w./-]+\.md(?![\w.])", readme_text)}
        return names
    for m in mds:
        if is_structural(root, m): continue
        readme = os.path.join(os.path.dirname(m), "README.md")
        if os.path.exists(readme):
            bn = os.path.splitext(os.path.basename(m))[0]
            if bn not in registered(texts.get(readme) or read_text(readme) or ""):
                err(f"索引漂移  {rel(root,m)} 未登记在 {rel(root,readme)}")

    # 5) 收藏计数漂移（递归找 data.csv；只校验与 data.csv **同目录**的索引页粗体计数 == 主表行数。
    #    分类分片在 by-*/ 子目录里，天然是子集，不与主表总数比——避免对多类别分片误报。）
    for csvf in glob.glob(root + "/collections/**/data.csv", recursive=True):
        n = csv_rows(csvf)
        cdir = os.path.dirname(csvf)
        for page in glob.glob(cdir + "/*.md"):
            for claimed in re.findall(r"\*\*\s*(\d+)\s*\*\*\s*(?:条|rows|entries)", texts.get(page) or read_text(page) or ""):
                if int(claimed) != n:
                    err(f"计数漂移  {rel(root,page)} 声称 {claimed}，但 {rel(root,csvf)} 有 {n} 行")

    # 5b) zones 契约校验（schema 必填字段在场 + id 唯一 + path 存在）——doctor 解析治理契约，不空过。
    zones_f = os.path.join(root, "governance", "zones.md")
    if os.path.isfile(zones_f):
        zt = read_text(zones_f) or ""
        ym = re.search(r"```yaml\n(.*?)```", zt, re.S)
        zblock = ym.group(1) if ym else ""
        seen_ids = set()
        zchunks = re.split(r"(?m)^\s*-\s+id:", zblock)[1:]
        if ym and zblock.strip() and not zchunks:
            warn(f"zones 契约: governance/zones.md 有 yaml 块但解析不出任何 zone 条目"
                 f"（疑似 `- id:` 形态被改坏；doctor 可能在静默漏检本该校验的 zone）  ({rel(root,zones_f)})")
        for chunk in zchunks:
            zid = chunk.splitlines()[0].strip().strip("'\"")
            present = set(re.findall(r"(?m)^\s*([A-Za-z_][\w-]*)\s*:", chunk)) | {"id"}
            if not zid:
                err(f"zones 契约: 有 zone 条目缺 id 值  ({rel(root,zones_f)})"); continue
            if zid in seen_ids:
                err(f"zones 契约: zone id 重复  {zid}  ({rel(root,zones_f)})")
            seen_ids.add(zid)
            miss = [k for k in ("path", "schema", "maintainer_skill", "readers", "writers") if k not in present]
            if miss:
                err(f"zones 契约: zone '{zid}' 缺必填字段 {', '.join(miss)}  ({rel(root,zones_f)})")
            # 枚举校验（仅当字段在场）：disposition 只能 canonical/reference——别和 admission 的页级
            # 四去向（local-only/forbidden）混淆（schema 注释专门警告过这一点）；privacy 限四值。
            dm = re.search(r"(?m)^\s*disposition:\s*(\S+)", chunk)
            if dm and dm.group(1).strip("'\"") not in ("canonical", "reference"):
                err(f"zones 契约: zone '{zid}' 的 disposition '{dm.group(1).strip()}' 非法"
                    f"（只能 canonical/reference；local-only/forbidden 是 admission 页级去向，不是 zone 存储取向）  ({rel(root,zones_f)})")
            prm = re.search(r"(?m)^\s*privacy:\s*(\S+)", chunk)
            if prm and prm.group(1).strip("'\"") not in ("public", "internal", "private", "sensitive"):
                err(f"zones 契约: zone '{zid}' 的 privacy '{prm.group(1).strip()}' 非法（只能 public/internal/private/sensitive）  ({rel(root,zones_f)})")
            pm = re.search(r"(?m)^\s*path:\s*(\S+)", chunk)
            if pm and not os.path.isdir(os.path.join(root, pm.group(1).strip("'\"").rstrip("/"))):
                warn(f"zones 契约: zone '{zid}' 的 path '{pm.group(1)}' 在实例里不存在  ({rel(root,zones_f)})")
            # maintainer_skill 值消费（抓 typo / 漏 vendor）：自包含实例（skills/ 下有 vendored
            # substrate-*）里，声明的维护 skill 应真实存在于 skills/<名>/ 或登记在 _registry.md。
            # 非自包含形态（如引擎内示例——维护工具在引擎侧）没有本地全集，跳过不猜。
            msm = re.search(r"(?m)^\s*maintainer_skill:\s*(\S+)", chunk)
            if msm and glob.glob(os.path.join(root, "skills", "substrate-*")):
                mskill = msm.group(1).strip("'\"")
                reg_txt = read_text(os.path.join(root, "skills", "_registry.md")) or ""
                in_registry = re.search(r"(?m)^\s*-?\s*name:\s*['\"]?" + re.escape(mskill) + r"['\"]?\s*$", reg_txt)
                if not os.path.isdir(os.path.join(root, "skills", mskill)) and not in_registry:
                    warn(f"zones 契约: zone '{zid}' 的 maintainer_skill '{mskill}' 在 skills/ 与 _registry 里都不存在（typo？没 vendor？）  ({rel(root,zones_f)})")

    # 6) registry pin（缺 pin = ERROR；pin 是 main/master/HEAD 这类移动 ref 却未声明 trusted_floating=ERROR→WARN）
    reg = os.path.join(root, "skills", "_registry.md")
    if os.path.isfile(reg):
        m = re.search(r"```yaml\n(.*?)```", read_text(reg) or "", re.S)
        block = "\n".join(l for l in (m.group(1) if m else "").splitlines() if not l.lstrip().startswith("#"))
        for chunk in re.split(r"(?m)^\s*-\s+name:", block)[1:]:
            name = chunk.splitlines()[0].strip()
            kindm = re.search(r"(?m)^\s*kind:\s*(\S+)", chunk)
            kind = (kindm.group(1).strip("'\"") if kindm else "git")
            # 契约必填：target_runtimes（声明给哪些 runtime）。缺它 sync 会 fail-closed 静默跳过不装——
            # 这里 WARN 把「悄悄失效」显形（与 skill-manifest 的 required 校验对称）。
            if not re.search(r"(?m)^\s*target_runtimes\s*:", chunk):
                warn(f"registry 条目缺 target_runtimes（必填；缺它 sync 会静默跳过不装该 skill）: {rel(root,reg)} 条目 {name}")
            if kind == "plugin":
                # 插件机制管理：不 clone、无 pin。只要求登记了 source。
                if not re.search(r"(?m)^\s*source:\s*\S", chunk):
                    err(f"registry kind=plugin 缺 source（无法标识插件来源）: {rel(root,reg)} 条目 {name}")
                continue
            if "upstream_git_url" not in chunk:
                continue
            pinm = re.search(r"(?m)^\s*pin:\s*(\S+)", chunk)
            if not pinm:
                err(f"registry 缺 pin（裸追上游有供应链风险）: {rel(root,reg)} 条目 {name}")
            elif pinm.group(1).strip("'\"").lower() in ("main", "master", "head") \
                    and not re.search(r"(?m)^\s*trusted_floating:\s*true", chunk):
                warn(f"registry pin 追踪移动 ref（{pinm.group(1)}）却未声明 trusted_floating: true: {rel(root,reg)} 条目 {name}")

    # 7) 毕业阈值（advisory，按 zone 条目解析，id 与阈值同源；容忍 rows>N / rows > N）
    zones = os.path.join(root, "governance", "zones.md")
    if os.path.isfile(zones):
        m = re.search(r"```yaml\n(.*?)```", read_text(zones) or "", re.S)
        for chunk in re.split(r"(?m)^\s*-\s+id:", (m.group(1) if m else ""))[1:]:
            zid = chunk.splitlines()[0].strip()
            gm = re.search(r"graduation:.*?rows\s*>\s*(\d+)", chunk)
            if not gm: continue
            thr = int(gm.group(1))
            pm = re.search(r"(?m)^\s*path:\s*(\S+)", chunk)
            zpath = (pm.group(1).rstrip("/") if pm else zid)
            for csvf in glob.glob(os.path.join(root, zpath, "**", "data.csv"), recursive=True):
                n = csv_rows(csvf)
                if n > thr:
                    adv(f"毕业建议  {rel(root,csvf)} 有 {n} 行 > 阈值 {thr}（zone {zid}）：考虑分片/迁移")

    # 8) skills/ 清单 lint（WARN）：committed own-skill 的 SKILL.md 应是合规 manifest（见 skill-manifest.schema）。
    #    只 lint 一层 skills/<name>/SKILL.md；_前缀目录（_incoming 等）由 substrate-intake 守门，不在此 lint。
    for sk in sorted(glob.glob(root + "/skills/*/SKILL.md")):
        if os.path.basename(os.path.dirname(sk)).startswith("_"):
            continue
        keys = frontmatter_keys(texts.get(sk) or read_text(sk) or "")
        if keys is None:
            warn(f"skill 缺 manifest frontmatter  {rel(root,sk)}（见 skill-manifest.schema）")
        else:
            miss = [k for k in MANIFEST_REQUIRED if k not in keys]
            if miss: warn(f"skill manifest 缺字段  {rel(root,sk)}: {', '.join(miss)}")
            if "description" not in keys:
                warn(f"skill 缺 description  {rel(root,sk)}（agent 靠 description 匹配用户意图来触发；缺它可能识别不到这个 skill）")

    # 9) 密钥/凭据扫描（红线「密钥永不进库」的检测层）。豁免 skills/（含检测器自身与文档示例的 token 形态）。
    #    privacy: sensitive 的 zone（如 memory/）命中时额外标注——那里泄漏代价最大。
    sensitive_paths = []
    if os.path.isfile(zones_f):
        for chunk in re.split(r"(?m)^\s*-\s+id:", zblock)[1:]:
            if re.search(r"(?m)^\s*privacy:\s*sensitive\b", chunk):
                pm = re.search(r"(?m)^\s*path:\s*(\S+)", chunk)
                if pm: sensitive_paths.append(pm.group(1).strip("'\"").rstrip("/"))
    in_sensitive = lambda p: any(under(root, p, sp) for sp in sensitive_paths)
    for m in mds:
        if under(root, m, "skills"):
            continue
        t = texts.get(m) or ""
        note = "（sensitive zone，泄漏代价最大）" if in_sensitive(m) else ""
        hit = next(((lab) for pat, lab in SECRET_PATTERNS_ERROR if pat.search(t)), None)
        if hit:
            err(f"疑似密钥/凭据  {rel(root,m)}：命中「{hit}」形态{note}——密钥永不进库，请移除并改存引用")
            continue   # 已报 ERROR，不再对同文件叠加 WARN
        whit = next(((lab) for pat, lab in SECRET_PATTERNS_WARN if pat.search(t)), None)
        if whit:
            warn(f"疑似凭据  {rel(root,m)}：{whit}{note}")

    # 10) 引擎版本错位（execution plane vs data plane）：vendored skill 的引擎版本 vs 实例 schema 版本。
    #     不一致 = --refresh 了 skill 却没 migrate（或反之），可能按错格式写。WARN（不拦路，提示对齐）。
    #     仅当两个标记都在才比（examples/minimal、template 等非 init 产物无 .engine-version 标记 → 跳过）。
    sv = read_text(os.path.join(root, "governance", "SUBSTRATE_VERSION"))
    ev = read_text(os.path.join(root, "skills", ".engine-version"))
    if sv is not None and ev is not None:
        sv, ev = sv.strip(), ev.strip()
        if sv and ev and sv != ev:
            warn(f"引擎版本错位  vendored skill 来自引擎 {ev}，但实例 schema 是 {sv}（governance/SUBSTRATE_VERSION）"
                 f"——可能 --refresh 了 skill 却没 migrate（或反之）。跑 init-instance.sh --refresh + substrate-migrate 对齐。")

    # 11) fleet 契约（若有 fleet/README.md 的 devices 块，见其 Agent Packet）：
    #     全 fleet 至多一台 migration_leader（>1 = ERROR：多 leader 各自迁移会撕裂版本）；
    #     ≥2 台 device 却无 leader = WARN（跨版本升级没有专责机）；device 缺 role = WARN。
    fleet_f = os.path.join(root, "fleet", "README.md")
    if os.path.isfile(fleet_f):
        ft = read_text(fleet_f) or ""
        fmm = re.search(r"```yaml\n(.*?)```", ft, re.S)
        fblock = "\n".join(l for l in (fmm.group(1) if fmm else "").splitlines() if not l.lstrip().startswith("#"))
        dchunks = re.split(r"(?m)^\s*-\s+id:", fblock)[1:]
        leaders = 0
        for ch in dchunks:
            did = ch.splitlines()[0].strip().strip("'\"")
            if re.search(r"(?m)^\s*migration_leader:\s*true\b", ch):
                leaders += 1
            if not re.search(r"(?m)^\s*role:\s*\S", ch):
                warn(f"fleet: device '{did or '?'}' 缺 role（建议 main-dev/headless-dev/migration_leader/read-only）  ({rel(root,fleet_f)})")
        if leaders > 1:
            err(f"fleet: {leaders} 台标 migration_leader: true，但全 fleet 至多一台（多 leader 会各自迁移、撕裂版本）  ({rel(root,fleet_f)})")
        elif len(dchunks) >= 2 and leaders == 0:
            warn(f"fleet: 有 {len(dchunks)} 台 device 但无 migration_leader——跨版本迁移没有专责机（建议指定一台）  ({rel(root,fleet_f)})")

    # 12) 核心摘要护栏：常驻小抄（substrate-runtime-context）只把 _core.md 整段灌进每条消息，
    #     分类记忆页只进「记忆目录」、正文按需读。故只盯 _core.md 别超量；缺核心则提示生成。
    ao_dir = os.path.join("memory", "about-owner")
    core_p = os.path.join(root, "memory", "about-owner", "_core.md")
    core_t = texts.get(core_p)
    if core_t is None:
        core_t = read_text(core_p)
    if core_t is not None:
        body = re.sub(r"\s*---\s*\n.*?\n---[ \t]*\n?", "", core_t, count=1, flags=re.S)
        if len(body) > CORE_MAX_CHARS:
            warn(f"核心摘要偏大  memory/about-owner/_core.md 正文 {len(body)} 字符（>{CORE_MAX_CHARS}）"
                 f"——它每条消息都进常驻小抄，请精简、把细节下沉到分类记忆页（substrate-memory）")
    else:
        has_pages = any(under(root, m, ao_dir)
                        and os.path.basename(m).lower() != "readme.md"
                        and not os.path.basename(m).startswith("_")
                        for m in mds)
        if has_pages:
            adv("memory/about-owner 有分类记忆页但缺 _core.md 核心摘要"
                "——跑 substrate-memory 蒸馏一份，常驻小抄才有「always 进」的核心（其余页按需读）")

    print(f"substrate-doctor: {os.path.basename(root)}  ({len(mds)} md 文件)")
    for tag, items in (("ERROR", errors), ("WARN", warnings), ("ADVICE", advice)):
        for it in items: print(f"  [{tag}] {it}")
    print(f"  → {len(errors)} error, {len(warnings)} warn, {len(advice)} advice")
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
