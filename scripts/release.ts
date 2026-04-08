#!/usr/bin/env node
/**
 * Interactive release script for workspacecord
 *
 * Usage:
 *   pnpm release              # interactive mode
 *   pnpm release patch        # skip prompt, auto bump patch
 *   pnpm release minor        # skip prompt, auto bump minor
 *   pnpm release major        # skip prompt, auto bump major
 *   pnpm release 1.2.3        # explicit version
 *
 * Steps:
 *   1. Check working tree is clean
 *   2. Collect commits since last tag
 *   3. Generate release notes via `claude -p`
 *   4. Preview & confirm
 *   5. Bump version, commit, tag, push
 *   6. Create GitHub Release
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { confirm, select, text, intro, outro, isCancel } from '@clack/prompts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ── Helpers ────────────────────────────────────────────────────────────────

function run(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { cwd: opts?.cwd ?? root, encoding: 'utf-8' }).trim();
}

function getLatestTag(): string {
  try {
    return run('git describe --tags --abbrev=0');
  } catch {
    return '';
  }
}

function getCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf-8'));
  return pkg.version;
}

function bumpVersion(current: string, type: 'patch' | 'minor' | 'major' | string): string {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

function collectCommits(since: string): string {
  const format = '%h|%s|%an|%aI';
  return run(`git log ${since}..HEAD --pretty=format:"${format}" --no-merges`);
}

function claudeGenerate(prompt: string): string {
  const result = spawnSync('claude', ['-p', '--max-turns', '10'], {
    input: prompt,
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (result.status !== 0) {
    throw new Error(`claude -p exited with code ${result.status}`);
  }

  return result.stdout?.trim() ?? '';
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const explicitArg = args[0];

  intro('📦 workspacecord release');

  const currentVersion = getCurrentVersion();
  let newVersion: string;

  // Version selection
  if (explicitArg && ['patch', 'minor', 'major'].includes(explicitArg)) {
    newVersion = bumpVersion(currentVersion, explicitArg);
  } else if (explicitArg && /\d+\.\d+\.\d+/.test(explicitArg)) {
    newVersion = explicitArg;
  } else {
    const bumpType = await select({
      message: `Current version: ${currentVersion}. What type of release is this?`,
      options: [
        { value: 'patch', label: 'Patch', hint: `${bumpVersion(currentVersion, 'patch')} — bug fixes, small improvements` },
        { value: 'minor', label: 'Minor', hint: `${bumpVersion(currentVersion, 'minor')} — new features, backwards compatible` },
        { value: 'major', label: 'Major', hint: `${bumpVersion(currentVersion, 'major')} — breaking changes` },
        { value: 'custom', label: 'Custom', hint: 'Enter a specific version number' },
      ],
    });

    if (isCancel(bumpType)) {
      outro('Release cancelled.');
      process.exit(0);
    }

    if (bumpType === 'custom') {
      const customVersion = await text({
        message: 'Enter version number:',
        placeholder: currentVersion,
        validate: (value) => {
          if (!/^\d+\.\d+\.\d+$/.test(value)) {
            return 'Version must be in format X.Y.Z (e.g., 1.2.3)';
          }
          return undefined;
        },
      });

      if (isCancel(customVersion)) {
        outro('Release cancelled.');
        process.exit(0);
      }

      newVersion = customVersion;
    } else {
      newVersion = bumpVersion(currentVersion, bumpType);
    }
  }

  console.log(`\n  Target version: ${newVersion}\n`);

  // Step 1: Check working tree
  try {
    const status = run('git status --porcelain');
    if (status) {
      console.error('\n❌ Working tree is not clean. Commit or stash changes first.');
      process.exit(1);
    }
  } catch {
    console.error('\n❌ Not a git repository.');
    process.exit(1);
  }

  // Step 2: Collect commits
  const lastTag = getLatestTag();
  console.log(`📝 Collecting commits since ${lastTag || 'beginning'}...`);

  const commitLog = collectCommits(lastTag);
  const commitCount = commitLog ? commitLog.split('\n').length : 0;
  console.log(`  Found ${commitCount} commit(s)\n`);

  if (!commitLog) {
    const shouldContinue = await confirm({
      message: 'No new commits since last tag. Continue anyway?',
    });
    if (!shouldContinue) {
      outro('Release cancelled.');
      process.exit(0);
    }
  }

  // Step 3: Generate release notes via claude -p
  console.log('🤖 Generating release notes with Claude...\n');

  const prompt = buildReleaseNotesPrompt(commitLog, newVersion);
  let releaseNotes: string;
  try {
    releaseNotes = claudeGenerate(prompt);
  } catch (err) {
    console.error('\n❌ Failed to generate release notes via claude -p');
    console.error(err);
    process.exit(1);
  }

  if (!releaseNotes) {
    console.error('\n❌ Claude returned empty release notes.');
    process.exit(1);
  }

  // Strip any conversational preamble — keep from first '##' heading onward
  const headingMatch = releaseNotes.match(/^## /m);
  if (headingMatch) {
    releaseNotes = releaseNotes.slice(headingMatch.index);
  }

  // Strip separator lines that Claude sometimes adds
  releaseNotes = releaseNotes.replace(/^---+\n?/gm, '').trim();

  // Step 4: Preview
  console.log('═══════════════════════════════════════════');
  console.log('  Release Notes Preview');
  console.log('═══════════════════════════════════════════\n');
  console.log(releaseNotes);
  console.log('\n═══════════════════════════════════════════\n');

  const confirmed = await confirm({ message: 'Proceed with release?' });
  if (!confirmed) {
    outro('Release cancelled.');
    process.exit(0);
  }

  // Step 5: Execute release — bump both root and CLI package.json
  console.log('\n📝 Bumping version in package.json files...');

  const pkgPaths = [
    join(root, 'package.json'),
    join(root, 'packages/cli/package.json'),
  ];

  for (const pkgPath of pkgPaths) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  const tag = `v${newVersion}`;
  console.log(`📌 Committing & tagging ${tag}...`);
  run(`git add package.json packages/cli/package.json`);
  run(`git commit -m "chore: release ${tag}"`);
  run(`git tag ${tag}`);

  console.log('🚀 Pushing to remote...');
  try {
    run('git push');
    run('git push --tags');
  } catch {
    console.log('  Push rejected, rebasing with remote...');
    run('git pull --rebase origin main');
    run('git push');
    run('git push --tags');
  }

  console.log('📢 Creating GitHub Release...');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wsc-release-'));
  const notesFile = join(tmpDir, 'RELEASE_NOTES.md');
  writeFileSync(notesFile, releaseNotes + '\n');

  try {
    run(`gh release create ${tag} --title "Release ${tag}" --notes-file "${notesFile}"`);
  } catch {
    console.log('  Release already exists, updating notes...');
    run(`gh release edit ${tag} --notes-file "${notesFile}"`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  outro(`🎉 Release ${tag} complete!`);
}

function buildReleaseNotesPrompt(commits: string, version: string): string {
  return `You are a release manager for the open-source project "workspacecord" (version ${version}).

workspacecord is a globally-installed CLI tool that runs as a background daemon, managing AI coding agent sessions (Claude Code, OpenAI Codex) on the local machine through Discord. Each project gets a Discord Category, each session gets a Channel.

Below are the commits since the last release. Analyze them and write detailed, user-facing release notes.

Commits:
${commits}

Write the release notes in the following format (in English):

## What's Changed

Categorize changes into sections like:
- **Features** (new user-facing capabilities)
- **Bug Fixes** (resolved issues)
- **Improvements** (enhancements, refactors)
- **CI/CD & Tooling** (build, CI, scripts)
- **Documentation** (README, docs updates)

For each item, explain WHAT changed and WHY it matters to users, not just the commit message.

## Breaking Changes

List any breaking changes (or "None" if there are none).

## Migration Guide

If there are breaking changes, explain how to migrate. Otherwise say "No migration needed."

## Contributors

List all unique contributors from the commit authors.

Make the tone professional but warm. Be specific and detailed — avoid vague phrases like "various improvements" or "general cleanup."`;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
