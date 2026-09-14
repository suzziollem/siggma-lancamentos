import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor, planBatch, Stop } from '../core.mjs';
import { MemoryJournal, Simulator } from '../simulator.mjs';
import { FileJournal } from '../journal.mjs';
import { BrowserAdapter, moneyForFilter, moneyFromUi } from '../browser-adapter.mjs';

const raw = (changes = {}) => ({ direction: 'payable', partyCode: '90001', titleTableCode: '90011', costCenterCode: '90021',
  amount: 12.34, baseDate: '2030-02-01', status: 'paid', settlementTableCode: '22', ...changes });
const payload = (...entries) => ({ schema: 'siggma-batch-v1', entries: entries.length ? entries : [raw()] });
const setup = (entries) => {
  const plan = planBatch(entries || payload(), 'TEST-ONLY');
  const adapter = new Simulator(); const journal = new MemoryJournal();
  const executor = new Executor({ adapter, journal });
  const approval = { digest: plan.digest, tenant: plan.tenant, confirmed: true, expiresAt: Date.now() + 60000 };
  return { plan, adapter, journal, executor, approval };
};
for (const [label, changes, expected] of [
  ['recebimento', { direction: 'receivable' }, 'PAYABLE_ONLY'],
  ['valor zero', { amount: 0 }, 'INVALID_AMOUNT'],
  ['valor negativo', { amount: -1 }, 'INVALID_AMOUNT'],
  ['NaN', { amount: NaN }, 'INVALID_AMOUNT'],
  ['valor infinito', { amount: Infinity }, 'INVALID_AMOUNT'],
  ['três casas decimais', { amount: 1.234 }, 'INVALID_AMOUNT'],
  ['valor textual', { amount: '1,00' }, 'INVALID_AMOUNT'],
  ['data inexistente', { baseDate: '2030-02-30' }, 'INVALID_DATE'],
  ['data ambígua', { baseDate: '01/02/2030' }, 'INVALID_DATE'],
  ['tabela de baixa incorreta', { settlementTableCode: '53' }, 'SETTLEMENT_TABLE'],
  ['código inválido', { partyCode: '90001 OR 1' }, 'INVALID_CODE'],
  ['exceção não interpretada', { exception: 'usar outra tabela' }, 'EXCEPTION_REVIEW'],
  ['banco não homologado', { bankCode: '9' }, 'UNSUPPORTED_FIELD'],
  ['situação desconhecida', { status: 'maybe' }, 'INVALID_STATUS']
]) test(`validação bloqueia ${label}`, () => assert.throws(() => planBatch(payload(raw(changes)), 'TEST-ONLY'), { code: expected }));

