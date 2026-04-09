import { Command } from 'commander';
import { checkCommand } from './cli/check.js';
import { onboardingCommand } from './cli/onboarding.js';
import { startCommand } from './cli/start.js';
import { engineCommand } from './cli/engine.js';
import { talkCommand } from './cli/talk.js';
import { statusCommand } from './cli/status.js';
import { cancelCommand } from './cli/cancel.js';
import { stopCommand } from './cli/stop.js';
import { restartCommand } from './cli/restart.js';
import { cleanCommand } from './cli/clean.js';
import { logCommand } from './cli/log.js';
import { updateCommand } from './cli/update.js';
import { registerTaskCommands } from './cli/task.js';

const program = new Command();

program
  .name('win-agent')
  .description('Multi-agent workflow engine')
  .version('0.1.0')
  .action(checkCommand);

program
  .command('onboard')
  .description('One-time project setup: configure, scan workspace, inject context into role files')
  .action(onboardingCommand);

program.command('start').description('Start the engine').action(startCommand);

program.command('talk').description('Open PM conversation in browser').action(talkCommand);

program
  .command('status')
  .description('Show engine status and iteration progress')
  .action(statusCommand);

program
  .command('cancel <iteration_id>')
  .description('Cancel an iteration')
  .action(cancelCommand);

program.command('stop').description('Stop the engine').action(stopCommand);

program
  .command('restart')
  .description('Stop the engine, restart it, and open PM conversation after 10s')
  .action(restartCommand);

program.command('log').description('Tail the engine log file').action(logCommand);

program
  .command('update')
  .description('Update role templates in workspace to the latest package version')
  .action(updateCommand);

program
  .command('clean')
  .description('Clean .win-agent and .opencode from current directory')
  .action(cleanCommand);

registerTaskCommands(program);

// Internal command — spawned by `start` as a background daemon
program.command('_engine <workspace>', { hidden: true }).action(engineCommand);

program.parse();
