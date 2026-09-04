import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { buildApp, type App } from '../src/app.js';
import type { FetchImpl } from '../src/avatar.js';
import { loadConfig, type Config } from '../src/config.js';
import { CharacterStore } from '../src/store.js';

export const silentLogger = pino({ level: 'silent' });

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'maplescouter-cloud-'));
}

/** A preset shaped like a real maplescouter.com export (13 userStat sections). */
export function samplePreset(
  overrides: Record<string, unknown> = {},
  stat: Record<string, unknown> = {},
  hexa: Record<string, unknown> = { hexaStat: 2 },
): Record<string, unknown> {
  return {
    type: 'maplescouter-manual-preset',
    v: 1,
    savedAt: '2026-09-01T12:00:00.000Z',
    label: 'HTomer',
    data: {
      doping: {},
      linkSkill: {},
      special: {},
      stat: { myClass: '은월', level: '290', mainStatBase: '50000', ...stat },
      hexa,
      seedRing: {},
      entireStat: {},
      isGMS: true,
      isTMS: false,
      isJMS: false,
      isMSEA: false,
      power: {},
      huntSkill: {},
    },
    ...overrides,
  };
}

export interface TestApp {
  app: App;
  store: CharacterStore;
  dir: string;
  close(): Promise<void>;
}

export interface MakeAppOptions {
  /** Stub for the avatar route's upstream fetch. Tests that hit /v1/avatar must pass one (no network). */
  fetchImpl?: FetchImpl;
  /** Reuse an existing data directory (kept on close) instead of a fresh temp one. */
  dir?: string;
}

export async function makeApp(overrides: Partial<Config> = {}, opts: MakeAppOptions = {}): Promise<TestApp> {
  const ownDir = opts.dir === undefined;
  const dir = opts.dir ?? (await tempDir());
  const config: Config = { ...loadConfig({}), dataDir: dir, logLevel: 'silent', ...overrides };
  const store = await CharacterStore.open(dir, silentLogger, { maxCharacters: config.maxCharacters });
  const app = await buildApp({ config, store, logger: silentLogger, fetchImpl: opts.fetchImpl });
  await app.ready();
  return {
    app,
    store,
    dir,
    close: async () => {
      await app.close();
      if (ownDir) await rm(dir, { recursive: true, force: true });
    },
  };
}
