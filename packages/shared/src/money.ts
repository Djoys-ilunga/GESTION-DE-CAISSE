import { z } from 'zod';
export const currencySchema = z.enum(['CDF', 'USD']);
export type Currency = z.infer<typeof currencySchema>;
export const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/);
export const positiveAmountSchema = amountSchema.refine((value) => value !== '0.00');
