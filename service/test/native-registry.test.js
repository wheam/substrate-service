import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNativeRegistry } from '../src/native-registry.js';
import { createAdmission, createInbox } from '../src/inbox.js';

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);

function tempState(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `substrate-native-${name}-`));
  return { dir, statePath: path.join(dir, 'state', 'native-registry.json') };
}

test('native registry：set 原子落盘，进程重载后仍能验证，delete 也持久清账', () => {
  const { statePath } = tempState('reload');
  const first = createNativeRegistry({ statePath });

  first.set('entry-a1b2', tokenA);
  first.set('entry-c3d4', tokenB);
  assert.equal(first.size, 2);
  assert.ok(existsSync(statePath));

  const reloaded = createNativeRegistry({ statePath });
  assert.equal(reloaded.degraded, false);
  assert.equal(reloaded.get('entry-a1b2'), tokenA);
  assert.equal(reloaded.get('entry-c3d4'), tokenB);

  assert.equal(reloaded.delete('entry-a1b2'), true);
  const afterDelete = createNativeRegistry({ statePath });
  assert.equal(afterDelete.has('entry-a1b2'), false);
  assert.equal(afterDelete.isConsumed('entry-a1b2'), true, '终态清账须留下 consumed tombstone');
  assert.equal(afterDelete.get('entry-c3d4'), tokenB);
  assert.throws(() => afterDelete.set('entry-a1b2', tokenA), /已消费|复用/, '历史 id 不得重新签发');
});

test('native registry：owner approval 与 native proof 同账持久化，consume 原子销账且可显式回滚', () => {
  const { statePath } = tempState('approval-reload');
  const first = createNativeRegistry({ statePath });
  const approval = { token: tokenB, viaTrust: 'high', viaChannel: 'primary' };
  first.set('entry-approved', tokenA);
  first.approvals.set('entry-approved', approval);

  const restarted = createNativeRegistry({ statePath });
  assert.deepEqual(restarted.approvals.get('entry-approved'), approval, '重启后主人裁定 proof 不得丢失');
  assert.throws(
    () => restarted.consume('entry-approved', tokenA, { ...approval, viaChannel: 'secondary' }),
    /approval.*变化|拒绝消费/,
    '执行快照看到的 approval 与当前记录不一致时不得 claim',
  );
  assert.equal(restarted.get('entry-approved'), tokenA);
  const claimed = restarted.consume('entry-approved', tokenA, approval);
  assert.deepEqual(claimed, { token: tokenA, approval });
  assert.equal(restarted.has('entry-approved'), false);
  assert.equal(restarted.approvals.has('entry-approved'), false);
  assert.equal(restarted.isConsumed('entry-approved'), true);

  const consumedReload = createNativeRegistry({ statePath });
  assert.equal(consumedReload.isConsumed('entry-approved'), true, 'claim 必须先于业务 commit 持久可见');
  consumedReload.restore('entry-approved', claimed.token, claimed.approval);
  const restoredReload = createNativeRegistry({ statePath });
  assert.equal(restoredReload.get('entry-approved'), tokenA);
  assert.deepEqual(restoredReload.approvals.get('entry-approved'), approval);
});

test('native registry：consume 落盘失败完整回滚内存，磁盘旧 proof 也保持 active', () => {
  const { dir, statePath } = tempState('consume-atomic');
  const registry = createNativeRegistry({ statePath });
  const approval = { token: tokenB, viaTrust: 'high', viaChannel: 'primary' };
  registry.set('entry-atomic', tokenA);
  registry.approvals.set('entry-atomic', approval);

  const stateDir = path.dirname(statePath);
  const savedDir = path.join(dir, 'state-saved');
  renameSync(stateDir, savedDir);
  writeFileSync(stateDir, 'blocks persistence directory');

  assert.throws(() => registry.consume('entry-atomic', tokenA), /消费落盘失败|拒绝执行/);
  assert.equal(registry.get('entry-atomic'), tokenA, '内存 native proof 须恢复');
  assert.deepEqual(registry.approvals.get('entry-atomic'), approval, '内存 approval 须与 native 一起恢复');
  assert.equal(registry.isConsumed('entry-atomic'), false);

  const disk = createNativeRegistry({ statePath: path.join(savedDir, path.basename(statePath)) });
  assert.equal(disk.get('entry-atomic'), tokenA, '失败前的磁盘状态仍须是 active');
  assert.deepEqual(disk.approvals.get('entry-atomic'), approval);
});

