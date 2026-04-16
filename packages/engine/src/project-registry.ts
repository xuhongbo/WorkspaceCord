import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Store, parseRegisteredProject, formatIssues } from '@workspacecord/core';
import type { McpServer, SchemaIssue } from '@workspacecord/core';

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  discordCategoryId?: string;
  discordCategoryName?: string;
  historyChannelId?: string;
  controlChannelId?: string;
  personality?: string;
  skills: Record<string, string>;
  mcpServers: McpServer[];
  createdAt: number;
  updatedAt: number;
}

const store = new Store<unknown>('projects.json');
let projects: RegisteredProject[] = [];

function normalizePath(path: string): string {
  return resolve(path);
}

async function saveRegistry(): Promise<void> {
  await (store as Store<RegisteredProject[]>).write(projects);
}

export async function loadRegistry(): Promise<void> {
  const raw = await store.read();
  if (raw === null || raw === undefined) {
    projects = [];
    return;
  }
  if (!Array.isArray(raw)) {
    console.warn(
      `[project-registry] projects.json is not an array (got ${typeof raw}) — starting with empty state`,
    );
    projects = [];
    return;
  }
  const issues: SchemaIssue[] = [];
  const parsed: RegisteredProject[] = [];
  for (let i = 0; i < raw.length; i++) {
    const project = parseRegisteredProject(raw[i], i, issues);
    if (project) parsed.push(project);
  }
  if (issues.length > 0) {
    console.warn(
      `[project-registry] Dropped ${raw.length - parsed.length}/${raw.length} invalid project record(s):\n${formatIssues(issues)}`,
    );
  }
  projects = parsed;
}

export function getProjectByName(name: string): RegisteredProject | undefined {
  return projects.find((project) => project.name === name);
}

export function getProjectByPath(path: string): RegisteredProject | undefined {
  const normalized = normalizePath(path);
  return projects.find((project) => normalizePath(project.path) === normalized);
}

export function getProjectByCategoryId(categoryId: string): RegisteredProject | undefined {
  return projects.find((project) => project.discordCategoryId === categoryId);
}

export function getAllRegisteredProjects(): RegisteredProject[] {
  return [...projects];
}

export async function registerProject(name: string, path: string): Promise<RegisteredProject> {
  const normalizedPath = normalizePath(path);
  const existingByPath = getProjectByPath(normalizedPath);
  if (existingByPath) {
    if (existingByPath.name !== name) {
      throw new Error(`Path already registered as project "${existingByPath.name}"`);
    }
    return existingByPath;
  }

  if (getProjectByName(name)) {
    throw new Error(`Project name already exists: ${name}`);
  }

  const now = Date.now();
  const project: RegisteredProject = {
    id: randomUUID(),
    name,
    path: normalizedPath,
    skills: {},
    mcpServers: [],
    createdAt: now,
    updatedAt: now,
  };

  projects.push(project);
  await saveRegistry();
  return project;
}

export async function renameProject(oldName: string, newName: string): Promise<void> {
  const project = getProjectByName(oldName);
  if (!project) throw new Error(`Project not found: ${oldName}`);
  if (oldName !== newName && getProjectByName(newName)) {
    throw new Error(`Project name already exists: ${newName}`);
  }
  project.name = newName;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function removeProject(name: string): Promise<void> {
  const before = projects.length;
  projects = projects.filter((project) => project.name !== name);
  if (projects.length === before) throw new Error(`Project not found: ${name}`);
  await saveRegistry();
}

export async function bindProjectCategory(
  name: string,
  categoryId: string,
  categoryName?: string,
): Promise<void> {
  const project = getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);

  const existing = getProjectByCategoryId(categoryId);
  if (existing && existing.name !== name) {
    throw new Error(`Discord category is already bound to project "${existing.name}"`);
  }

  project.discordCategoryId = categoryId;
  project.discordCategoryName = categoryName;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function unbindProjectCategory(name: string): Promise<void> {
  const project = getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);
  delete project.discordCategoryId;
  delete project.discordCategoryName;
  delete project.historyChannelId;
  delete project.controlChannelId;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function setProjectHistoryChannel(
  name: string,
  historyChannelId: string,
): Promise<void> {
  const project = getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);
  project.historyChannelId = historyChannelId;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function setProjectControlChannel(
  name: string,
  controlChannelId: string,
): Promise<void> {
  const project = getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);
  project.controlChannelId = controlChannelId;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function updateProject(project: RegisteredProject): Promise<void> {
  const index = projects.findIndex((item) => item.name === project.name);
  if (index < 0) throw new Error(`Project not found: ${project.name}`);
  projects[index] = { ...project, updatedAt: Date.now() };
  await saveRegistry();
}
