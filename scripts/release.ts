#!/usr/bin/env node
/**
 * Release script for workspacecord
 *
 * Usage:
 *   node --experimental-strip-types scripts/release.ts          # auto-increment patch
 *   node --experimental-strip-types scripts/release.ts 1.1.0   # explicit version
 *
 * Steps:
 *   1. Collect commits since last tag
 *   2. Generate release notes via `claude -p` (stdin piping)
 *   3. Preview & confirm
 *   4. Bump version in package.json
 *   5. Commit, tag, push
 *   6. Create GitHub Release
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { confirm } from '@clack/prompts';

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
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  return pkg.version;
}

function bumpVersion(current: string): string {
  const [major, minor, patch] = current.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
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
  const explicitVersion = args[0];

  const currentVersion = getCurrentVersion();
  const newVersion = explicitVersion ?? bumpVersion(currentVersion);

  console.log(`\n📦 workspacecord release\n`);
  console.log(`  Current version: ${currentVersion}`);
  console.log(`  New version:     ${newVersion}`);

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
  console.log(`\n📝 Collecting commits since ${lastTag || 'beginning'}...`);

  const commitLog = collectCommits(lastTag);
  if (!commitLog) {
    console.log('  No new commits since last tag.');
    const shouldContinue = await confirm({
      message: 'No new commits found. Continue anyway?',
    });
    if (!shouldContinue) {
      console.log('  Aborted.');
      process.exit(0);
    }
  }

  // Step 3: Generate release notes via claude -p
  console.log('\n🤖 Generating release notes with Claude...\n');

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

  // Step 4: Preview
  console.log('═══════════════════════════════════════════');
  console.log('  Release Notes Preview');
  console.log('═══════════════════════════════════════════\n');
  console.log(releaseNotes);
  console.log('\n═══════════════════════════════════════════\n');

  const confirmed = await confirm({ message: 'Proceed with release?' });
  if (!confirmed) {
    console.log('  Aborted.');
    process.exit(0);
  }

  // Step 5: Bump version
  console.log('\n📝 Bumping version in package.json...');
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Step 6: Commit & tag
  console.log(`\n📌 Committing & tagging ${newVersion}...`);
  run(`git add package.json`);
  run(`git commit -m "chore: release ${newVersion}"`);
  run(`git tag ${newVersion}`);

  // Step 7: Push
  console.log('\n🚀 Pushing to remote...');
  run('git push');
  run('git push --tags');

  // Step 8: Create GitHub Release
  // Write notes to a temp file to avoid shell escaping issues
  console.log('\n📢 Creating GitHub Release...');
  const tmpDir = mkdtempSync(join(tmpdir(), 'wsc-release-'));
  const notesFile = join(tmpDir, 'RELEASE_NOTES.md');
  writeFileSync(notesFile, releaseNotes + '\n');

  try {
    run(`gh release create ${newVersion} --title "Release ${newVersion}" --notes-file "${notesFile}"`);
    console.log(`\n✅ Release ${newVersion} created!`);
  } catch (err) {
    console.error('\n⚠️  Failed to create GitHub Release via gh CLI.');
    console.error('  The tag has been pushed. You can create the release manually:');
    console.error(`  gh release create ${newVersion} --title "Release ${newVersion}" --notes-file "${notesFile}"`);
  } finally {
    // Clean up temp files
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  console.log(`\n🎉 Release ${newVersion} complete!\n`);
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
