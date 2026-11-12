import { Agent, request } from 'node:https';
import { createHash } from 'node:crypto';
import { BCC_OFFICIAL_PAGES, BccProviderError } from './bcc.provider';
// Transport for a future documented adapter. Nothing invokes it until the
// connector contract AND its legal/source approval have been verified.
export class BccOfficialHttpTransport {
  async download(
    url: string,
  ): Promise<{ body: Buffer; contentType: string; contentSha256: string; retrievedAt: Date }> {
    if (!BCC_OFFICIAL_PAGES.some((p) => p === url))
      throw new BccProviderError('BCC_SOURCE_NOT_ALLOWED');
    const agent = new Agent({ proxyEnv: process.env });
    try {
      return await new Promise((resolve, reject) => {
        const req = request(
          url,
          {
            agent,
            method: 'GET',
            headers: {
              'User-Agent': 'CaissePro/0.3',
              Accept: 'application/json,text/html,application/xml,text/csv,application/pdf',
            },
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(
                new BccProviderError(
                  res.statusCode === 429 ? 'BCC_RATE_LIMITED' : 'BCC_HTTP_UNAVAILABLE',
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (part: Buffer) => {
              size += part.length;
              if (size > 2_000_000) {
                req.destroy(new BccProviderError('BCC_RESPONSE_TOO_LARGE'));
                return;
              }
              chunks.push(part);
            });
            res.on('error', () => reject(new BccProviderError('BCC_NETWORK_UNAVAILABLE')));
            res.on('end', () => {
              const body = Buffer.concat(chunks);
              resolve({
                body,
                contentType: String(res.headers['content-type'] ?? ''),
                contentSha256: createHash('sha256').update(body).digest('hex'),
                retrievedAt: new Date(),
              });
            });
          },
        );
        const timer = setTimeout(() => req.destroy(new BccProviderError('BCC_TIMEOUT')), 10000);
        timer.unref();
        req.on('close', () => clearTimeout(timer));
        req.on('error', (e) =>
          reject(
            e instanceof BccProviderError ? e : new BccProviderError('BCC_NETWORK_UNAVAILABLE'),
          ),
        );
        req.end();
      });
    } finally {
      agent.destroy();
    }
  }
}
