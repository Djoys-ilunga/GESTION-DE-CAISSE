import { currencyPrecision, registerCurrencyDefinitions } from '@caissepro/shared';
import type { Prisma } from '../generated/prisma/client';

export function moneyText(amount: Prisma.Decimal, currency: string): string {
  return amount.toFixed(currencyPrecision(currency));
}
export async function loadCurrencyMetadata(tx: Prisma.TransactionClient) {
  const currencies = await tx.currencyDefinition.findMany({
    select: { code: true, precision: true },
  });
  registerCurrencyDefinitions(currencies);
}
