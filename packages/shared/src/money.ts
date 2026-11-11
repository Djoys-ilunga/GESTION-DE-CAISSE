import { z } from 'zod';
import { INITIAL_CURRENCY_CATALOG } from './currency-catalog.js';
export { INITIAL_CURRENCY_CATALOG } from './currency-catalog.js';
// Codes are identifiers; the server catalog and company activation are authoritative.
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export type Currency = z.infer<typeof currencySchema>;
export const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/);
export const positiveAmountSchema = amountSchema.refine((value) => /[1-9]/.test(value));
export const monetaryDecimalSchema = z
  .string()
  .max(128)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/);
export const monetaryLocaleSchema = z.enum(['fr-FR', 'fr-CD', 'en-US', 'en-GB']);

export function validCurrencyAmount(value: string, precision: number, positive = true): boolean {
  if (
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 4 ||
    !amountSchema.safeParse(value).success
  )
    return false;
  const decimals = value.split('.')[1];
  return (
    (precision === 0 ? decimals === undefined : decimals?.length === precision) &&
    (!positive || /[1-9]/.test(value))
  );
}

// Formatting never passes the monetary value through IEEE-754 Number.
export function formatMonetary(value: string, locale = 'fr-FR'): string {
  if (!monetaryDecimalSchema.safeParse(value).success) return value;
  const [whole, fraction] = value.split('.');
  const negative = whole!.startsWith('-');
  const absolute = BigInt(negative ? whole!.slice(1) : whole!);
  const formatter = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
  const decimal =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ??
    '.';
  return (
    (negative ? '-' : '') +
    formatter.format(absolute) +
    (fraction === undefined ? '' : decimal + fraction)
  );
}

export const currencyDefinitionSchema = z
  .object({
    code: currencySchema,
    name: z.string(),
    symbol: z.string(),
    numericCode: z.string().regex(/^\d{3}$/),
    precision: z.number().int().min(0).max(4),
    active: z.boolean(),
    bccRateStatus: z.enum(['UNVERIFIED', 'AVAILABLE', 'UNAVAILABLE']),
    sourceDate: z.string(),
  })
  .strict();
export type CurrencyDefinition = z.infer<typeof currencyDefinitionSchema>;
const precisions = new Map<string, number>(
  INITIAL_CURRENCY_CATALOG.map((c) => [c.code, c.precision]),
);
export function registerCurrencyDefinitions(
  catalog: readonly Pick<CurrencyDefinition, 'code' | 'precision'>[],
) {
  for (const currency of catalog) {
    if (
      !currencySchema.safeParse(currency.code).success ||
      !Number.isInteger(currency.precision) ||
      currency.precision < 0 ||
      currency.precision > 4
    )
      throw new Error('CURRENCY_METADATA_INVALID');
    const previous = precisions.get(currency.code);
    if (previous !== undefined && previous !== currency.precision)
      throw new Error('CURRENCY_PRECISION_IMMUTABLE');
    precisions.set(currency.code, currency.precision);
  }
}
export function currencyPrecision(code: string): number {
  const precision = precisions.get(code);
  if (precision === undefined) throw new Error('CURRENCY_METADATA_REQUIRED');
  return precision;
}
export const moneyPreferenceInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    displayCurrency: currencySchema.nullable(),
    favoriteCurrency: currencySchema.nullable(),
    locale: monetaryLocaleSchema,
  })
  .strict();
export type MoneyPreferenceInput = z.infer<typeof moneyPreferenceInputSchema>;
export const moneyPreferenceSchema = moneyPreferenceInputSchema
  .omit({ expectedVersion: true })
  .extend({ version: z.number().int().nonnegative() })
  .strict();
export type MoneyPreference = z.infer<typeof moneyPreferenceSchema>;
export const companyCurrencyInputSchema = z
  .object({
    code: currencySchema,
    active: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
    confirmed: z.literal(true),
  })
  .strict();
export const reportingCurrencyInputSchema = z
  .object({
    currency: currencySchema.nullable(),
    expectedVersion: z.number().int().nonnegative(),
    confirmed: z.literal(true),
  })
  .strict();
export const moneyContextSchema = z
  .object({
    currencies: z.array(currencyDefinitionSchema).max(300),
    companyCurrencies: z
      .array(
        z
          .object({
            code: currencySchema,
            active: z.boolean(),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(300),
    preferences: moneyPreferenceSchema,
    reporting: z
      .object({ currency: currencySchema.nullable(), version: z.number().int().nonnegative() })
      .strict(),
    generatedAt: z.iso.datetime(),
  })
  .strict();
export type MoneyContext = z.infer<typeof moneyContextSchema>;
