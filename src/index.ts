import { Command } from "commander";
import { checkCommand } from "./cli/check.js";
import { startCommand } from "./cli/start.js";
import { engineCommand } from "./cli/engine.js";
import { talkCommand } from "./cli/talk.js";
import { statusCommand } from "./cli/status.js";
import { cancelCommand } from "./cli/cancel.js";
import { stopCommand } from "./cli/stop.js";
import { cleanCommand } from "./cli/clean.js";
import { registerTaskCommands } from "./cli/task.js";

const program = new Command();

program
  .name("win-agent")
  .description("Multi-agent workflow engine")
  .version("0.1.0")
  .action(checkCommand);

program
  .command("start")
  .description("Start the engine")
  .action(startCommand);

program
  .command("talk")
  .description("Open PM conversation in browser")
  .action(talkCommand);

program
  .command("status")
  .description("Show engine status and workflow progress")
  .action(statusCommand);

program
  .command("cancel <workflow_id>")
  .description("Cancel a workflow instance")
  .action(cancelCommand);

program
  .command("stop")
  .description("Stop the engine")
  .action(stopCommand);

program
  .command("clean")
  .description("Clean .win-agent and .opencode from current directory")
  .action(cleanCommand);

registerTaskCommands(program);

// Internal command — spawned by `start` as a background daemon
program
  .command("_engine <workspace>")
  .description(false as any) // hidden from help
  .action(engineCommand);

program.parse();
