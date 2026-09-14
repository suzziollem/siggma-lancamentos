import { readFile } from 'node:fs/promises';
import { Executor, planBatch } from './core.mjs';
import { MemoryJournal, Simulator } from './simulator.mjs';

// Deliberately no --execute option: live use requires a trusted authenticated supervisor.
const [mode, input, tenant] = process.argv.slice(2);
try {
  if (!['validate', 'simulate'].includes(mode) || !input || !tenant) {
    throw new Error('Uso: node executor/cli.mjs validate|simulate ARQUIVO.json EMPRESA');
  }
  const text = await readFile(input, 'utf8');
  if (text.length > 1000000) throw new Error('Lote excede 1 MB.');
  const plan = planBatch(JSON.parse(text), tenant);
  if (mode === 'validate') {
    console.log(JSON.stringify({ mode: 'LOCAL_VALIDATION_ONLY', digest: plan.digest,
      quantity: plan.entries.length, totalCents: plan.totalCents, writesToSiggma: 0 }, null, 2));
  } else {
    const adapter = new Simulator();
    const executor = new Executor({ adapter, journal: new MemoryJournal() });
    const result = await executor.run(plan, { tenant, digest: plan.digest, confirmed: true, expiresAt: Date.now() + 60000 });
    console.log(JSON.stringify({ mode: 'SIMULATION_ONLY', writesToSiggma: 0, ...result }, null, 2));
    if (result.status !== 'completed') process.exitCode = 1;
  }
} catch (e) {
  console.error(e.code || 'VALIDATION_FAILED', e.message);
  process.exitCode = 1;
}
