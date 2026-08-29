import { createAdmission } from '../../src/inbox.js';

const INGRESS_BY_KIND = {
  save: 'save',
  todo: 'todo_add',
  collection: 'collections_upsert',
  memory: 'remember',
  remove: 'remove',
  todo_done: 'todo_done',
  capture: 'capture',
  schema: 'schema_propose',
  skill: 'promote_skill',
};

// 测试必须显式铸 AdmissionContext；生产缺身份时零权限，不能为了旧测试给 createInbox 隐式 high。
export function testAdmissionForKind({ kind }) {
  if (kind === 'core') {
    return createAdmission({
      identity: { trust: 'system', source: 'test', channel: 'internal' },
      ingress: 'core_calibration', kind,
    });
  }
  return createAdmission({
    identity: { trust: 'high', source: 'test', channel: 'primary' },
    ingress: INGRESS_BY_KIND[kind] ?? kind,
    kind,
  });
}

export const ALL_TEST_CAPABILITIES = [
  'page:create', 'page:append', 'target:explicit', 'zone:sensitive-write',
  'todo:add', 'todo:complete', 'collection:insert', 'collection:upsert', 'page:remove',
  'skill:stage', 'skill:replace', 'skill:propose', 'schema:propose', 'core:propose',
];

// validateDecision 是 fail-closed 的 effect policy；直接单测若要穿过权限层去测路径/tier
// 等其它分支，也必须显式给 capability，不设“测试环境默认 high”后门。
export function testAuthorizedEntry(entry = {}, capabilities = ALL_TEST_CAPABILITIES) {
  return { ...entry, __native: true, __capabilities: [...capabilities] };
}
