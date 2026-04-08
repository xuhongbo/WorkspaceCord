import { basename, resolve } from 'node:path';
import {
  loadRegistry,
  registerProject,
  getAllRegisteredProjects,
  getProjectByPath,
  renameProject,
  removeProject,
  unbindProjectCategory,
} from '@workspacecord/engine/project-registry';

function parseNameArg(args: string[]): string | undefined {
  const index = args.indexOf('--name');
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return undefined;
}

function printHelp(): void {
  console.log(`
workspacecord project — manage mounted projects

Usage:
  workspacecord project init [--name <name>]
  workspacecord project list
  workspacecord project info
  workspacecord project rename <new-name>
  workspacecord project remove
`);
}

export async function handleProject(args: string[]): Promise<void> {
  await loadRegistry();
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'init': {
      const cwd = resolve(process.cwd());
      const name = parseNameArg(rest) || basename(cwd);
      const project = await registerProject(name, cwd);
      console.log(`✓ Project mounted: ${project.name}`);
      console.log(`  Path: ${project.path}`);
      if (project.discordCategoryId) {
        console.log(
          `  Bound Discord category: ${project.discordCategoryName ?? project.discordCategoryId}`,
        );
      } else {
        console.log('  Discord binding: pending (`/project setup` in Discord)');
      }
      return;
    }

    case 'list': {
      const projects = getAllRegisteredProjects();
      if (projects.length === 0) {
        console.log('No projects mounted. Run `workspacecord project init` in a repository.');
        return;
      }
      for (const project of projects) {
        const status = project.discordCategoryId
          ? `discord:${project.discordCategoryName ?? project.discordCategoryId}`
          : 'discord:pending';
        console.log(`${project.name}  ${project.path}  [${status}]`);
      }
      return;
    }

    case 'info': {
      const cwd = resolve(process.cwd());
      const project = getProjectByPath(cwd);
      if (!project) {
        console.log('Current directory is not mounted as a workspacecord project.');
        process.exit(1);
      }
      console.log(`name: ${project.name}`);
      console.log(`path: ${project.path}`);
      console.log(`discordCategoryId: ${project.discordCategoryId ?? '(pending)'}`);
      console.log(`discordCategoryName: ${project.discordCategoryName ?? '(pending)'}`);
      console.log(`historyChannelId: ${project.historyChannelId ?? '(pending)'}`);
      return;
    }

    case 'rename': {
      const newName = rest[0];
      if (!newName) {
        console.error('Usage: workspacecord project rename <new-name>');
        process.exit(1);
      }
      const cwd = resolve(process.cwd());
      const project = getProjectByPath(cwd);
      if (!project) {
        console.error('Current directory is not mounted.');
        process.exit(1);
      }
      await renameProject(project.name, newName);
      console.log(`✓ Project renamed: ${project.name} -> ${newName}`);
      return;
    }

    case 'remove': {
      const cwd = resolve(process.cwd());
      const project = getProjectByPath(cwd);
      if (!project) {
        console.error('Current directory is not mounted.');
        process.exit(1);
      }
      if (project.discordCategoryId) {
        await unbindProjectCategory(project.name);
      }
      await removeProject(project.name);
      console.log(`✓ Project removed: ${project.name}`);
      return;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;

    default:
      console.error(`Unknown project subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}
