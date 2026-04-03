import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.ts';
import eslintConfig from '../eslint.config.js';
import tsConfig from '../tsconfig.json' with { type: 'json' };
import tsupConfigFactory from '../tsup.config.ts';

describe('root project isolation config', () => {
  it('根 Vitest 排除 site 子项目测试', () => {
    expect(vitestConfig.test?.exclude ?? []).toEqual(expect.arrayContaining(['site/**']));
  });

  it('根 ESLint 忽略 site 子项目文件', () => {
    const ignoreEntries = eslintConfig
      .filter((entry) => typeof entry === 'object' && entry !== null && 'ignores' in entry)
      .flatMap((entry) => ((entry as { ignores?: string[] }).ignores ?? []));

    expect(ignoreEntries).toEqual(expect.arrayContaining(['site/**']));
  });

  it('根 TypeScript 配置显式排除 site 子项目', () => {
    expect(tsConfig.exclude ?? []).toEqual(expect.arrayContaining(['site', 'site/**']));
  });

  it('根构建入口仍然只指向根工程 CLI', () => {
    const config = tsupConfigFactory({ watch: false } as never);
    expect(config.entry).toEqual(['src/cli.ts']);
  });
});
