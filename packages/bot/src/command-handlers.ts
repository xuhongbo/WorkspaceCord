import { handleProject } from './command-handlers-modules/project-handlers.ts';
import { handleAgent } from './command-handlers-modules/agent-handlers.ts';
import { handleSubagent } from './command-handlers-modules/subagent-handlers.ts';
import { handleShell } from './command-handlers-modules/shell-handlers.ts';
import { setLogger } from './command-handlers-shared.ts';

export {
  setLogger,
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
};
