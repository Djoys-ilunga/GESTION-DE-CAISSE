import { Injectable } from '@nestjs/common';
import { BCC_OFFICIAL_PAGES, BccProviderError, type BccSourceConnector } from './bcc.provider';

// Reviewed on 2026-11-12: the published terms prohibit automated collection,
// systematic archiving and automated redistribution. This is not a network
// failure. A future authorized provider must have its own verified contract.
export const BCC_LEGAL_NOTICE = 'https://www.bcc.cd/mentions-legales';
export const BCC_AUTHORIZATION_REQUIRED = 'BCC_AUTHORIZATION_REQUIRED' as const;

@Injectable()
export class BccAuthorizationRequiredConnector implements BccSourceConnector {
  readonly descriptor = {
    sourceUrl: BCC_OFFICIAL_PAGES[0],
    contractVersion: 'UNVERIFIED',
    verified: false,
    blockedReason: BCC_AUTHORIZATION_REQUIRED,
  };
  async retrieve(): Promise<never> {
    throw new BccProviderError(BCC_AUTHORIZATION_REQUIRED);
  }
}
