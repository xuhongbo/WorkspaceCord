import type { Client } from 'discord.js';
import { getAllSessions } from './thread-manager.ts';
import { getAllRegisteredProjects } from './project-registry.ts';
import { config } from './config.ts';

// ─── Types ────────────────────────────────────────────────────────────────

interface SystemMetrics {
  uptime: number;
  memoryUsage: number;
  pid: number;
}

interface SessionMetrics {
  total: number;
  generating: number;
  persistent: number;
  subagent: number;
  byProvider: Record<string, number>;
}

interface ProjectMetrics {
  totalProjects: number;
  projectSessions: Array<{ name: string; count: number }>;
}

interface ActivityMetrics {
  messageCount: number;
  totalCost: number;
  periodMs: number;
}

interface HealthIssue {
  severity: 'warning' | 'error';
  category: 'session' | 'memory' | 'watchdog';
  message: string;
  sessionId?: string;
}

interface HealthCheck {
  status: 'healthy' | 'warning' | 'error';
  issues: HealthIssue[];
}

interface HealthMetrics {
  timestamp: number;
  system: SystemMetrics;
  sessions: SessionMetrics;
  projects: ProjectMetrics;
  activity: ActivityMetrics;
  health: HealthCheck;
}

// ─── State ────────────────────────────────────────────────────────────────

let botStartTime = Date.now();
let healthMonitorTimer: ReturnType<typeof setInterval> | null = null;
let lastReportTime = Date.now();
let messageCountSinceLastReport = 0;
let costSinceLastReport = 0;

// ─── Activity Tracking ────────────────────────────────────────────────────

export function recordMessage(): void {
  messageCountSinceLastReport++;
}

export function recordCost(cost: number): void {
  costSinceLastReport += cost;
}

export function setBotStartTime(time: number): void {
  botStartTime = time;
}

// ─── Utility Functions ────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── Metrics Collection ───────────────────────────────────────────────────

function collectSystemMetrics(): SystemMetrics {
  try {
    return {
      uptime: Date.now() - botStartTime,
      memoryUsage: process.memoryUsage().heapUsed,
      pid: process.pid,
    };
  } catch (err) {
    console.error('[health-monitor] Failed to collect system metrics:', err);
    return {
      uptime: 0,
      memoryUsage: 0,
      pid: process.pid,
    };
  }
}

function collectSessionMetrics(): SessionMetrics {
  try {
    const sessions = getAllSessions();
    const byProvider: Record<string, number> = {};

    let generating = 0;
    let persistent = 0;
    let subagent = 0;

    for (const session of sessions) {
      if (session.isGenerating) generating++;
      if (session.type === 'persistent') persistent++;
      if (session.type === 'subagent') subagent++;

      const provider = session.provider;
      byProvider[provider] = (byProvider[provider] || 0) + 1;
    }

    return {
      total: sessions.length,
      generating,
      persistent,
      subagent,
      byProvider,
    };
  } catch (err) {
    console.error('[health-monitor] Failed to collect session metrics:', err);
    return {
      total: 0,
      generating: 0,
      persistent: 0,
      subagent: 0,
      byProvider: {},
    };
  }
}

function collectProjectMetrics(): ProjectMetrics {
  try {
    const projects = getAllRegisteredProjects();
    const sessions = getAllSessions();
    const sessionsByProject = new Map<string, number>();

    for (const session of sessions) {
      const count = sessionsByProject.get(session.projectName) || 0;
      sessionsByProject.set(session.projectName, count + 1);
    }

    const projectSessions = Array.from(sessionsByProject.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalProjects: projects.length,
      projectSessions,
    };
  } catch (err) {
    console.error('[health-monitor] Failed to collect project metrics:', err);
    return {
      totalProjects: 0,
      projectSessions: [],
    };
  }
}

function collectActivityMetrics(): ActivityMetrics {
  const now = Date.now();
  const periodMs = now - lastReportTime;

  return {
    messageCount: messageCountSinceLastReport,
    totalCost: costSinceLastReport,
    periodMs,
  };
}

// ─── Health Checks ────────────────────────────────────────────────────────

