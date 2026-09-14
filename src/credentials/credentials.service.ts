import { Injectable } from '@nestjs/common';
import { CredentialsRepository } from '../db/repositories/credentials.repository';
import { ConfigService } from '../config/config.service';
import { decodeCredentialKey, decrypt, encrypt } from './crypto.util';

interface CredentialMeta {
  kind: string;
  createdAt: Date;
}

@Injectable()
export class CredentialsService {
  constructor(
    private readonly credentialsRepository: CredentialsRepository,
    private readonly config: ConfigService,
  ) {}

  /** Re-entering a token replaces the row rather than adding a second one. */
  async setCredential(
    projectId: string,
    kind: string,
    token: string,
  ): Promise<void> {
    const key = decodeCredentialKey(this.config.credentialKey);
    const { ciphertext, iv, authTag } = encrypt(token, key);
    await this.credentialsRepository.upsert({
      projectId,
      kind,
      ciphertext,
      iv,
      authTag,
    });
  }

  /**
   * The one place plaintext leaves this module — callers must not log or
   * persist the return value. Returns null rather than throwing when no
   * credential exists, since "not configured" is an expected, non-error
   * state for e.g. a git_url project that was never made private.
   */
  async getToken(projectId: string): Promise<string | null> {
    const row = await this.credentialsRepository.findByProjectId(projectId);
    if (!row) return null;
    const key = decodeCredentialKey(this.config.credentialKey);
    return decrypt(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
      key,
    );
  }

  /** Existence + metadata only — never returns the ciphertext, let alone the plaintext. */
  async getMeta(projectId: string): Promise<CredentialMeta | null> {
    const row = await this.credentialsRepository.findByProjectId(projectId);
    if (!row) return null;
    return { kind: row.kind, createdAt: row.createdAt };
  }

  async deleteCredential(projectId: string): Promise<boolean> {
    return this.credentialsRepository.deleteByProjectId(projectId);
  }
}
