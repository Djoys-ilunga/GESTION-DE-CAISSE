import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CentralAccess, DataError } from '../src/data/central-access';
import type { PrismaService } from '../src/prisma.service';

const context = () => ({ companyId: randomUUID(), userId: randomUUID(), sessionId: randomUUID() });
const serialization = () => ({
  code: 'P2010',
  meta: {
    driverAdapterError: {
      cause: {
        originalCode: '40001',
        originalMessage: 'could not serialize access due to read/write dependencies',
      },
    },
  },
});
const transaction = () => ({
  $executeRaw: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  currencyDefinition: {
    findMany: vi.fn(async () => [
      { code: 'CDF', precision: 2 },
      { code: 'USD', precision: 2 },
    ]),
  },
});
afterEach(() => vi.useRealTimers());
describe('Reprises transactionnelles bornées sans rejouer un conflit métier', () => {
  it('survit à six conflits SQL sérialisables puis exécute une seule action validée', async () => {
    vi.useFakeTimers();
    const tx = transaction();
    let calls = 0;
    const db = {
      $transaction: vi.fn(async (action: (t: unknown) => Promise<unknown>) => {
        if (calls++ < 6) throw serialization();
        return action(tx);
      }),
    };
    const action = vi.fn(async () => ({ validated: true }));
    const pending = new CentralAccess(db as unknown as PrismaService).run(context(), action);
    const checked = expect(pending).resolves.toEqual({ validated: true });
    await vi.runAllTimersAsync();
    await checked;
    expect(db.$transaction).toHaveBeenCalledTimes(7);
    expect(action).toHaveBeenCalledOnce();
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE caissepro_runtime');
  });
  it('s’arrête après neuf essais en cas de conflit SQL persistant', async () => {
    vi.useFakeTimers();
    const db = {
      $transaction: vi.fn(async () => {
        throw serialization();
      }),
    };
    const pending = new CentralAccess(db as unknown as PrismaService).run(context(), vi.fn());
    const checked = expect(pending).rejects.toMatchObject({ code: 'DATA_INTEGRITY_ERROR' });
    await vi.runAllTimersAsync();
    await checked;
    expect(db.$transaction).toHaveBeenCalledTimes(9);
  });
  it('ne rejoue pas un refus métier tel que des fonds insuffisants', async () => {
    const error = new DataError('INSUFFICIENT_FUNDS');
    const db = {
      $transaction: vi.fn(async () => {
        throw error;
      }),
    };
    await expect(
      new CentralAccess(db as unknown as PrismaService).run(context(), vi.fn()),
    ).rejects.toBe(error);
    expect(db.$transaction).toHaveBeenCalledOnce();
  });
});

it('ne confond pas un extrait Prisma mentionnant Serializable avec un conflit SQL', async () => {
  const error = {
    code: 'P2010',
    message: 'prisma.$transaction({isolationLevel: Serializable})',
    meta: {
      driverAdapterError: {
        cause: { originalCode: '23514', originalMessage: 'CAISSEPRO_INSUFFICIENT_FUNDS' },
      },
    },
  };
  const db = {
    $transaction: vi.fn(async () => {
      throw error;
    }),
  };
  await expect(
    new CentralAccess(db as unknown as PrismaService).run(context(), vi.fn()),
  ).rejects.toMatchObject({ code: 'CAISSEPRO_INSUFFICIENT_FUNDS' });
  expect(db.$transaction).toHaveBeenCalledOnce();
});