function performHealthChecks(): HealthCheck {
  const issues: HealthIssue[] = [];
  const now = Date.now();

  try {
    const sessions = getAllSessions();

    // Check for stuck sessions
    for (const session of sessions) {
      if (session.isGenerating) {
        const stuckTime = now - session.lastActivity;
        if (stuckTime > config.healthCheckStuckThresholdMs) {
          issues.push({
            severity: 'error',
            category: 'session',
            message: `Session ${session.id} stuck for ${formatDuration(stuckTime)}`,
            sessionId: session.id,
          });
        }
      } else {
        // Check for idle sessions
        const idleTime = now - session.lastActivity;
        if (idleTime > config.healthCheckIdleThresholdMs) {
          issues.push({
            severity: 'warning',
            category: 'session',
            message: `Session ${session.id} idle for ${formatDuration(idleTime)}`,
            sessionId: session.id,
          });
        }
      }
    }

    // Check memory usage
    const memoryUsage = process.memoryUsage().heapUsed;
    if (memoryUsage > 1024 * 1024 * 1024) {
      issues.push({
        severity: 'warning',
        category: 'memory',
        message: `High memory usage: ${formatBytes(memoryUsage)}`,
      });
    }

    // Check subagent count
    const subagentCount = sessions.filter((s) => s.type === 'subagent').length;
    if (subagentCount > 10) {
      issues.push({
        severity: 'warning',
        category: 'watchdog',
        message: `High subagent count: ${subagentCount}`,
      });
    }
  } catch (err) {
    console.error('[health-monitor] Failed to perform health checks:', err);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  const hasWarnings = issues.some((i) => i.severity === 'warning');

  return {
    status: hasErrors ? 'error' : hasWarnings ? 'warning' : 'healthy',
    issues,
  };
}

export function collectMetrics(): HealthMetrics {
  const system = collectSystemMetrics();
  const sessions = collectSessionMetrics();
  const projects = collectProjectMetrics();
  const activity = collectActivityMetrics();
  const health = performHealthChecks();

  return {
    timestamp: Date.now(),
    system,
    sessions,
    projects,
    activity,
    health,
  };
}

// ─── Report Formatting ────────────────────────────────────────────────────

export function formatStatusReport(metrics: HealthMetrics): string {
  const { system, sessions, projects, activity, health } = metrics;

  const healthIcon = health.status === 'healthy' ? '✅' : health.status === 'warning' ? '⚠️' : '❌';

  let report = '📊 **Bot Status Report**\n\n';

  report += '**System**\n';
  report += `• Uptime: ${formatDuration(system.uptime)}\n`;
  report += `• Memory: ${formatBytes(system.memoryUsage)}\n`;
  report += `• PID: ${system.pid}\n\n`;

  report += '**Sessions**\n';
  report += `• Total: ${sessions.total}`;
  if (sessions.generating > 0) {
    report += ` (${sessions.generating} generating)`;
  }
  report += '\n';
  report += `• Persistent: ${sessions.persistent} | Subagents: ${sessions.subagent}\n`;

  const providerStats = Object.entries(sessions.byProvider)
    .map(([name, count]) => `${name}: ${count}`)
    .join(' | ');
  if (providerStats) {
    report += `• ${providerStats}\n`;
  }
  report += '\n';

  report += '**Projects**\n';
  report += `• Mounted: ${projects.totalProjects} projects\n`;
  for (const { name, count } of projects.projectSessions.slice(0, 5)) {
    report += `• ${name}: ${count} session${count !== 1 ? 's' : ''}\n`;
  }
  report += '\n';

  const periodMin = Math.round(activity.periodMs / 60000);
  report += `**Activity (last ${periodMin}m)**\n`;
  report += `• Messages: ${activity.messageCount}\n`;
  report += `• Cost: $${activity.totalCost.toFixed(2)}\n\n`;

  report += '**Health**\n';
  if (health.issues.length === 0) {
    report += `${healthIcon} All systems operational\n`;
  } else {
    report += `${healthIcon} ${health.issues.length} issue(s) detected\n`;
    for (const issue of health.issues.slice(0, 5)) {
      const icon = issue.severity === 'error' ? '❌' : '⚠️';
      report += `${icon} ${issue.message}\n`;
    }
  }

  return report;
}

// ─── Monitor Control ──────────────────────────────────────────────────────

export function startHealthMonitor(client: Client, logFn: (msg: string) => void): void {
  if (!config.healthReportEnabled) return;

  const interval = config.healthReportIntervalMs;

  const runReport = async () => {
    try {
      const metrics = collectMetrics();
      const report = formatStatusReport(metrics);

      logFn(report);

      // Reset activity counters
      lastReportTime = Date.now();
      messageCountSinceLastReport = 0;
      costSinceLastReport = 0;
    } catch (err) {
      console.error('[health-monitor] Failed to send status report:', err);
    }
  };

  // Send first report immediately
  runReport().catch(() => {});

  // Schedule periodic reports
  healthMonitorTimer = setInterval(() => {
    runReport().catch(() => {});
  }, interval);

  console.log(`[health-monitor] Started (interval: ${formatDuration(interval)})`);
}

export function stopHealthMonitor(): void {
  if (healthMonitorTimer) {
    clearInterval(healthMonitorTimer);
    healthMonitorTimer = null;
    console.log('[health-monitor] Stopped');
  }
}
