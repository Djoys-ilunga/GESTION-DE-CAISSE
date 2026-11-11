import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  moneyContextSchema,
  moneyPreferenceInputSchema,
  companyCurrencyInputSchema,
  reportingCurrencyInputSchema,
} from '@caissepro/shared';
import { CentralAccess, DataError, type DataContext, type Tx } from '../data/central-access';
import { AuthService, type Principal } from '../auth/auth.service';
@Injectable()
export class MoneyService {
  constructor(
    @Inject(CentralAccess) private readonly access: CentralAccess,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  private async view(tx: Tx, ctx: DataContext) {
    const [currencies, companyCurrencies, preference, settings] = await Promise.all([
      tx.currencyDefinition.findMany({ orderBy: { code: 'asc' } }),
      tx.companyCurrency.findMany({
        where: { companyId: ctx.companyId },
        select: { code: true, active: true, version: true },
        orderBy: { code: 'asc' },
      }),
      tx.userMoneyPreference.findUnique({
        where: { companyId_userId: { companyId: ctx.companyId, userId: ctx.userId } },
      }),
      tx.companyMonetarySettings.findUnique({ where: { companyId: ctx.companyId } }),
    ]);
    return moneyContextSchema.parse({
      currencies,
      companyCurrencies,
      preferences: preference
        ? {
            displayCurrency: preference.displayCurrency,
            favoriteCurrency: preference.favoriteCurrency,
            locale: preference.locale,
            version: preference.version,
          }
        : { displayCurrency: null, favoriteCurrency: null, locale: 'fr-FR', version: 0 },
      reporting: { currency: settings?.reportingCurrency ?? null, version: settings?.version ?? 0 },
      generatedAt: new Date().toISOString(),
    });
  }
  context(ctx: DataContext) {
    return this.access.run(ctx, (tx) => this.view(tx, ctx));
  }
  preferences(ctx: DataContext, raw: unknown) {
    const { expectedVersion, ...input } = moneyPreferenceInputSchema.parse(raw);
    return this.access.run(ctx, async (tx) => {
      const key = { companyId: ctx.companyId, userId: ctx.userId };
      if (expectedVersion === 0) {
        if (await tx.userMoneyPreference.findUnique({ where: { companyId_userId: key } }))
          throw new DataError('SETTINGS_CONFLICT');
        await tx.userMoneyPreference.create({ data: { ...key, ...input } });
      } else {
        const r = await tx.userMoneyPreference.updateMany({
          where: { ...key, version: expectedVersion },
          data: { ...input, version: { increment: 1 } },
        });
        if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      }
      return this.view(tx, ctx);
    });
  }
  private configure<T>(p: Principal, action: (tx: Tx) => Promise<T>) {
    return this.auth.store.run(async (tx) => {
      await this.auth.require(tx, p, 'cash:configure');
      await tx.$executeRaw`SELECT set_config('caissepro.company_id',${p.companyId},true),set_config('caissepro.actor_id',${p.userId},true),set_config('caissepro.session_id',${p.sessionId},true)`;
      return action(tx);
    });
  }
  configureCurrency(p: Principal, raw: unknown) {
    const input = companyCurrencyInputSchema.parse(raw);
    return this.configure(p, async (tx) => {
      const key = { companyId: p.companyId, code: input.code };
      if (input.expectedVersion === 0) {
        if (await tx.companyCurrency.findUnique({ where: { companyId_code: key } }))
          throw new DataError('SETTINGS_CONFLICT');
        await tx.companyCurrency.create({ data: { ...key, active: input.active } });
      } else {
        const r = await tx.companyCurrency.updateMany({
          where: { ...key, version: input.expectedVersion },
          data: { active: input.active, version: { increment: 1 } },
        });
        if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      }
      if (input.active) {
        // Opening zero-balance accounts is configuration, never a ledger entry.
        // Provision all company cash registers; later access still requires both agency and cash grants.
        const cash = await tx.cashRegister.findMany({
          where: { companyId: p.companyId, active: true },
        });
        for (const c of cash)
          for (const kind of ['TREASURY', 'CLEARING'] as const) {
            const code = kind === 'TREASURY' ? `CAISSE-${c.id}` : `RECETTES-${c.id}`;
            const existing = await tx.treasuryAccount.findFirst({
              where: {
                companyId: p.companyId,
                agencyId: c.agencyId,
                currency: input.code,
                ...(kind === 'TREASURY' ? { cashRegisterId: c.id, kind } : { code, kind }),
              },
            });
            if (!existing)
              await tx.treasuryAccount.create({
                data: {
                  id: randomUUID(),
                  companyId: p.companyId,
                  agencyId: c.agencyId,
                  cashRegisterId: kind === 'TREASURY' ? c.id : null,
                  code,
                  currency: input.code,
                  kind,
                },
              });
          }
      }
      await this.audit(tx, p);
      return { ok: true };
    });
  }
  reporting(p: Principal, raw: unknown) {
    const input = reportingCurrencyInputSchema.parse(raw);
    return this.configure(p, async (tx) => {
      const r = await tx.companyMonetarySettings.updateMany({
        where: { companyId: p.companyId, version: input.expectedVersion },
        data: { reportingCurrency: input.currency, version: { increment: 1 } },
      });
      if (r.count !== 1) throw new DataError('SETTINGS_CONFLICT');
      await this.audit(tx, p);
      return { ok: true };
    });
  }
  private audit(tx: Tx, p: Principal) {
    return tx.auditEvent.create({
      data: {
        id: randomUUID(),
        companyId: p.companyId,
        actorId: p.userId,
        action: 'MONETARY_SETTINGS_CONFIGURED',
        targetType: 'COMPANY',
        targetId: p.companyId,
      },
    });
  }
}
