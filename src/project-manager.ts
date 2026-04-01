import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadRegistry,
  getProjectByName as getRegisteredProjectByName,
  getAllRegisteredProjects,
  getProjectByCategoryId as getRegisteredProjectByCategoryId,
  bindProjectCategory,
  setProjectHistoryChannel,
  setProjectControlChannel,
  updateProject,
} from './project-registry.ts';
import type { Project, Skill, McpServer } from './types.ts';

export async function loadProjects(): Promise<void> {
  await loadRegistry();
}

function toProject(projectName: string): Project | undefined {
  const project = getRegisteredProjectByName(projectName);
  if (!project) return undefined;
  return {
    categoryId: project.discordCategoryId ?? '',
    historyChannelId: project.historyChannelId,
    controlChannelId: project.controlChannelId,
    name: project.name,
    directory: project.path,
    personality: project.personality,
    skills: Object.entries(project.skills).map(([name, prompt]) => ({ name, prompt })),
    mcpServers: project.mcpServers,
    createdAt: project.createdAt,
  };
}

export function getProject(categoryId: string): Project | undefined {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return undefined;
  return {
    categoryId: project.discordCategoryId ?? categoryId,
    historyChannelId: project.historyChannelId,
    controlChannelId: project.controlChannelId,
    name: project.name,
    directory: project.path,
    personality: project.personality,
    skills: Object.entries(project.skills).map(([name, prompt]) => ({ name, prompt })),
    mcpServers: project.mcpServers,
    createdAt: project.createdAt,
  };
}

export function getProjectByName(name: string): Project | undefined {
  return toProject(name);
}

export function findProjectByCwd(cwd: string): Project | undefined {
  // 规范化路径
  const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase();

  for (const project of getAllRegisteredProjects()) {
    if (!project.discordCategoryId) continue;
    const projectPath = project.path.replace(/\\/g, '/').toLowerCase();

    // 检查 cwd 是否在项目目录下
    if (normalizedCwd === projectPath || normalizedCwd.startsWith(projectPath + '/')) {
      return {
        categoryId: project.discordCategoryId,
        historyChannelId: project.historyChannelId,
        controlChannelId: project.controlChannelId,
        name: project.name,
        directory: project.path,
        personality: project.personality,
        skills: Object.entries(project.skills).map(([name, prompt]) => ({ name, prompt })),
        mcpServers: project.mcpServers,
        createdAt: project.createdAt,
      };
    }
  }

  return undefined;
}

export function getAllProjects(): Record<string, Project> {
  const out: Record<string, Project> = {};
  for (const project of getAllRegisteredProjects()) {
    if (!project.discordCategoryId) continue;
    out[project.discordCategoryId] = {
      categoryId: project.discordCategoryId,
      historyChannelId: project.historyChannelId,
      controlChannelId: project.controlChannelId,
      name: project.name,
      directory: project.path,
      personality: project.personality,
      skills: Object.entries(project.skills).map(([name, prompt]) => ({ name, prompt })),
      mcpServers: project.mcpServers,
      createdAt: project.createdAt,
    };
  }
  return out;
}

export async function bindMountedProjectToCategory(
  projectName: string,
  categoryId: string,
  categoryName: string,
): Promise<Project> {
  const project = getRegisteredProjectByName(projectName);
  if (!project) throw new Error(`Mounted project not found: ${projectName}`);
  if (project.discordCategoryId && project.discordCategoryId !== categoryId) {
    throw new Error(`Project "${projectName}" is already bound to another Discord category`);
  }
  await bindProjectCategory(projectName, categoryId, categoryName);
  return getProject(categoryId)!;
}

export function setHistoryChannelId(categoryId: string, channelId: string): void {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return;
  void setProjectHistoryChannel(project.name, channelId);
}

export function setControlChannelId(categoryId: string, channelId: string): void {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return;
  void setProjectControlChannel(project.name, channelId);
}

export function getHistoryChannelId(categoryId: string): string | undefined {
  return getRegisteredProjectByCategoryId(categoryId)?.historyChannelId;
}

export function getControlChannelId(categoryId: string): string | undefined {
  return getRegisteredProjectByCategoryId(categoryId)?.controlChannelId;
}

export function setPersonality(categoryId: string, personality: string): void {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return;
  project.personality = personality;
  void updateProject(project);
}

export function getPersonality(categoryId: string): string | undefined {
  return getRegisteredProjectByCategoryId(categoryId)?.personality;
}

export function clearPersonality(categoryId: string): void {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return;
  delete project.personality;
  void updateProject(project);
}

export function addSkill(categoryId: string, name: string, prompt: string): void {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return;
  project.skills[name] = prompt;
  void updateProject(project);
}

export function removeSkill(categoryId: string, name: string): boolean {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project || !project.skills[name]) return false;
  delete project.skills[name];
  void updateProject(project);
  return true;
}

export function getSkills(categoryId: string): Skill[] {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return [];
  return Object.entries(project.skills).map(([name, prompt]) => ({ name, prompt }));
}

export function executeSkill(categoryId: string, name: string, input?: string): string | null {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return null;
  const template = project.skills[name];
  if (!template) return null;
  return input ? template.replace(/\{input\}/g, input) : template.replace(/\{input\}/g, '');
}

export async function addMcpServer(
  categoryId: string,
  serverName: string,
  command: string,
  args?: string[],
): Promise<void> {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return;
  const existing = project.mcpServers.findIndex((server) => server.name === serverName);
  const server: McpServer = {
    name: serverName,
    command,
    ...(args?.length ? { args } : {}),
  };
  if (existing >= 0) {
    project.mcpServers[existing] = server;
  } else {
    project.mcpServers.push(server);
  }
  await updateProject(project);
  await writeMcpJson(project.path, project.mcpServers);
}

export async function removeMcpServer(categoryId: string, serverName: string): Promise<boolean> {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return false;
  const index = project.mcpServers.findIndex((server) => server.name === serverName);
  if (index < 0) return false;
  project.mcpServers.splice(index, 1);
  await updateProject(project);
  await writeMcpJson(project.path, project.mcpServers);
  return true;
}

export function getMcpServers(categoryId: string): McpServer[] {
  return getRegisteredProjectByCategoryId(categoryId)?.mcpServers || [];
}

async function writeMcpJson(projectDir: string, servers: McpServer[]): Promise<void> {
  const mcpPath = join(projectDir, '.mcp.json');

  let mcpConfig: Record<string, unknown> = {};
  try {
    if (existsSync(mcpPath)) {
      const existing = await readFile(mcpPath, 'utf-8');
      mcpConfig = JSON.parse(existing);
    }
  } catch {
    // ignore malformed existing file
  }

  const mcpServers: Record<string, { command: string; args?: string[] }> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
    };
  }

  mcpConfig.mcpServers = mcpServers;
  await writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
}
