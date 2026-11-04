import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const N = 131072,
  r = 8,
  p = 1;
const dummySalt = Buffer.from('caissepro-dummy-salt-v1');
@Injectable()
export class PasswordService {
  private active = 0;
  private async derive(password: string, salt: Buffer) {
    if (this.active >= 2)
      throw new ServiceUnavailableException('Authentification temporairement indisponible.');
    this.active++;
    try {
      return await new Promise<Buffer>((resolve, reject) =>
        scrypt(password, salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) =>
          error ? reject(error) : resolve(key),
        ),
      );
    } finally {
      this.active--;
    }
  }
  async hash(password: string) {
    const salt = randomBytes(16),
      key = await this.derive(password, salt);
    try {
      return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
    } finally {
      key.fill(0);
    }
  }
  async verify(password: string, encoded: string | null) {
    const parts = encoded?.split('$');
    const valid =
      parts?.length === 6 &&
      parts[0] === 'scrypt' &&
      parts[1] === String(N) &&
      parts[2] === '8' &&
      parts[3] === '1' &&
      /^[A-Za-z0-9_-]{22}$/.test(parts[4] ?? '') &&
      /^[A-Za-z0-9_-]{86}$/.test(parts[5] ?? '');
    const key = await this.derive(
      password,
      valid ? Buffer.from(parts![4]!, 'base64url') : dummySalt,
    );
    const expected = valid ? Buffer.from(parts![5]!, 'base64url') : Buffer.alloc(64);
    try {
      return timingSafeEqual(key, expected) && Boolean(valid);
    } finally {
      key.fill(0);
      expected.fill(0);
    }
  }
}
