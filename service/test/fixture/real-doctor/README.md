# real-doctor fixture

`doctor.py` 与 `curate.py` 原样取自引擎仓库 wheam/substrate 的
`skills/substrate-doctor/doctor.py`、`skills/substrate-curator/curate.py`
（引擎 commit 9f1ff2b3b13025d5864c7172b5945b02c54d1a1a，即 2026-10-18 修复 inbox 图边界后的版本）。

`test/fixture/instance` 里的 doctor/curator 是最小桩；凡是要验证“服务与真实 doctor 的交互”
（增量门禁、凭据规则一致性、互相链接页面整组落库）的测试，用这两份真实脚本替换桩。
引擎升级 doctor 后，同步覆盖这里并跑 `test/secrets-doctor-contract.test.js` 与 `test/keeper-real-doctor.test.js`。