test('aceita campos opcionais vazios, sem nomes', () => {
  const p = planBatch(payload(raw({ partyCode: '', costCenterCode: '', historyText: '' })), 'TEST-ONLY');
  assert.equal(p.entries[0].partyCode, null); assert.equal(p.entries[0].costCenterCode, null);
});
test('nome, atalho e status não contornam duplicidade', () => {
  assert.throws(() => planBatch(payload(raw(), raw({ shortcut: 'outro', partyName: 'OUTRO', status: 'pending' })), 'TEST-ONLY'), { code: 'DUPLICATE_IN_BATCH' });
});
test('hash é estável entre exportações e separa empresas', () => {
  const p = payload(); const a = planBatch(p, 'TEST-ONLY');
  assert.equal(a.digest, planBatch({ ...p, exportedAt: 'different' }, 'TEST-ONLY').digest);
  assert.notEqual(a.entries[0].key, planBatch(p, 'OTHER-TEST').entries[0].key);
  assert.equal(Object.isFrozen(a.entries[0]), true);
});
test('prévia não grava nem liquida', async () => {
  const s = setup(); const p = await s.executor.preview(s.plan);
  assert.equal(p.quantity, 1); assert.deepEqual(p.checks[0].candidateIds, []);
  assert.equal(s.adapter.titles.size, 0);
});
test('salva antes de baixar, preserva título e tabela 22', async () => {
  const s = setup(); const r = await s.executor.run(s.plan, s.approval);
  assert.equal(r.status, 'completed');
  assert.deepEqual(s.adapter.events.filter(x => x !== 'context'), ['save-title', 'settle-22']);
  assert.equal([...s.adapter.titles.values()][0].titleTableCode, '90011');
  assert.equal([...s.adapter.settlements.values()][0].tableCode, '22');
});
test('pendente não recebe baixa', async () => {
  const s = setup(payload(raw({ status: 'pending' })));
  assert.equal((await s.executor.run(s.plan, s.approval)).status, 'completed');
  assert.equal(s.adapter.settlements.size, 0);
});
test('reexecução usa diário sem duplicar', async () => {
  const s = setup(); await s.executor.run(s.plan, s.approval);
  const r = await s.executor.run(s.plan, s.approval);
  assert.equal(r.status, 'completed'); assert.equal(r.completed[0].alreadyDone, true);
  assert.equal(s.adapter.titles.size, 1); assert.equal(s.adapter.settlements.size, 1);
});
for (const change of [{ confirmed: false }, { digest: 'changed' }, { tenant: 'OTHER-TEST' }, { expiresAt: 0 }]) {
  test(`aprovação inválida: ${JSON.stringify(change)}`, async () => {
    const s = setup(); await assert.rejects(s.executor.run(s.plan, { ...s.approval, ...change }), { code: 'APPROVAL_REQUIRED' });
    assert.equal(s.adapter.titles.size, 0);
  });
}
test('duplicidade no último item bloqueia lote inteiro antes de gravar', async () => {
  const s = setup(payload(raw(), raw({ partyCode: '90002', amount: 2 })));
  await s.adapter.createTitle(s.plan.entries[1]);
  const r = await s.executor.run(s.plan, s.approval);
  assert.equal(r.reason, 'POSSIBLE_DUPLICATE'); assert.equal(s.adapter.titles.size, 1);
});
test('paginação não verificada bloqueia', async () => {
  const s = setup(); s.adapter.findCandidates = async () => ({ complete: false, titles: [] });
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'INCOMPLETE_SEARCH');
});
test('falha depois de salvar não permite segunda tentativa', async () => {
  const s = setup(); const create = s.adapter.createTitle.bind(s.adapter);
  s.adapter.createTitle = async e => { await create(e); throw new Error('response lost'); };
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'UNEXPECTED_ERROR');
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'RECONCILIATION_REQUIRED');
  assert.equal(s.adapter.titles.size, 1);
});
test('falha depois de liquidar não permite segunda baixa', async () => {
  const s = setup(); const settle = s.adapter.settleTitle.bind(s.adapter);
  s.adapter.settleTitle = async (id, e) => { await settle(id, e); throw new Error('response lost'); };
  await s.executor.run(s.plan, s.approval);
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'RECONCILIATION_REQUIRED');
  assert.equal(s.adapter.settlements.size, 1);
});
test('mudança no cadastro não é considerada concluída', async () => {
  const s = setup(); const create = s.adapter.createTitle.bind(s.adapter);
  s.adapter.createTitle = async e => ({ ...await create(e), costCenterCode: '99999' });
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'TITLE_MISMATCH');
  assert.equal(s.adapter.settlements.size, 0);
});
test('baixa direta é bloqueada sem estorno automático', async () => {
  const s = setup(); const create = s.adapter.createTitle.bind(s.adapter);
  s.adapter.createTitle = async e => ({ ...await create(e), paidCents: e.amountCents, balanceCents: 0 });
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'DIRECT_SETTLEMENT');
  assert.equal(s.adapter.settlements.size, 0);
});
test('baixa em tabela errada não é reportada como sucesso', async () => {
  const s = setup(); const settle = s.adapter.settleTitle.bind(s.adapter);
  s.adapter.settleTitle = async (id, e) => ({ ...await settle(id, e), tableCode: '90011' });
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'SETTLEMENT_MISMATCH');
});
test('cancelamento após salvar permite retomar somente a baixa', async () => {
  const s = setup(); const controller = new AbortController();
  s.executor.onProgress = x => { if (x.stage === 'TITLE_VERIFIED') controller.abort(); };
  assert.equal((await s.executor.run(s.plan, s.approval, { signal: controller.signal })).reason, 'CANCELLED');
  s.executor.onProgress = () => {};
  assert.equal((await s.executor.run(s.plan, s.approval)).status, 'completed');
  assert.equal(s.adapter.titles.size, 1);
});
test('sessão expirada interrompe sem gravar', async () => {
  const s = setup(); s.adapter.assertContext = async () => { throw new Stop('AUTH_REQUIRED', 'login'); };
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'AUTH_REQUIRED');
  assert.equal(s.adapter.titles.size, 0);
});
test('diário registra tentativa antes da gravação', async () => {
  const s = setup(); const create = s.adapter.createTitle.bind(s.adapter);
  s.adapter.createTitle = async e => { assert.equal((await s.journal.get(e.key)).state, 'TITLE_ATTEMPT'); return create(e); };
  assert.equal((await s.executor.run(s.plan, s.approval)).status, 'completed');
});
test('diário indisponível impede gravação', async () => {
  const s = setup(); s.journal.put = async () => { throw new Error('disk full'); };
  assert.equal((await s.executor.run(s.plan, s.approval)).reason, 'UNEXPECTED_ERROR');
  assert.equal(s.adapter.titles.size, 0);
});
test('diário em disco persiste, trava e restringe permissões', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'siggma-test-'));
  const a = new FileJournal(dir, 'TEST-ONLY'), b = new FileJournal(dir, 'TEST-ONLY');
  await a.acquire(); await assert.rejects(b.acquire(), { code: 'BUSY' });
  await a.put('a'.repeat(64), { state: 'DONE', titleId: '900001' });
  await a.release(); await b.acquire();
  assert.equal((await b.get('a'.repeat(64))).titleId, '900001');
  assert.equal((await stat(b.path)).mode & 0o777, 0o600); await b.release();
});
test('adaptador real fica bloqueado por padrão', () => {
  const a = new BrowserAdapter({ playwright: { locator: () => ({}) } },
    { tenant: 'TEST-ONLY', visibleTenantMarkers: ['TEST COMPANY', 'TEST BRANCH'] });
  assert.throws(() => a.writable(), { code: 'HOMOLOGATION_REQUIRED' });
});
test('valores da interface aceitam formatos da grade e da liquidação', () => {
  assert.equal(moneyFromUi('1.557,27'), 155727);
  assert.equal(moneyFromUi('1.00'), 100);
  assert.equal(moneyFromUi('0,00'), 0);
  assert.equal(moneyForFilter(123), '1.23');
});
test('atalho Baixar título não aparece em ações do adaptador', async () => {
  const code = await readFile(new URL('../browser-adapter.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /locator\(['"]#btnBaixarTitulo['"]\)/);
  assert.doesNotMatch(code, /fetch\(|\.request\.|\.evaluate\(/);
});