test('native registry：v1 entries 可读并在首次 mutation 后迁移为 v2', () => {
  const { statePath } = tempState('v1-migrate');
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ version: 1, entries: { 'entry-legacy': tokenA } })}\n`);
  const registry = createNativeRegistry({ statePath });
  assert.equal(registry.get('entry-legacy'), tokenA);
  registry.set('entry-new', tokenB);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.version, 2);
  assert.deepEqual(state.active, { 'entry-legacy': tokenA, 'entry-new': tokenB });
  assert.deepEqual(state.consumed, []);
  assert.deepEqual(state.approvals, {});
});

test('native registry：状态文件损坏时 fail closed，保留原件且拒绝签发新证明', () => {
  const { statePath } = tempState('corrupt');
  const corrupt = '{"version":1,"entries":{"entry-a1b2":"not-a-sha256"}}\n';
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, corrupt);

  const registry = createNativeRegistry({ statePath });
  assert.equal(registry.degraded, true);
  assert.equal(registry.size, 0);
  assert.equal(registry.get('entry-a1b2'), undefined, '损坏账本里的旧条目不得获得 native 身份');
  assert.throws(
    () => registry.set('entry-new', tokenA),
    /已降级|拒绝受理|无法持久证明/,
  );
  assert.equal(readFileSync(statePath, 'utf8'), corrupt, '损坏状态须原样保留供人工检查，不得被空账本覆盖');
});

test('native registry：状态路径不可能落盘时 set 失败并回滚内存，不产生幽灵权限', () => {
  const { dir } = tempState('unwritable');
  const blockingFile = path.join(dir, 'not-a-directory');
  writeFileSync(blockingFile, 'blocks mkdir');
  const statePath = path.join(blockingFile, 'native-registry.json');
  const registry = createNativeRegistry({ statePath });

  assert.throws(
    () => registry.set('entry-a1b2', tokenA),
    /落盘失败|收件未受理/,
  );
  assert.equal(registry.has('entry-a1b2'), false, '持久化失败必须撤销刚写入的内存 token');
  assert.equal(registry.size, 0);
  assert.equal(existsSync(statePath), false);
});

test('inbox 受理原子性：proof 持久化失败时撤销新文件，且不启动 git 同步', () => {
  const { dir } = tempState('inbox-atomic');
  const instanceDir = path.join(dir, 'instance');
  const inboxDir = path.join(instanceDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });

  const blockingFile = path.join(dir, 'not-a-directory');
  writeFileSync(blockingFile, 'blocks mkdir');
  const registry = createNativeRegistry({ statePath: path.join(blockingFile, 'native-registry.json') });
  const writer = {
    commitAndPush() { assert.fail('本地受理失败后不得启动 git 同步'); },
  };
  const inbox = createInbox({ instanceDir, writer, nativeReg: registry });

  assert.throws(
    () => inbox.addEntry({
      kind: 'save', content: '一条普通知识记录', client: 'trusted-test',
      admission: createAdmission({
        identity: { trust: 'high', source: 'test', channel: 'unit' },
        ingress: 'save',
      }),
    }),
    /落盘失败|收件未受理/,
  );
  assert.deepEqual(readdirSync(inboxDir), [], 'proof 失败必须撤销同批新建的 inbox 文件');
  assert.equal(registry.size, 0, 'proof 失败后 registry 内存也必须为空');
});
